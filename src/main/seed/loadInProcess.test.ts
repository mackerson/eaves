import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { seedDatabase, FIXED_NOW } from './loadInProcess';
import { demoDataset, minimalDataset } from './dataset';

const count = (db: import('better-sqlite3').Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe('seedDatabase', () => {
  it('produces a working database from the minimal scenario', () => {
    const { db, close } = seedDatabase('minimal');

    expect(count(db, 'agents')).toBe(minimalDataset.agents.length);
    expect(count(db, 'projects')).toBe(minimalDataset.projects.length);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    close();
  });

  it('writes every part of the demo scenario', () => {
    const { db, close } = seedDatabase('demo');

    const chatMessages = demoDataset.chats.reduce((n, c) => n + c.messages.length, 0);
    const roomMessages = demoDataset.channels.reduce((n, c) => n + c.messages.length, 0);

    expect(count(db, 'agents')).toBe(demoDataset.agents.length);
    expect(count(db, 'tasks')).toBe(demoDataset.projects[0].tasks.length);
    expect(count(db, 'notes')).toBe(demoDataset.projects[0].notes.length);
    expect(count(db, 'messages')).toBe(chatMessages + roomMessages);
    expect(count(db, 'workflows')).toBe(demoDataset.workflows.length);
    expect(count(db, 'routines')).toBe(demoDataset.routines.length);
    expect(count(db, 'memory_blocks')).toBe(demoDataset.memories.length);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    close();
  });

  /**
   * The reason the clock is a parameter. A fixture seeded from the wall clock
   * is a fixture that differs every run, and date-boundary bugs surface at
   * 23:59 on somebody else's machine.
   */
  it('is deterministic — two runs produce identical timestamps', () => {
    const a = seedDatabase('demo');
    const b = seedDatabase('demo');

    const stamps = (s: ReturnType<typeof seedDatabase>) =>
      (s.db.prepare('SELECT timestamp FROM messages ORDER BY timestamp').all() as Array<{ timestamp: number }>)
        .map(r => r.timestamp);

    expect(stamps(a)).toEqual(stamps(b));
    expect(stamps(a)[0]).toBeLessThan(FIXED_NOW);
    a.close();
    b.close();
  });

  it('accepts an injected clock', () => {
    const now = 1_700_000_000_000;
    const { db, close } = seedDatabase('minimal', { now });

    const newest = (db.prepare('SELECT MAX(timestamp) AS t FROM messages').get() as { t: number }).t;
    expect(newest).toBeLessThanOrEqual(now);
    expect(newest).toBeGreaterThan(now - 60 * 60_000);
    close();
  });

  it('hands back ids so a test can address what it seeded', () => {
    const { db, ids, close } = seedDatabase('demo');

    expect(Object.keys(ids.agents)).toHaveLength(demoDataset.agents.length);

    const wren = db.prepare('SELECT name FROM agents WHERE id = ?').get(ids.agents.wren) as { name: string };
    expect(wren.name).toBe('Wren');

    const room = db.prepare('SELECT name FROM channels WHERE id = ?').get(ids.channels['tidepool-room']) as { name: string };
    expect(room.name).toBe('tidepool');
    close();
  });

  it('marks the completed task and leaves the rest open', () => {
    const { db, close } = seedDatabase('demo');
    const done = (db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE completed = 1').get() as { c: number }).c;
    expect(done).toBe(demoDataset.projects[0].tasks.filter(t => t.completed).length);
    close();
  });

  // A 1:1 chat is a channels row with type='direct'; rooms are 'public'. If
  // that stops being true the seed is writing into the wrong substrate.
  it('stores chats and rooms in one table, distinguished by type', () => {
    const { db, close } = seedDatabase('demo');
    const byType = db.prepare('SELECT type, COUNT(*) AS c FROM channels GROUP BY type').all() as Array<{ type: string; c: number }>;
    const types = Object.fromEntries(byType.map(r => [r.type, r.c]));

    expect(types.direct).toBe(demoDataset.chats.length);
    expect(types.public).toBeGreaterThanOrEqual(demoDataset.channels.length);
    close();
  });

  it('makes seeded transcripts searchable', () => {
    const { db, close } = seedDatabase('demo');
    const hits = (db.prepare(
      'SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?',
    ).get('pangolins OR quantize OR SRAM') as { n: number }).n;
    expect(hits).toBeGreaterThan(0);
    close();
  });
});
