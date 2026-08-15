/**
 * Tests for the Enclave -> Eaves profile move.
 *
 * This is the one piece of the rename that can destroy data, so the cases that
 * matter are the ones where it must *not* run, and the WAL sidecars that must
 * travel with the database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const getPathMock = vi.fn();
vi.mock('electron', () => ({
  app: { getPath: (...args: unknown[]) => getPathMock(...args) },
}));

import { migrateLegacyProfile } from './profileMigration';

describe('migrateLegacyProfile', () => {
  let root: string;
  let legacy: string;
  let current: string;

  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };

  /** A legacy profile with a database, its WAL sidecars, and some app state. */
  const seedLegacyProfile = () => {
    write(path.join(legacy, 'enclave-data', 'enclave.db'), 'main');
    write(path.join(legacy, 'enclave-data', 'enclave.db-wal'), 'uncheckpointed');
    write(path.join(legacy, 'enclave-data', 'enclave.db-shm'), 'shm');
    write(path.join(legacy, 'enclave-data', 'enclave-attachments', 'a.png'), 'image');
    write(path.join(legacy, 'plugins', 'p', 'plugin.json'), '{}');
    write(path.join(legacy, 'Local Storage', 'leveldb', '000003.log'), 'trusted');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-profile-'));
    legacy = path.join(root, 'enclave');
    current = path.join(root, 'eaves');
    getPathMock.mockReturnValue(current);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('moves the database and both WAL sidecars under the new name', () => {
    seedLegacyProfile();

    expect(migrateLegacyProfile()).toContain(current);

    const dataDir = path.join(current, 'eaves-data');
    expect(fs.readFileSync(path.join(dataDir, 'eaves.db'), 'utf8')).toBe('main');
    // The WAL is the whole point: losing it discards every transaction since
    // the last checkpoint.
    expect(fs.readFileSync(path.join(dataDir, 'eaves.db-wal'), 'utf8')).toBe('uncheckpointed');
    expect(fs.readFileSync(path.join(dataDir, 'eaves.db-shm'), 'utf8')).toBe('shm');
    expect(fs.existsSync(path.join(dataDir, 'enclave.db'))).toBe(false);
  });

  it('carries the rest of the profile across, including Chromium state', () => {
    seedLegacyProfile();

    migrateLegacyProfile();

    expect(fs.existsSync(path.join(current, 'plugins', 'p', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(current, 'Local Storage', 'leveldb', '000003.log'))).toBe(true);
    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves-attachments', 'a.png'), 'utf8')).toBe('image');
  });

  it('does nothing when there is no legacy profile', () => {
    expect(migrateLegacyProfile()).toBeNull();
    expect(fs.existsSync(current)).toBe(false);
  });

  it('never imports a legacy database over a live one', () => {
    seedLegacyProfile();
    write(path.join(current, 'eaves-data', 'eaves.db'), 'current');

    expect(migrateLegacyProfile()).toBeNull();

    // renameSync replaces its destination silently, so importing here would
    // destroy the profile this build has actually been writing to.
    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db'), 'utf8')).toBe('current');
    // The legacy profile is left exactly where it was, not half-consumed.
    expect(fs.existsSync(path.join(legacy, 'enclave-data', 'enclave.db'))).toBe(true);
  });

  it('still adopts orphaned sidecars sitting beside a live database', () => {
    // Interrupted after the main file was renamed: the -wal is this database's,
    // not a competing profile's, so it must be completed rather than ignored.
    write(path.join(current, 'eaves-data', 'eaves.db'), 'current');
    write(path.join(current, 'eaves-data', 'enclave.db-wal'), 'uncheckpointed');

    expect(migrateLegacyProfile()).toBeNull();

    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db-wal'), 'utf8')).toBe('uncheckpointed');
    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db'), 'utf8')).toBe('current');
  });

  it('merges into a userData directory Chromium already created', () => {
    seedLegacyProfile();
    // Chromium touches userData before our code runs on some platforms; the
    // destination existing must not be read as "already migrated".
    write(path.join(current, 'Preferences'), 'chromium');

    expect(migrateLegacyProfile()).toContain(current);

    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db'), 'utf8')).toBe('main');
    // An entry already at the destination was written by this build and wins.
    expect(fs.readFileSync(path.join(current, 'Preferences'), 'utf8')).toBe('chromium');
    expect(fs.existsSync(path.join(current, 'plugins', 'p', 'plugin.json'))).toBe(true);
  });

  it('merges into directories the destination already has', () => {
    seedLegacyProfile();
    write(path.join(legacy, 'logs', 'eaves-2026-01-01.log'), 'history');
    // Electron creates these before the migration runs, so skipping a
    // top-level entry that already exists stranded everything inside it.
    write(path.join(current, 'logs', 'eaves-2026-08-15.log'), 'today');

    migrateLegacyProfile();

    expect(fs.readFileSync(path.join(current, 'logs', 'eaves-2026-01-01.log'), 'utf8')).toBe('history');
    expect(fs.readFileSync(path.join(current, 'logs', 'eaves-2026-08-15.log'), 'utf8')).toBe('today');
  });

  it('does not follow a symlink when merging', () => {
    seedLegacyProfile();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(current, { recursive: true });
    // The real profile carries SingletonLock and friends. Recursing through one
    // would merge into whatever it points at, outside the profile entirely.
    fs.symlinkSync(outside, path.join(legacy, 'SingletonLock'));
    fs.symlinkSync(outside, path.join(current, 'SingletonLock'));

    migrateLegacyProfile();

    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('is idempotent — a second run is a no-op', () => {
    seedLegacyProfile();

    migrateLegacyProfile();
    expect(migrateLegacyProfile()).toBeNull();

    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db'), 'utf8')).toBe('main');
  });

  it('rekeys plugin config, which lives outside the database', () => {
    seedLegacyProfile();
    write(path.join(legacy, 'plugin-configs.json'), JSON.stringify({
      'com.enclave.openmemory': { apiKey: 'secret' },
      'org.example.thing': { setting: 1 },
    }));

    migrateLegacyProfile();

    const config = JSON.parse(fs.readFileSync(path.join(current, 'plugin-configs.json'), 'utf8'));
    // Migration 77 remaps ids in the database; this file is not reached by it,
    // and an orphaned key means the plugin loses its stored settings.
    expect(config['com.eaves.openmemory']).toEqual({ apiKey: 'secret' });
    expect(config['com.enclave.openmemory']).toBeUndefined();
    // Third-party ids are not ours to rename.
    expect(config['org.example.thing']).toEqual({ setting: 1 });
  });

  it('rewrites the id an installed plugin declares, and moves its directory', () => {
    seedLegacyProfile();
    write(path.join(legacy, 'plugins', 'com-enclave-openmemory', 'plugin.json'),
      JSON.stringify({ id: 'com.enclave.openmemory', name: 'OpenMemory', sandboxVersion: 1 }));

    migrateLegacyProfile();

    const pluginsDir = path.join(current, 'plugins');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginsDir, 'com-eaves-openmemory', 'plugin.json'), 'utf8'));
    // Discovery reads the id from the manifest, so leaving it stale would load
    // the plugin under its old id — with its migrated grants, storage and
    // enabled flag all filed under the new one.
    expect(manifest.id).toBe('com.eaves.openmemory');
    expect(manifest.name).toBe('OpenMemory');
    // The install directory is derived from the id, so it has to move with it.
    expect(fs.existsSync(path.join(pluginsDir, 'com-enclave-openmemory'))).toBe(false);
  });

  it('leaves a third-party installed plugin untouched', () => {
    seedLegacyProfile();
    write(path.join(legacy, 'plugins', 'org-example-thing', 'plugin.json'),
      JSON.stringify({ id: 'org.example.thing', sandboxVersion: 1 }));

    migrateLegacyProfile();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(current, 'plugins', 'org-example-thing', 'plugin.json'), 'utf8'));
    expect(manifest.id).toBe('org.example.thing');
  });

  it('survives an unreadable plugin manifest', () => {
    seedLegacyProfile();
    write(path.join(legacy, 'plugins', 'broken', 'plugin.json'), '{ not json');

    expect(() => migrateLegacyProfile()).not.toThrow();
    // The database still made it across.
    expect(fs.existsSync(path.join(current, 'eaves-data', 'eaves.db'))).toBe(true);
  });

  describe('resuming an interrupted migration', () => {
    // The failure these cover: the work is a sequence of renames, so an
    // interruption partway through used to look identical to "already done" on
    // the next launch. The app then booted, created a fresh database over the
    // top, and the real one was never read again.

    it('finishes a run interrupted before the data directory was renamed', () => {
      // State left by dying after the profile moved but before the rename.
      write(path.join(current, 'enclave-data', 'enclave.db'), 'main');
      write(path.join(current, 'enclave-data', 'enclave.db-wal'), 'uncheckpointed');

      expect(migrateLegacyProfile()).not.toBeNull();

      expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db'), 'utf8')).toBe('main');
      expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db-wal'), 'utf8')).toBe('uncheckpointed');
      expect(fs.existsSync(path.join(current, 'enclave-data'))).toBe(false);
    });

    it('does not fail when the renamed data directory already exists', () => {
      // Renaming a directory onto a non-empty one is ENOTEMPTY, which threw
      // partway through and split the profile across both names.
      seedLegacyProfile();
      write(path.join(current, 'eaves-data', 'backups', 'x.db'), 'backup');

      expect(() => migrateLegacyProfile()).not.toThrow();

      expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db'), 'utf8')).toBe('main');
      expect(fs.readFileSync(path.join(current, 'eaves-data', 'backups', 'x.db'), 'utf8')).toBe('backup');
      expect(fs.existsSync(path.join(current, 'enclave-data'))).toBe(false);
    });
  });

  it('moves a rollback journal, not just the WAL sidecars', () => {
    seedLegacyProfile();
    // WAL silently degrades to a rollback journal on filesystems without
    // shared-memory support. Moving the database without a hot -journal means
    // SQLite treats a file that should have been rolled back as clean.
    write(path.join(legacy, 'enclave-data', 'enclave.db-journal'), 'hot');

    migrateLegacyProfile();

    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db-journal'), 'utf8')).toBe('hot');
  });

  it('renames backups so the restore UI can still see them', () => {
    seedLegacyProfile();
    write(path.join(legacy, 'enclave-data', 'backups', 'enclave-20260815T165004405Z-startup.db'), 'backup');

    migrateLegacyProfile();

    const backups = path.join(current, 'eaves-data', 'backups');
    // Backups are matched by filename, so one named for the old app is
    // invisible to restore and never pruned — the one thing a user reaches for
    // after a bad migration.
    expect(fs.readFileSync(path.join(backups, 'eaves-20260815T165004405Z-startup.db'), 'utf8')).toBe('backup');
    expect(fs.existsSync(path.join(backups, 'enclave-20260815T165004405Z-startup.db'))).toBe(false);
  });

  it('never migrates Chromium singleton state', () => {
    seedLegacyProfile();
    fs.symlinkSync('somehost-12345', path.join(legacy, 'SingletonLock'));
    write(path.join(legacy, '.org.chromium.Chromium.abc123'), 'scratch');

    migrateLegacyProfile();

    // These encode a pid, host and socket path belonging to another process.
    // Inheriting one can make requestSingleInstanceLock quit the first launch
    // after the migration, with no window and no message.
    expect(fs.existsSync(path.join(current, 'SingletonLock'))).toBe(false);
    expect(fs.existsSync(path.join(current, '.org.chromium.Chromium.abc123'))).toBe(false);
    expect(fs.existsSync(path.join(current, 'eaves-data', 'eaves.db'))).toBe(true);
  });

  it('rekeys plugin ids even when there is no profile left to move', () => {
    // A profile migrated by an earlier build has nothing to move, but its
    // manifests may still be on the old ids while the database was remapped.
    write(path.join(current, 'eaves-data', 'eaves.db'), 'main');
    write(path.join(current, 'plugins', 'com-enclave-openmemory', 'plugin.json'),
      JSON.stringify({ id: 'com.enclave.openmemory', sandboxVersion: 1 }));

    expect(migrateLegacyProfile()).toBeNull();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(current, 'plugins', 'com-eaves-openmemory', 'plugin.json'), 'utf8'));
    expect(manifest.id).toBe('com.eaves.openmemory');
  });

  it('ignores a legacy profile that has no database', () => {
    write(path.join(legacy, 'logs', 'enclave-2026-01-01.log'), 'log');

    expect(migrateLegacyProfile()).toBeNull();
    expect(fs.existsSync(current)).toBe(false);
  });
});
