import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../migrations';
import {
  getSyncIdentity,
  setDeviceName,
  setSyncEnabled,
  certFingerprint,
  pairingCode,
} from './deviceIdentity';

describe('deviceIdentity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, 0);
  });

  afterEach(() => db.close());

  it('generates a certificate once and returns a stable identity', async () => {
    const first = await getSyncIdentity(db);
    expect(first.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.certPem).toContain('BEGIN CERTIFICATE');
    expect(first.keyPem).toContain('PRIVATE KEY');
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.enabled).toBe(false);

    const second = await getSyncIdentity(db);
    expect(second.certPem).toBe(first.certPem);
    expect(second.fingerprint).toBe(first.fingerprint);
  }, 30_000);

  it('replaces the placeholder device name with the hostname', async () => {
    const identity = await getSyncIdentity(db);
    expect(identity.deviceName).not.toBe('This device');
    expect(identity.deviceName.length).toBeGreaterThan(0);
  }, 30_000);

  it('persists name and enabled updates', async () => {
    setDeviceName(db, 'Studio desktop');
    setSyncEnabled(db, true);
    const identity = await getSyncIdentity(db);
    expect(identity.deviceName).toBe('Studio desktop');
    expect(identity.enabled).toBe(true);
  }, 30_000);

  it('fingerprints match node X509 parsing on both ends', async () => {
    const identity = await getSyncIdentity(db);
    expect(certFingerprint(identity.certPem)).toBe(identity.fingerprint);
  }, 30_000);

  describe('pairingCode', () => {
    it('is symmetric and 6 digits', () => {
      const a = 'a'.repeat(64);
      const b = 'b'.repeat(64);
      expect(pairingCode(a, b)).toBe(pairingCode(b, a));
      expect(pairingCode(a, b)).toMatch(/^\d{6}$/);
    });

    it('changes when either fingerprint changes', () => {
      const a = 'a'.repeat(64);
      const b = 'b'.repeat(64);
      const c = 'c'.repeat(64);
      expect(pairingCode(a, b)).not.toBe(pairingCode(a, c));
    });
  });
});
