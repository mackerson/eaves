/**
 * Encryption utilities using Electron's safeStorage API
 * Provides secure storage for sensitive data like API keys
 */

import { safeStorage } from 'electron';
import { logger } from './logger';

export function encryptString(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this system');
  }

  const buffer = safeStorage.encryptString(plaintext);
  return buffer.toString('base64');
}

export function decryptString(encrypted: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }

    const buffer = Buffer.from(encrypted, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (error) {
    // Silent fail - caller will handle backwards compatibility
    return null;
  }
}

export function encryptAPIKey(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null;
  return encryptString(apiKey);
}

/**
 * Decrypts, or returns plaintext for keys stored before encryption existed.
 *
 * The legacy fallback is only sound while `safeStorage` works. When it does
 * not — a Linux box with no keyring, a broken keychain — every decrypt fails,
 * and returning the stored value handed the caller base64 ciphertext to send
 * to a provider as an API key. Nothing distinguishes the two cases at the call
 * site, so this refuses instead: no key is a visible failure, a wrong key is a
 * rejected request nobody can explain.
 */
export function decryptAPIKey(storedKey: string | null | undefined): string | null {
  if (!storedKey) return null;

  if (!safeStorage.isEncryptionAvailable()) {
    logger.error(
      'Cannot read stored credentials: OS encryption is unavailable, so an encrypted ' +
      'key cannot be told apart from a legacy plaintext one. Re-enter the key once ' +
      'the system keyring is working.'
    );
    return null;
  }

  const decrypted = decryptString(storedKey);
  if (decrypted !== null) {
    return decrypted;
  }

  // Encryption works and this still would not decrypt, so it predates
  // encryption being added. Safe to use as-is.
  logger.debug('Key appears to be stored in plaintext (legacy format)');
  return storedKey;
}
