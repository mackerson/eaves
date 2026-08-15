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

  it('does not touch an existing Eaves database', () => {
    seedLegacyProfile();
    write(path.join(current, 'eaves-data', 'eaves.db'), 'current');

    expect(migrateLegacyProfile()).toBeNull();

    expect(fs.readFileSync(path.join(current, 'eaves-data', 'eaves.db'), 'utf8')).toBe('current');
    // The legacy profile is left exactly where it was, not half-consumed.
    expect(fs.existsSync(path.join(legacy, 'enclave-data', 'enclave.db'))).toBe(true);
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

  it('ignores a legacy profile that has no database', () => {
    write(path.join(legacy, 'logs', 'enclave-2026-01-01.log'), 'log');

    expect(migrateLegacyProfile()).toBeNull();
    expect(fs.existsSync(current)).toBe(false);
  });
});
