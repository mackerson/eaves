/**
 * Tests for the plugin secrets store.
 *
 * The cases that matter: fail-closed when safeStorage reports unavailable (no
 * plaintext ever written or returned), per-plugin namespacing, and the
 * missing-vs-unreadable distinction on get.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vi.mock is hoisted above module scope, so the doubles have to be too.
const { safeStorage } = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  safeStorage,
  app: { getPath: () => '/fake/userData' },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PluginSecretsStore } from './PluginSecretsStore';

// A reversible stand-in for safeStorage sealing, so roundtrips are testable.
const seal = (plaintext: string) => Buffer.from(`sealed:${plaintext}`, 'utf-8');
const unseal = (buffer: Buffer) => {
  const text = buffer.toString('utf-8');
  if (!text.startsWith('sealed:')) throw new Error('Error while decrypting');
  return text.slice('sealed:'.length);
};

describe('PluginSecretsStore', () => {
  let dir: string;
  let store: PluginSecretsStore;

  beforeEach(() => {
    vi.clearAllMocks();
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.encryptString.mockImplementation(seal);
    safeStorage.decryptString.mockImplementation(unseal);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-secrets-'));
    store = new PluginSecretsStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('roundtrips a secret through safeStorage', () => {
    store.set('com.eaves.telegram', 'botToken', 'tg-token-value');
    expect(store.get('com.eaves.telegram', 'botToken')).toBe('tg-token-value');
  });

  it('never writes the plaintext value to disk', () => {
    store.set('com.eaves.telegram', 'botToken', 'tg-token-value');
    const onDisk = fs.readFileSync(path.join(dir, 'plugin-secrets.json'), 'utf-8');
    expect(onDisk).not.toContain('tg-token-value');
  });

  it('persists across store instances', () => {
    store.set('com.eaves.irc', 'saslPassword', 'hunter2');
    const reopened = new PluginSecretsStore(dir);
    expect(reopened.get('com.eaves.irc', 'saslPassword')).toBe('hunter2');
  });

  it('namespaces secrets per plugin', () => {
    store.set('plugin-a', 'token', 'a-value');
    store.set('plugin-b', 'token', 'b-value');
    expect(store.get('plugin-a', 'token')).toBe('a-value');
    expect(store.get('plugin-b', 'token')).toBe('b-value');
    expect(store.keys('plugin-a')).toEqual(['token']);
  });

  it('returns null for a key that was never set', () => {
    expect(store.get('plugin-a', 'absent')).toBeNull();
  });

  describe('fail-closed when encryption is unavailable', () => {
    beforeEach(() => {
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
    });

    it('refuses set — no plaintext fallback', () => {
      expect(() => store.set('plugin-a', 'token', 'value')).toThrow(/not available/);
      expect(fs.existsSync(path.join(dir, 'plugin-secrets.json'))).toBe(false);
    });

    it('refuses get', () => {
      expect(() => store.get('plugin-a', 'token')).toThrow(/not available/);
    });

    it('still allows delete and keys — they touch no plaintext', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      store.set('plugin-a', 'token', 'value');
      safeStorage.isEncryptionAvailable.mockReturnValue(false);

      expect(store.keys('plugin-a')).toEqual(['token']);
      expect(store.delete('plugin-a', 'token')).toBe(true);
      expect(store.keys('plugin-a')).toEqual([]);
    });
  });

  it('throws (not null) for a secret sealed under a different keyring identity', () => {
    store.set('plugin-a', 'token', 'value');
    safeStorage.decryptString.mockImplementation(() => {
      throw new Error('Error while decrypting');
    });
    expect(() => store.get('plugin-a', 'token')).toThrow(/cannot be decrypted/);
  });

  it('clearPlugin removes every secret the plugin holds and nothing else', () => {
    store.set('plugin-a', 'token', 'a');
    store.set('plugin-a', 'refresh', 'b');
    store.set('plugin-b', 'token', 'c');

    store.clearPlugin('plugin-a');

    expect(store.keys('plugin-a')).toEqual([]);
    expect(store.get('plugin-b', 'token')).toBe('c');
  });

  it('rejects invalid keys and oversized values', () => {
    expect(() => store.set('plugin-a', '', 'v')).toThrow(/non-empty/);
    expect(() => store.set('plugin-a', 'k'.repeat(200), 'v')).toThrow(/at most/);
    expect(() => store.set('plugin-a', 'k', 'v'.repeat(70 * 1024))).toThrow(/at most/);
  });

  it('writes the secrets file with owner-only permissions', () => {
    store.set('plugin-a', 'token', 'value');
    const mode = fs.statSync(path.join(dir, 'plugin-secrets.json')).mode & 0o777;
    // Windows has no POSIX modes; only assert where they mean something.
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });
});
