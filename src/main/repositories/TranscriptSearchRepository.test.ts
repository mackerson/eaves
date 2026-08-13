import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptSearchRepository } from './TranscriptSearchRepository';
import { createTestDatabase, closeTestDatabase, seedAgent, seedChannel } from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

const AGENT = 'agent-1';
const OUTSIDER = 'agent-2';

let seq = 0;

function addMessage(
  db: Database.Database,
  channelId: string,
  content: string,
  overrides: Partial<{
    id: string; sender: string; senderType: string; displayName: string;
    timestamp: number; isDraft: number; status: string;
  }> = {},
): string {
  seq += 1;
  const id = overrides.id ?? `msg-${seq}`;
  db.prepare(`
    INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name,
                          content, timestamp, is_draft, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    channelId,
    overrides.sender ?? AGENT,
    overrides.senderType ?? 'agent',
    overrides.displayName ?? 'Aria',
    content,
    overrides.timestamp ?? 1_700_000_000_000 + seq * 1000,
    overrides.isDraft ?? 0,
    overrides.status ?? 'active',
  );
  return id;
}

function join(db: Database.Database, channelId: string, participantId: string): void {
  db.prepare(`
    INSERT INTO channel_participants (channel_id, participant_id, participant_type, joined_at)
    VALUES (?, ?, 'agent', ?)
  `).run(channelId, participantId, Date.now());
}

describe('TranscriptSearchRepository', () => {
  let db: Database.Database | null = null;
  let repo: TranscriptSearchRepository;

  beforeEach(async () => {
    seq = 0;
    db = createTestDatabase();
    seedAgent(db, AGENT);
    seedAgent(db, OUTSIDER, { name: 'Outsider' });
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repo = new TranscriptSearchRepository();
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
  });

  describe('search', () => {
    it('finds a message in a conversation the agent participates in', () => {
      seedChannel(db!, 'ch-1', { name: 'Engineering' });
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'we decided to use sqlite for the oplog');

      const hits = repo.search(AGENT, 'oplog');

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        channelId: 'ch-1',
        channelName: 'Engineering',
        sender: 'Aria',
        content: 'we decided to use sqlite for the oplog',
      });
    });

    it('indexes messages that predate the FTS migration', () => {
      // The v74 backfill is a 'rebuild', so history inserted before the index
      // existed has to be searchable — not just messages written after it.
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'ancient history about pelicans');
      db!.exec(`INSERT INTO messages_fts(messages_fts) VALUES('delete-all')`);
      expect(repo.search(AGENT, 'pelicans')).toHaveLength(0);

      db!.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
      expect(repo.search(AGENT, 'pelicans')).toHaveLength(1);
    });

    it('refuses conversations the agent is not a participant in', () => {
      seedChannel(db!, 'ch-private');
      join(db!, 'ch-private', OUTSIDER);
      addMessage(db!, 'ch-private', 'a secret about oplogs');

      expect(repo.search(AGENT, 'oplogs')).toEqual([]);
      expect(repo.search(OUTSIDER, 'oplogs')).toHaveLength(1);
    });

    it('searches direct chats and work sessions, not only rooms', () => {
      // Participation is the boundary. roomsOnly() keeps these out of the
      // channel LIST, which is a UI concern and must not narrow recall.
      for (const [id, type] of [['ch-direct', 'direct'], ['ch-work', 'work'], ['ch-room', 'public']]) {
        seedChannel(db!, id, { type });
        join(db!, id, AGENT);
        addMessage(db!, id, `discussion of quantized embeddings in ${type}`);
      }

      const types = repo.search(AGENT, 'quantized').map(h => h.channelType).sort();
      expect(types).toEqual(['direct', 'public', 'work']);
    });

    it('returns a window of messages around each hit', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'first');
      addMessage(db!, 'ch-1', 'second');
      addMessage(db!, 'ch-1', 'the marmoset decision');
      addMessage(db!, 'ch-1', 'fourth');
      addMessage(db!, 'ch-1', 'fifth');

      const [hit] = repo.search(AGENT, 'marmoset', { contextBefore: 2, contextAfter: 2 });

      expect(hit.before.map(m => m.content)).toEqual(['first', 'second']);
      expect(hit.after.map(m => m.content)).toEqual(['fourth', 'fifth']);
    });

    it('keeps the window inside the hit\'s own conversation', () => {
      seedChannel(db!, 'ch-1');
      seedChannel(db!, 'ch-2');
      join(db!, 'ch-1', AGENT);
      join(db!, 'ch-2', AGENT);
      addMessage(db!, 'ch-2', 'unrelated chatter');
      addMessage(db!, 'ch-1', 'the marmoset decision');
      addMessage(db!, 'ch-2', 'more unrelated chatter');

      const [hit] = repo.search(AGENT, 'marmoset');
      const contents = [...hit.before, ...hit.after].map(m => m.content);
      expect(contents).not.toContain('unrelated chatter');
      expect(contents).not.toContain('more unrelated chatter');
    });

    it('excludes drafts and regenerated branches', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'a draft about capybaras', { isDraft: 1 });
      addMessage(db!, 'ch-1', 'a regenerated take on capybaras', { status: 'regenerated' });
      addMessage(db!, 'ch-1', 'the real capybaras message');

      const hits = repo.search(AGENT, 'capybaras');
      expect(hits).toHaveLength(1);
      expect(hits[0].content).toBe('the real capybaras message');
    });

    it('scopes to one conversation when asked', () => {
      seedChannel(db!, 'ch-1');
      seedChannel(db!, 'ch-2');
      join(db!, 'ch-1', AGENT);
      join(db!, 'ch-2', AGENT);
      addMessage(db!, 'ch-1', 'osprey sighting');
      addMessage(db!, 'ch-2', 'osprey again');

      expect(repo.search(AGENT, 'osprey')).toHaveLength(2);
      const scoped = repo.search(AGENT, 'osprey', { channelId: 'ch-2' });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].channelId).toBe('ch-2');
    });

    it('does not let FTS5 operators in the query reach MATCH', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'ordinary text');

      // Bare FTS5 syntax would be a parse error or an unintended operator;
      // toFtsMatch quotes every token, so these are searched literally.
      for (const q of ['"', 'NEAR(a b', 'foo AND (bar', '*', '^']) {
        expect(() => repo.search(AGENT, q)).not.toThrow();
      }
    });

    it('returns nothing for a query with no searchable tokens', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'ordinary text');

      expect(repo.search(AGENT, '   ')).toEqual([]);
      expect(repo.search(AGENT, '!!!')).toEqual([]);
    });

    it('clamps limit and context sizes', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      for (let i = 0; i < 30; i++) addMessage(db!, 'ch-1', `heron number ${i}`);

      expect(repo.search(AGENT, 'heron', { limit: 999 })).toHaveLength(30);
      expect(repo.search(AGENT, 'heron', { limit: 3 })).toHaveLength(3);

      const [hit] = repo.search(AGENT, 'heron', { limit: 1, contextBefore: 999, contextAfter: 999 });
      expect(hit.before.length).toBeLessThanOrEqual(20);
      expect(hit.after.length).toBeLessThanOrEqual(20);
    });

    it('orders windows stably when messages share a timestamp', () => {
      // Bulk inserts and replicated batches routinely land in one millisecond.
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      const ts = 1_700_000_000_000;
      addMessage(db!, 'ch-1', 'alpha', { id: 'm-a', timestamp: ts });
      addMessage(db!, 'ch-1', 'bravo', { id: 'm-b', timestamp: ts });
      addMessage(db!, 'ch-1', 'the wolverine note', { id: 'm-c', timestamp: ts });
      addMessage(db!, 'ch-1', 'delta', { id: 'm-d', timestamp: ts });

      const runs = Array.from({ length: 5 }, () => {
        const [hit] = repo.search(AGENT, 'wolverine', { contextBefore: 5, contextAfter: 5 });
        return [...hit.before, ...hit.after].map(m => m.messageId).join(',');
      });

      expect(new Set(runs).size).toBe(1);
      expect(runs[0]).toBe('m-a,m-b,m-d');
    });

    it('tracks edits and deletes through the FTS triggers', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      const id = addMessage(db!, 'ch-1', 'the original wording');

      db!.prepare(`UPDATE messages SET content = 'the revised wording' WHERE id = ?`).run(id);
      expect(repo.search(AGENT, 'original')).toHaveLength(0);
      expect(repo.search(AGENT, 'revised')).toHaveLength(1);

      db!.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
      expect(repo.search(AGENT, 'revised')).toHaveLength(0);
    });

    it('indexes replicated writes, which the sync triggers deliberately skip', () => {
      // sync_meta.applying = 1 silences change capture so replicated rows don't
      // echo back to the peer. The FTS index must NOT honour that flag, or a
      // message that arrived from another device would be invisible to search.
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);

      const oplogSize = () =>
        (db!.prepare('SELECT COUNT(*) AS n FROM sync_changes').get() as { n: number }).n;
      const before = oplogSize();

      db!.prepare('UPDATE sync_meta SET applying = 1 WHERE id = 1').run();
      addMessage(db!, 'ch-1', 'arrived by replication from the laptop');
      db!.prepare('UPDATE sync_meta SET applying = 0 WHERE id = 1').run();

      expect(oplogSize()).toBe(before);
      expect(repo.search(AGENT, 'replication')).toHaveLength(1);
    });
  });

  describe('readAround', () => {
    it('returns a window centred on the target message', () => {
      seedChannel(db!, 'ch-1', { name: 'Engineering' });
      join(db!, 'ch-1', AGENT);
      for (let i = 0; i < 10; i++) addMessage(db!, 'ch-1', `line ${i}`, { id: `m-${i}` });

      const page = repo.readAround(AGENT, 'm-5', { before: 2, after: 2 });

      expect(page).toMatchObject({ channelId: 'ch-1', channelName: 'Engineering', target: 'm-5' });
      expect(page!.messages.map(m => m.messageId)).toEqual(['m-3', 'm-4', 'm-5', 'm-6', 'm-7']);
    });

    it('answers null identically for a missing message and one the agent cannot read', () => {
      // Two different reasons, one answer — a distinguishable response would let
      // an agent probe for conversations it is not in.
      seedChannel(db!, 'ch-private');
      join(db!, 'ch-private', OUTSIDER);
      addMessage(db!, 'ch-private', 'not for you', { id: 'm-secret' });

      expect(repo.readAround(AGENT, 'm-secret')).toBeNull();
      expect(repo.readAround(AGENT, 'no-such-message')).toBeNull();
    });

    it('clips the window at conversation boundaries', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'only message', { id: 'm-solo' });

      const page = repo.readAround(AGENT, 'm-solo', { before: 50, after: 50 });
      expect(page!.messages.map(m => m.messageId)).toEqual(['m-solo']);
    });

    it('omits drafts from the returned window', () => {
      seedChannel(db!, 'ch-1');
      join(db!, 'ch-1', AGENT);
      addMessage(db!, 'ch-1', 'before', { id: 'm-1' });
      addMessage(db!, 'ch-1', 'a draft', { id: 'm-draft', isDraft: 1 });
      addMessage(db!, 'ch-1', 'target', { id: 'm-2' });

      const page = repo.readAround(AGENT, 'm-2');
      expect(page!.messages.map(m => m.messageId)).toEqual(['m-1', 'm-2']);
    });
  });

  describe('participatingChannels', () => {
    it('lists the agent\'s conversations with message counts, busiest first', () => {
      seedChannel(db!, 'ch-quiet', { name: 'Quiet' });
      seedChannel(db!, 'ch-busy', { name: 'Busy' });
      seedChannel(db!, 'ch-theirs', { name: 'Theirs' });
      join(db!, 'ch-quiet', AGENT);
      join(db!, 'ch-busy', AGENT);
      join(db!, 'ch-theirs', OUTSIDER);

      addMessage(db!, 'ch-quiet', 'one');
      for (let i = 0; i < 3; i++) addMessage(db!, 'ch-busy', `msg ${i}`);
      addMessage(db!, 'ch-theirs', 'not mine');

      expect(repo.participatingChannels(AGENT)).toEqual([
        { id: 'ch-busy', name: 'Busy', type: 'public', messageCount: 3 },
        { id: 'ch-quiet', name: 'Quiet', type: 'public', messageCount: 1 },
      ]);
    });

    it('includes a joined conversation that has no messages yet', () => {
      seedChannel(db!, 'ch-empty', { name: 'Empty' });
      join(db!, 'ch-empty', AGENT);

      expect(repo.participatingChannels(AGENT)).toEqual([
        { id: 'ch-empty', name: 'Empty', type: 'public', messageCount: 0 },
      ]);
    });
  });
});
