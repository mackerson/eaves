import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Duplex, PassThrough } from 'stream';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../migrations';
import { clearColumnCache } from './changeLog';
import { addPeer, getPeer } from './peerStore';
import { SyncConnection } from './SyncConnection';
import { SyncSession } from './SyncSession';

const A_ID = 'device-aaaa';
const B_ID = 'device-bbbb';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, 0);
  return db;
}

function socketPair(): [Duplex, Duplex] {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new Duplex({
    write(chunk, _enc, cb) { aToB.write(chunk); cb(); },
    read() { /* pushed */ },
  });
  const b = new Duplex({
    write(chunk, _enc, cb) { bToA.write(chunk); cb(); },
    read() { /* pushed */ },
  });
  aToB.on('data', c => b.push(c));
  bToA.on('data', c => a.push(c));
  return [a, b];
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}

function insertAgent(db: Database.Database, id: string, name: string): void {
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, model, temperature, color, created_at)
    VALUES (?, ?, '', 'anthropic', 'claude-sonnet-4', 0.7, '#fff', ?)
  `).run(id, name, Date.now());
}

function agentNames(db: Database.Database): string[] {
  return (db.prepare('SELECT name FROM agents ORDER BY name').all() as Array<{ name: string }>)
    .map(r => r.name);
}

describe('SyncSession — two devices over in-memory sockets', () => {
  let dbA: Database.Database;
  let dbB: Database.Database;
  let sessionA: SyncSession;
  let sessionB: SyncSession;

  beforeEach(async () => {
    clearColumnCache();
    dbA = freshDb();
    dbB = freshDb();
    addPeer(dbA, { deviceId: B_ID, deviceName: 'B', certFingerprint: 'fp-b' });
    addPeer(dbB, { deviceId: A_ID, deviceName: 'A', certFingerprint: 'fp-a' });

    const [sockA, sockB] = socketPair();
    const connA = new SyncConnection(sockA, 'fp-b');
    const connB = new SyncConnection(sockB, 'fp-a');
    connA.send({ type: 'hello', deviceId: A_ID, deviceName: 'A', protocolVersion: 1, schemaVersion: 51 });
    connB.send({ type: 'hello', deviceId: B_ID, deviceName: 'B', protocolVersion: 1, schemaVersion: 51 });
    await until(() => !!connA.hello && !!connB.hello);

    sessionA = new SyncSession(dbA, A_ID, connA);
    sessionB = new SyncSession(dbB, B_ID, connB);
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
  });

  it('does the initial bidirectional sync on start', async () => {
    insertAgent(dbA, 'a1', 'Only-on-A');
    insertAgent(dbB, 'b1', 'Only-on-B');

    sessionA.start();
    sessionB.start();

    await until(() => agentNames(dbA).length === 2 && agentNames(dbB).length === 2);
    expect(agentNames(dbA)).toEqual(['Only-on-A', 'Only-on-B']);
    expect(agentNames(dbB)).toEqual(['Only-on-A', 'Only-on-B']);
  });

  it('propagates live changes after the initial sync', async () => {
    sessionA.start();
    sessionB.start();
    await new Promise(r => setTimeout(r, 20));

    insertAgent(dbA, 'a2', 'Late-arrival');
    sessionA.notifyLocalChanges();

    await until(() => agentNames(dbB).includes('Late-arrival'));
  });

  it('advances watermarks and prunes acked oplog entries', async () => {
    insertAgent(dbA, 'a1', 'Aria');
    sessionA.start();
    sessionB.start();

    await until(() => agentNames(dbB).includes('Aria'));
    await until(() => (getPeer(dbA, B_ID)?.lastAckedSeq ?? 0) > 0);

    // B recorded A's seq as applied; A pruned what B acked.
    expect(getPeer(dbB, A_ID)!.lastAppliedSeq).toBeGreaterThan(0);
    await until(() =>
      (dbA.prepare('SELECT COUNT(*) AS n FROM sync_changes').get() as { n: number }).n === 0,
    );
  });

  it('emits applied with the affected tables', async () => {
    const appliedTables: string[][] = [];
    sessionB.on('applied', (tables: string[]) => appliedTables.push(tables));

    insertAgent(dbA, 'a1', 'Aria');
    sessionA.start();
    sessionB.start();

    await until(() => appliedTables.length > 0);
    expect(appliedTables[0]).toEqual(['agents']);
  });

  it('replicated rows do not echo back (B does not re-offer A its own data)', async () => {
    insertAgent(dbA, 'a1', 'Aria');
    sessionA.start();
    sessionB.start();
    await until(() => agentNames(dbB).includes('Aria'));

    // B's oplog must not contain the applied row.
    const bOplog = dbB.prepare('SELECT COUNT(*) AS n FROM sync_changes').get() as { n: number };
    expect(bOplog.n).toBe(0);
  });

  it('concurrent edits to the same row converge via LWW on both sides', async () => {
    // Same agent id exists on both with different names — A's edit is older.
    const now = Date.now();
    insertAgent(dbA, 'shared', 'From-A');
    insertAgent(dbB, 'shared', 'From-B');
    // Force a deterministic winner: bump B's oplog timestamp into the future.
    dbB.prepare('UPDATE sync_changes SET changed_at = ?').run(now + 60_000);
    dbA.prepare('UPDATE sync_changes SET changed_at = ?').run(now - 60_000);

    sessionA.start();
    sessionB.start();

    await until(() =>
      agentNames(dbA).includes('From-B') && agentNames(dbB).includes('From-B'),
    );
    expect(agentNames(dbA)).toEqual(['From-B']);
    expect(agentNames(dbB)).toEqual(['From-B']);
  });

  it('deletes replicate', async () => {
    insertAgent(dbA, 'a1', 'Doomed');
    sessionA.start();
    sessionB.start();
    await until(() => agentNames(dbB).includes('Doomed'));

    dbA.prepare(`DELETE FROM agents WHERE id = 'a1'`).run();
    sessionA.notifyLocalChanges();

    await until(() => agentNames(dbB).length === 0);
  });

  it('a full conversation replicates: agent, chat, participants, messages', async () => {
    // A 1:1 chat is a channels row (type='direct') with its messages in
    // `messages` and participants in `channel_participants` — direct channels
    // replicate through those triggers like every other channel.
    insertAgent(dbA, 'agent-1', 'Aria');
    dbA.prepare(`INSERT INTO channels (id, name, type, agent_id, created_at) VALUES ('chat-1', 'Test chat', 'direct', 'agent-1', ?)`)
      .run(Date.now());
    dbA.prepare(`
      INSERT INTO channel_participants (channel_id, participant_id, participant_type, joined_at)
      VALUES ('chat-1', 'agent-1', 'agent', ?)
    `).run(Date.now());
    dbA.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
      VALUES ('chatmsg-1', 'chat-1', 'agent-1', 'agent', 'Hello from A', ?)
    `).run(Date.now());

    sessionA.start();
    sessionB.start();

    await until(() =>
      (dbB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE channel_id = 'chat-1'`).get() as { n: number }).n === 1,
    );
    expect(dbB.prepare(`SELECT content FROM messages WHERE id = 'chatmsg-1'`).get())
      .toEqual({ content: 'Hello from A' });
    expect(dbB.prepare(`SELECT COUNT(*) AS n FROM channel_participants`).get()).toEqual({ n: 1 });
  });
});
