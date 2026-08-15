import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

vi.mock('./logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// electron is imported by the service for the default dataDir branch; we
// always pass an explicit dataDir so app.getPath is never called, but the
// import itself must resolve.
vi.mock('electron', () => ({
  app: { getPath: () => '/should-not-be-used' },
}));

// The service falls back to these singletons when no DI is provided. We do
// always pass DI in tests so these are never called; mock them to be safe so
// the real database module doesn't try to open the user's actual DB.
vi.mock('./database', () => ({
  getDatabase: vi.fn(),
  beginDatabaseRestore: vi.fn(),
}));

import { BackupService } from './BackupService';

interface Env {
  dataDir: string;
  dbPath: string;
  db: Database.Database;
  service: BackupService;
}

// Stand-in for the old synthetic `marker` table — a real v52 table with no FK
// dependencies, used purely to prove data survives backup/restore. `id` is a
// TEXT primary key (like every other v52 table), so ordering assertions below
// use `rowid` (insertion order) rather than `id`.
function insertProject(db: Database.Database, name: string): void {
  db.prepare(
    'INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), name, '', Date.now());
}

function buildTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db, 0);
  insertProject(db, 'initial');
  return db;
}

function setupEnv(retention?: number): Env {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-backup-test-'));
  const dbPath = path.join(dataDir, 'eaves.db');
  const db = buildTestDb(dbPath);

  const service = new BackupService({
    dataDir,
    retention,
    getDb: () => db,
    beginRestore: () => db.close(),
  });

  return { dataDir, dbPath, db, service };
}

function teardownEnv(env: Env): void {
  try { env.db.close(); } catch { /* already closed */ }
  fs.rmSync(env.dataDir, { recursive: true, force: true });
}

describe('BackupService', () => {
  let env: Env;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.service.stop();
    teardownEnv(env);
  });

  describe('createSnapshot', () => {
    it('writes a snapshot file with the canonical name', async () => {
      const snap = await env.service.createSnapshot('manual');

      expect(snap.filename).toMatch(/^eaves-\d{8}T\d{9}Z-manual\.db$/);
      expect(snap.reason).toBe('manual');
      expect(fs.existsSync(snap.path)).toBe(true);
      expect(snap.sizeBytes).toBeGreaterThan(0);
    });

    it('captures committed state — restored DB matches source content', async () => {
      insertProject(env.db, 'checkpoint');
      const snap = await env.service.createSnapshot('manual');

      const restored = new Database(snap.path);
      const rows = restored.prepare('SELECT name FROM projects ORDER BY rowid').all() as Array<{ name: string }>;
      restored.close();

      expect(rows.map(r => r.name)).toEqual(['initial', 'checkpoint']);
    });

    it('creates the backups directory if missing', async () => {
      const backupsDir = path.join(env.dataDir, 'backups');
      expect(fs.existsSync(backupsDir)).toBe(false);
      await env.service.createSnapshot('manual');
      expect(fs.existsSync(backupsDir)).toBe(true);
    });
  });

  describe('listSnapshots', () => {
    it('returns empty when no snapshots exist', () => {
      expect(env.service.listSnapshots()).toEqual([]);
    });

    it('returns snapshots newest-first', async () => {
      const first = await env.service.createSnapshot('startup');
      // Bump mtimes so ordering is deterministic regardless of filesystem
      // resolution — listSnapshots sorts on stat.mtimeMs.
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(first.path, past, past);

      const second = await env.service.createSnapshot('manual');

      const listed = env.service.listSnapshots();
      expect(listed.map(s => s.filename)).toEqual([second.filename, first.filename]);
    });

    it('ignores files that do not match the canonical pattern', async () => {
      await env.service.createSnapshot('manual');
      fs.writeFileSync(path.join(env.dataDir, 'backups', 'stray.txt'), 'hello');
      fs.writeFileSync(path.join(env.dataDir, 'backups', 'eaves-broken.db'), 'invalid');

      const listed = env.service.listSnapshots();
      expect(listed).toHaveLength(1);
      expect(listed[0].filename).toMatch(/-manual\.db$/);
    });
  });

  describe('retention', () => {
    it('prunes oldest snapshots past the retention limit', async () => {
      env = setupEnv(3);

      // Create 5 snapshots, backdating mtimes after each so ordering is stable
      // regardless of how fast the loop runs vs filesystem timestamp granularity.
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const snap = await env.service.createSnapshot('manual');
        const t = new Date(Date.now() - (5 - i) * 60_000);
        fs.utimesSync(snap.path, t, t);
        created.push(snap.path);
      }

      // Trigger one more prune pass with the backdates in place.
      const final = await env.service.createSnapshot('manual');
      fs.utimesSync(final.path, new Date(), new Date());

      const remaining = env.service.listSnapshots();
      expect(remaining).toHaveLength(3);
      expect(fs.existsSync(created[0])).toBe(false);
      expect(fs.existsSync(created[1])).toBe(false);
    });
  });

  describe('deleteSnapshot', () => {
    it('removes a real snapshot file', async () => {
      const snap = await env.service.createSnapshot('manual');
      env.service.deleteSnapshot(snap.filename);
      expect(fs.existsSync(snap.path)).toBe(false);
    });

    it('rejects names that do not match the canonical pattern', () => {
      expect(() => env.service.deleteSnapshot('../../etc/passwd')).toThrow(/non-snapshot/);
      expect(() => env.service.deleteSnapshot('arbitrary.db')).toThrow(/non-snapshot/);
      expect(() => env.service.deleteSnapshot('eaves-20260514T120000Z-evil.db')).toThrow(/non-snapshot/);
    });

    it('throws when the snapshot file is missing', () => {
      expect(() => env.service.deleteSnapshot('eaves-20260514T120000000Z-manual.db'))
        .toThrow(/not found/);
    });
  });

  describe('restoreFromSnapshot', () => {
    it('replaces the live DB with the snapshot content, takes a pre-restore snapshot', async () => {
      const checkpoint = await env.service.createSnapshot('manual');

      // Mutate the live DB so the snapshot now differs from disk.
      insertProject(env.db, 'mutated');
      expect(
        (env.db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c
      ).toBe(2);

      await env.service.restoreFromSnapshot(checkpoint.filename);

      const reopened = new Database(env.dbPath);
      const rows = reopened.prepare('SELECT name FROM projects ORDER BY rowid').all() as Array<{ name: string }>;
      reopened.close();
      expect(rows.map(r => r.name)).toEqual(['initial']);

      const preRestore = env.service.listSnapshots().find(s => s.reason === 'pre-restore');
      expect(preRestore).toBeDefined();
    });

    it('removes WAL/SHM sidecars on restore', async () => {
      const checkpoint = await env.service.createSnapshot('manual');

      const walPath = env.dbPath + '-wal';
      const shmPath = env.dbPath + '-shm';
      fs.writeFileSync(walPath, 'stale-wal');
      fs.writeFileSync(shmPath, 'stale-shm');

      await env.service.restoreFromSnapshot(checkpoint.filename);

      expect(fs.existsSync(walPath)).toBe(false);
      expect(fs.existsSync(shmPath)).toBe(false);
    });

    it('rejects non-canonical filenames', async () => {
      await expect(env.service.restoreFromSnapshot('../eaves.db'))
        .rejects.toThrow(/non-snapshot/);
    });

    it('throws when the snapshot is missing', async () => {
      await expect(env.service.restoreFromSnapshot('eaves-20260514T120000000Z-manual.db'))
        .rejects.toThrow(/not found/);
    });
  });

  describe('start/stop', () => {
    it('skips the startup snapshot when a recent one already exists', async () => {
      await env.service.createSnapshot('startup');

      await env.service.start();
      env.service.stop();

      const snapshots = env.service.listSnapshots();
      expect(snapshots).toHaveLength(1);
    });

    it('takes a startup snapshot when none exist', async () => {
      expect(env.service.listSnapshots()).toHaveLength(0);
      await env.service.start();
      env.service.stop();

      const snapshots = env.service.listSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].reason).toBe('startup');
    });
  });
});
