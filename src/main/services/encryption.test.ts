import { describe, it, expect, vi, beforeEach } from 'vitest';

const { safeStorage } = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('electron', () => ({ safeStorage }));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  encryptString,
  decryptString,
  encryptAPIKey,
  decryptAPIKey,
} from './encryption';
import { logger } from './logger';

describe('encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('encryptString', () => {
    it('throws when encryption is unavailable', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      expect(() => encryptString('secret')).toThrow('Encryption not available');
    });

    it('base64-encodes the buffer from safeStorage', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.encryptString.mockReturnValue(Buffer.from('cipher-bytes'));
      expect(encryptString('plain')).toBe(Buffer.from('cipher-bytes').toString('base64'));
      expect(safeStorage.encryptString).toHaveBeenCalledWith('plain');
    });
  });

  describe('decryptString', () => {
    it('returns null when encryption is unavailable', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      expect(decryptString('anything')).toBeNull();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
    });

    it('decrypts a base64 payload', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.decryptString.mockReturnValue('plain');
      const payload = Buffer.from('cipher').toString('base64');
      expect(decryptString(payload)).toBe('plain');
      expect(safeStorage.decryptString).toHaveBeenCalledWith(Buffer.from('cipher'));
    });

    it('returns null and swallows decrypt errors', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.decryptString.mockImplementation(() => {
        throw new Error('bad');
      });
      expect(decryptString(Buffer.from('x').toString('base64'))).toBeNull();
    });
  });

  describe('encryptAPIKey / decryptAPIKey', () => {
    it.each([null, undefined, ''] as const)('encryptAPIKey(%j) → null', (input) => {
      expect(encryptAPIKey(input)).toBeNull();
    });

    it('encryptAPIKey encrypts non-empty keys', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.encryptString.mockReturnValue(Buffer.from('c'));
      expect(encryptAPIKey('sk-test')).toBe(Buffer.from('c').toString('base64'));
    });

    it.each([null, undefined, ''] as const)('decryptAPIKey(%j) → null', (input) => {
      expect(decryptAPIKey(input)).toBeNull();
    });

    it('returns decrypted value when decrypt succeeds', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.decryptString.mockReturnValue('sk-live');
      expect(decryptAPIKey(Buffer.from('c').toString('base64'))).toBe('sk-live');
    });

    it('falls back to plaintext legacy storage when decrypt fails', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.decryptString.mockImplementation(() => {
        throw new Error('not encrypted');
      });
      expect(decryptAPIKey('sk-legacy-plaintext')).toBe('sk-legacy-plaintext');
      expect(logger.debug).toHaveBeenCalled();
    });

    // The legacy fallback is only sound while safeStorage works. Without it
    // every decrypt fails, and returning the stored value hands base64
    // ciphertext to a provider as an API key.
    it('returns nothing rather than ciphertext when encryption is unavailable', () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      const ciphertext = Buffer.from('encrypted-bytes').toString('base64');

      expect(decryptAPIKey(ciphertext)).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
