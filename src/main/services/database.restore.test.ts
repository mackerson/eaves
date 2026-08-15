import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/eaves-db-restore-test', isPackaged: true } }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./migrations', () => ({ runMigrations: vi.fn() }));
vi.mock('./encryption', () => ({ encryptAPIKey: vi.fn() }));
vi.mock('sqlite-vec', () => ({ load: vi.fn() }));
vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('fs', () => ({ mkdirSync: vi.fn(), existsSync: () => true }));

const { fakeDb } = vi.hoisted(() => ({
  fakeDb: {
    pragma: vi.fn(() => 99),
    close: vi.fn(),
    // initializeSchema seeds a default user when the count is 0; report one so
    // it short-circuits and this test stays about the lock.
    prepare: vi.fn(() => ({ get: () => ({ count: 1 }), run: vi.fn(), all: () => [] })),
    exec: vi.fn(),
  },
}));
vi.mock('better-sqlite3', () => ({ default: function () { return fakeDb; } }));

/**
 * Closing the DB only nulls a module singleton, so the next getDatabase() would
 * transparently reopen the file a restore is in the middle of replacing —
 * re-running migrations and creating a fresh WAL against a handle that is then
 * overwritten underneath it. Every timer-driven service is live at that moment.
 */
describe('database restore lock', () => {
  let db: typeof import('./database');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    db = await import('./database');
  });

  it('opens normally before a restore starts', () => {
    expect(db.getDatabase()).toBe(fakeDb);
  });

  it('closes the handle and refuses to reopen once a restore begins', () => {
    db.getDatabase();
    db.beginDatabaseRestore();

    expect(fakeDb.close).toHaveBeenCalled();
    expect(() => db.getDatabase()).toThrow(/being restored/);
  });

  // One-way by design: a restore ends in app.relaunch(), and a failed one may
  // have left eaves.db half-written. Restarting is the only unlock.
  it('stays locked for the rest of the process lifetime', () => {
    db.beginDatabaseRestore();

    expect(() => db.getDatabase()).toThrow();
    expect(() => db.getDatabase()).toThrow();
  });
});
