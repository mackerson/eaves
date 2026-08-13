import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../migrations';
import {
  getChangesSince,
  applyRemoteChanges,
  pruneChanges,
  resetApplyGuard,
  clearColumnCache,
  type SyncChange,
} from './changeLog';

const OUR_ID = 'device-aaaa';
const PEER_ID = 'device-bbbb';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, 0);
  return db;
}

function insertAgent(db: Database.Database, id: string, name: string): void {
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, model, temperature, color, created_at)
    VALUES (?, ?, '', 'anthropic', 'claude-sonnet-4', 0.7, '#fff', ?)
  `).run(id, name, Date.now());
}

// A 1:1 chat is a channels row with type='direct'; its messages live in
// `messages` (channel_id) and participants in `channel_participants`.
function insertChat(db: Database.Database, id: string): void {
  insertAgent(db, `agent-for-${id}`, 'Host');
  db.prepare(`INSERT INTO channels (id, name, type, agent_id, created_at) VALUES (?, 'Chat', 'direct', ?, ?)`)
    .run(id, `agent-for-${id}`, Date.now());
}

function oplog(db: Database.Database): Array<{ table_name: string; row_id: string; op: string }> {
  return db.prepare('SELECT table_name, row_id, op FROM sync_changes ORDER BY seq').all() as never;
}

describe('sync changeLog', () => {
  let db: Database.Database;

  beforeEach(() => {
    clearColumnCache();
    db = freshDb();
  });

  afterEach(() => db.close());

  describe('trigger capture', () => {
    it('records insert, update, and delete on synced tables', () => {
      insertAgent(db, 'a1', 'Aria');
      db.prepare(`UPDATE agents SET name = 'Aria 2' WHERE id = 'a1'`).run();
      db.prepare(`DELETE FROM agents WHERE id = 'a1'`).run();

      expect(oplog(db)).toEqual([
        { table_name: 'agents', row_id: 'a1', op: 'insert' },
        { table_name: 'agents', row_id: 'a1', op: 'update' },
        { table_name: 'agents', row_id: 'a1', op: 'delete' },
      ]);
    });

    it('encodes composite keys for participant tables', () => {
      insertChat(db, 'chat-1');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, joined_at)
        VALUES ('chat-1', 'a1', 'agent', ?)
      `).run(Date.now());

      const entries = oplog(db);
      expect(entries[entries.length - 1]).toEqual({
        table_name: 'channel_participants',
        row_id: 'chat-1|a1',
        op: 'insert',
      });
    });

    it('does not record changes to unsynced tables', () => {
      db.prepare(`
        INSERT INTO tool_session_states (context_id, enabled_tools, updated_at)
        VALUES ('ctx', '[]', ?)
      `).run(Date.now());
      expect(oplog(db)).toEqual([]);
    });

    it('records cascade deletes of child rows', () => {
      insertChat(db, 'chat-1');
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
        VALUES ('chatmsg-1', 'chat-1', 'u1', 'human', 'hi', ?)
      `).run(Date.now());
      db.prepare(`DELETE FROM channels WHERE id = 'chat-1'`).run();

      const deletes = oplog(db).filter(e => e.op === 'delete');
      expect(deletes).toContainEqual({ table_name: 'channels', row_id: 'chat-1', op: 'delete' });
      expect(deletes).toContainEqual({ table_name: 'messages', row_id: 'chatmsg-1', op: 'delete' });
    });
  });

  describe('getChangesSince', () => {
    it('collapses repeated edits to the latest entry with current row data', () => {
      insertAgent(db, 'a1', 'v1');
      db.prepare(`UPDATE agents SET name = 'v2' WHERE id = 'a1'`).run();
      db.prepare(`UPDATE agents SET name = 'v3' WHERE id = 'a1'`).run();

      const batch = getChangesSince(db, 0);
      expect(batch.changes).toHaveLength(1);
      expect(batch.changes[0].op).toBe('update');
      expect(batch.changes[0].row?.name).toBe('v3');
      expect(batch.upToSeq).toBe(3);
    });

    it('returns nothing below the watermark', () => {
      insertAgent(db, 'a1', 'Aria');
      const first = getChangesSince(db, 0);
      const second = getChangesSince(db, first.upToSeq);
      expect(second.changes).toEqual([]);
      expect(second.upToSeq).toBe(first.upToSeq);
    });

    it('ships deletes without row data', () => {
      insertAgent(db, 'a1', 'Aria');
      db.prepare(`DELETE FROM agents WHERE id = 'a1'`).run();

      const batch = getChangesSince(db, 0);
      expect(batch.changes).toHaveLength(1);
      expect(batch.changes[0].op).toBe('delete');
      expect(batch.changes[0].row).toBeUndefined();
    });
  });

  describe('applyRemoteChanges', () => {
    function makeChange(partial: Partial<SyncChange> & { rowId: string }): SyncChange {
      return {
        seq: 1,
        table: 'agents',
        op: 'insert',
        changedAt: Date.now(),
        ...partial,
      };
    }

    function remoteAgentRow(id: string, name: string): Record<string, unknown> {
      return {
        id, name, description: '', provider: 'anthropic', model: 'claude-sonnet-4',
        temperature: 0.7, color: '#fff', created_at: 1700000000000,
      };
    }

    it('inserts new rows and does not echo them into the local oplog', () => {
      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ rowId: 'a1', row: remoteAgentRow('a1', 'Remote') }),
      ]);

      expect(res.applied).toBe(1);
      expect(db.prepare(`SELECT name FROM agents WHERE id = 'a1'`).get()).toEqual({ name: 'Remote' });
      expect(oplog(db)).toEqual([]); // echo guard held
      // and the guard is released for subsequent local writes
      insertAgent(db, 'a2', 'Local');
      expect(oplog(db)).toHaveLength(1);
    });

    it('updates existing rows via upsert without cascading child deletes', () => {
      insertChat(db, 'chat-1');
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
        VALUES ('chatmsg-1', 'chat-1', 'u1', 'human', 'hi', ?)
      `).run(Date.now());

      const chatRow = db.prepare(`SELECT * FROM channels WHERE id = 'chat-1'`).get() as Record<string, unknown>;
      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({
          table: 'channels', rowId: 'chat-1', op: 'update',
          changedAt: Date.now() + 10_000,
          row: { ...chatRow, name: 'Renamed remotely' },
        }),
      ]);

      expect(res.applied).toBe(1);
      expect(db.prepare(`SELECT name FROM channels WHERE id = 'chat-1'`).get()).toEqual({ name: 'Renamed remotely' });
      // INSERT OR REPLACE would have cascade-deleted this child row
      expect(db.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 1 });
    });

    it('skips changes older than the local edit (LWW)', () => {
      insertAgent(db, 'a1', 'Local-newer');
      const localChangedAt = (db.prepare(
        `SELECT changed_at FROM sync_changes ORDER BY seq DESC LIMIT 1`,
      ).get() as { changed_at: number }).changed_at;

      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({
          rowId: 'a1',
          changedAt: localChangedAt - 60_000,
          row: remoteAgentRow('a1', 'Remote-older'),
        }),
      ]);

      expect(res.skippedOlder).toBe(1);
      expect(db.prepare(`SELECT name FROM agents WHERE id = 'a1'`).get()).toEqual({ name: 'Local-newer' });
    });

    it('applies changes newer than the local edit (LWW)', () => {
      insertAgent(db, 'a1', 'Local-older');
      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({
          rowId: 'a1',
          op: 'update',
          changedAt: Date.now() + 60_000,
          row: remoteAgentRow('a1', 'Remote-newer'),
        }),
      ]);

      expect(res.applied).toBe(1);
      expect(db.prepare(`SELECT name FROM agents WHERE id = 'a1'`).get()).toEqual({ name: 'Remote-newer' });
    });

    it('is idempotent on re-delivery of the same batch', () => {
      const change = makeChange({ rowId: 'a1', row: remoteAgentRow('a1', 'Remote') });
      applyRemoteChanges(db, OUR_ID, PEER_ID, [change]);
      const second = applyRemoteChanges(db, OUR_ID, PEER_ID, [change]);

      // Re-applied rather than skipped — same device, so not a conflict — and
      // the upsert makes the second pass a no-op either way.
      expect(second.applied + second.skippedOlder).toBe(1);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM agents`).get()).toEqual({ n: 1 });
    });

    it('applies a peer delete that shares a millisecond with its own insert', () => {
      // Two changes from one device are ordered by that device's oplog, not
      // concurrent — so the device-id tie-break must not arbitrate between
      // them. It used to, comparing PEER_ID against itself and answering
      // "loses", which stranded the row on every peer that had just applied
      // the insert in the same millisecond.
      const ts = Date.now();
      const insert = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ rowId: 'a1', changedAt: ts, row: remoteAgentRow('a1', 'Doomed') }),
      ]);
      expect(insert.applied).toBe(1);

      const del = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ seq: 2, rowId: 'a1', op: 'delete', changedAt: ts }),
      ]);

      expect(del).toEqual({ applied: 1, skippedOlder: 0, skippedInvalid: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM agents`).get()).toEqual({ n: 0 });
    });

    it('still lets a different device win a same-millisecond tie by device id', () => {
      // The tie-break is only defused for same-device pairs; genuine concurrent
      // edits from two devices must stay deterministic on both ends.
      const ts = Date.now();
      applyRemoteChanges(db, OUR_ID, 'device-zzzz', [
        makeChange({ rowId: 'a1', changedAt: ts, row: remoteAgentRow('a1', 'From-Z') }),
      ]);

      // 'device-bbbb' < 'device-zzzz' → the recorded version holds.
      const lower = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ seq: 2, rowId: 'a1', op: 'update', changedAt: ts, row: remoteAgentRow('a1', 'From-B') }),
      ]);

      expect(lower.skippedOlder).toBe(1);
      expect(db.prepare(`SELECT name FROM agents WHERE id = 'a1'`).get()).toEqual({ name: 'From-Z' });
    });

    it('does not let a same-device change with an older timestamp win', () => {
      const ts = Date.now();
      applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ rowId: 'a1', changedAt: ts, row: remoteAgentRow('a1', 'Current') }),
      ]);

      const stale = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ seq: 2, rowId: 'a1', op: 'delete', changedAt: ts - 1 }),
      ]);

      expect(stale.skippedOlder).toBe(1);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM agents`).get()).toEqual({ n: 1 });
    });

    it('applies deletes and tolerates deleting absent rows', () => {
      insertAgent(db, 'a1', 'Aria');
      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ rowId: 'a1', op: 'delete', changedAt: Date.now() + 10_000 }),
        makeChange({ rowId: 'never-existed', op: 'delete', changedAt: Date.now() + 10_000 }),
      ]);

      expect(res.applied).toBe(2);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM agents`).get()).toEqual({ n: 0 });
    });

    it('handles child-before-parent ordering within one batch (deferred FKs)', () => {
      const ts = Date.now();
      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        {
          seq: 1, table: 'messages', rowId: 'chatmsg-1', op: 'insert', changedAt: ts,
          row: { id: 'chatmsg-1', channel_id: 'chat-1', sender_id: 'u1', sender_type: 'human', content: 'hi', timestamp: ts },
        },
        {
          seq: 2, table: 'channels', rowId: 'chat-1', op: 'insert', changedAt: ts,
          row: { id: 'chat-1', name: 'Chat', type: 'direct', agent_id: 'a-host', created_at: ts },
        },
        {
          seq: 3, table: 'agents', rowId: 'a-host', op: 'insert', changedAt: ts,
          row: { id: 'a-host', name: 'Host', description: '', provider: 'anthropic', model: 'm', temperature: 0.7, color: '#fff', created_at: ts },
        },
      ]);
      expect(res.applied).toBe(3);
    });

    it('rejects unknown tables and rows missing their primary key', () => {
      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({ table: 'settings' as never, rowId: '1', row: { id: 1 } }),
        makeChange({ rowId: 'a9', row: { name: 'No id column' } }),
      ]);
      expect(res.skippedInvalid).toBe(2);
      expect(res.applied).toBe(0);
    });

    it('drops remote-only columns instead of failing (defense in depth)', () => {
      const res = applyRemoteChanges(db, OUR_ID, PEER_ID, [
        makeChange({
          rowId: 'a1',
          row: { ...remoteAgentRow('a1', 'Remote'), col_from_the_future: 'x' },
        }),
      ]);
      expect(res.applied).toBe(1);
      expect(db.prepare(`SELECT name FROM agents WHERE id = 'a1'`).get()).toEqual({ name: 'Remote' });
    });
  });

  describe('LWW round-trip symmetry', () => {
    it('both devices converge to the same winner regardless of apply order', () => {
      const dbA = freshDb();
      const dbB = freshDb();

      // Same row edited on both sides; B's edit is newer.
      const ts = Date.now();
      const rowA = { id: 'a1', name: 'From-A', description: '', provider: 'anthropic', model: 'm', temperature: 0.7, color: '#fff', created_at: ts };
      const rowB = { ...rowA, name: 'From-B' };

      const changeFromA: SyncChange = { seq: 1, table: 'agents', rowId: 'a1', op: 'insert', changedAt: ts, row: rowA };
      const changeFromB: SyncChange = { seq: 1, table: 'agents', rowId: 'a1', op: 'insert', changedAt: ts + 5_000, row: rowB };

      applyRemoteChanges(dbA, 'device-aaaa', 'device-bbbb', [changeFromB]);
      applyRemoteChanges(dbA, 'device-aaaa', 'device-cccc', [changeFromA]); // older arrives late
      applyRemoteChanges(dbB, 'device-bbbb', 'device-cccc', [changeFromA]);
      applyRemoteChanges(dbB, 'device-bbbb', 'device-aaaa', [changeFromB]);

      expect(dbA.prepare(`SELECT name FROM agents WHERE id = 'a1'`).get()).toEqual({ name: 'From-B' });
      expect(dbB.prepare(`SELECT name FROM agents WHERE id = 'a1'`).get()).toEqual({ name: 'From-B' });
      dbA.close();
      dbB.close();
    });
  });

  describe('pruneChanges', () => {
    it('keeps everything peers have not acked', () => {
      insertAgent(db, 'a1', 'Aria');
      insertAgent(db, 'a2', 'Bob');
      db.prepare(`
        INSERT INTO sync_peers (device_id, device_name, cert_fingerprint, paired_at, last_acked_seq)
        VALUES (?, 'Peer', 'fp', ?, 1)
      `).run(PEER_ID, Date.now());

      const pruned = pruneChanges(db);
      expect(pruned).toBe(1); // seq 1 acked, seq 2 retained
      expect(db.prepare('SELECT COUNT(*) AS n FROM sync_changes').get()).toEqual({ n: 1 });
    });

    it('uses the most conservative watermark across peers', () => {
      insertAgent(db, 'a1', 'Aria');
      insertAgent(db, 'a2', 'Bob');
      const stmt = db.prepare(`
        INSERT INTO sync_peers (device_id, device_name, cert_fingerprint, paired_at, last_acked_seq)
        VALUES (?, 'Peer', 'fp', ?, ?)
      `);
      stmt.run('peer-1', Date.now(), 2);
      stmt.run('peer-2', Date.now(), 0);

      expect(pruneChanges(db)).toBe(0); // peer-2 has acked nothing
    });

    it('falls back to a 30-day window with no paired peers', () => {
      insertAgent(db, 'a1', 'Aria');
      db.prepare('UPDATE sync_changes SET changed_at = ?').run(Date.now() - 31 * 24 * 60 * 60 * 1000);
      insertAgent(db, 'a2', 'Bob');

      expect(pruneChanges(db)).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sync_changes').get()).toEqual({ n: 1 });
    });
  });

  describe('guard maintenance', () => {
    it('resetApplyGuard clears a stuck applying flag', () => {
      db.prepare('UPDATE sync_meta SET applying = 1 WHERE id = 1').run();
      insertAgent(db, 'a1', 'Silent'); // triggers suppressed
      expect(oplog(db)).toEqual([]);

      resetApplyGuard(db);
      insertAgent(db, 'a2', 'Recorded');
      expect(oplog(db)).toHaveLength(1);
    });

    it('migration seeds a device identity', () => {
      const meta = db.prepare('SELECT device_id, enabled, applying FROM sync_meta WHERE id = 1').get() as
        { device_id: string; enabled: number; applying: number };
      expect(meta.device_id).toMatch(/^[0-9a-f]{32}$/);
      expect(meta.enabled).toBe(0);
      expect(meta.applying).toBe(0);
    });
  });
});
