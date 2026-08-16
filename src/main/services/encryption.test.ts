/**
 * Tests for the credential decrypt path.
 *
 * The case that matters: a value that IS encrypted but cannot be decrypted by
 * this install. safeStorage derives its key from an OS keyring entry tied to
 * the application name, so renaming the app strands anything sealed under the
 * old one — measured with gnome-libsecret, where a value encrypted as
 * "enclave" does not decrypt as "eaves". Treating that as legacy plaintext
 * hands a base64 blob to a provider as an API key.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock is hoisted above module scope, so the doubles have to be too.
const { safeStorage, loggerError } = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  loggerError: vi.fn(),
}));

vi.mock('electron', () => ({ safeStorage }));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: loggerError, debug: vi.fn() },
}));

import { decryptAPIKey } from './encryption';

/** Base64 of an os_crypt payload: version tag followed by opaque bytes. */
const ciphertext = (tag: string) =>
  Buffer.concat([Buffer.from(tag, 'latin1'), Buffer.from('opaque-sealed-bytes')]).toString('base64');

describe('decryptAPIKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
  });

  it('returns the decrypted key when decryption works', () => {
    safeStorage.decryptString.mockReturnValue('sk-real-key');

    expect(decryptAPIKey(ciphertext('v11'))).toBe('sk-real-key');
  });

  it('refuses a ciphertext this install cannot decrypt', () => {
    // Encrypted under a different application identity — the rename case.
    safeStorage.decryptString.mockImplementation(() => { throw new Error('Error while decrypting'); });

    const stored = ciphertext('v11');
    expect(decryptAPIKey(stored)).toBeNull();
    // Never hand the caller the ciphertext: a wrong key is a rejected request
    // nobody can explain, where no key is a visible failure.
    expect(decryptAPIKey(stored)).not.toBe(stored);
    expect(loggerError).toHaveBeenCalled();
  });

  it('recognises both os_crypt version tags', () => {
    safeStorage.decryptString.mockImplementation(() => { throw new Error('nope'); });

    expect(decryptAPIKey(ciphertext('v10'))).toBeNull();
    expect(decryptAPIKey(ciphertext('v11'))).toBeNull();
  });

  it('still passes through a genuine pre-encryption plaintext key', () => {
    safeStorage.decryptString.mockImplementation(() => { throw new Error('not ciphertext'); });

    // No version tag, so it predates encryption being added.
    expect(decryptAPIKey('sk-legacy-plaintext-key')).toBe('sk-legacy-plaintext-key');
  });

  it('refuses everything when the OS keyring is unavailable', () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false);

    // Encrypted and plaintext are indistinguishable here, so neither is used.
    expect(decryptAPIKey(ciphertext('v11'))).toBeNull();
    expect(decryptAPIKey('sk-legacy-plaintext-key')).toBeNull();
  });

  it('returns null for an absent key without logging an error', () => {
    expect(decryptAPIKey(null)).toBeNull();
    expect(decryptAPIKey('')).toBeNull();
    expect(loggerError).not.toHaveBeenCalled();
  });
});
