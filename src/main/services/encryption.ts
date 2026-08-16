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
 * Version tags Chromium's os_crypt puts in front of its ciphertext.
 *
 * These are what let a stored value be identified as encrypted without being
 * decryptable, which is the whole basis of the guard below. Windows DPAPI
 * output carries no such tag, so a value there simply falls through to the
 * legacy path — which is correct, since DPAPI is keyed to the user account and
 * is unaffected by anything this guard exists to catch.
 */
const OS_CRYPT_VERSION_TAGS = ['v10', 'v11'];

/** Whether a stored value is os_crypt ciphertext, regardless of decryptability. */
function isEncryptedPayload(storedKey: string): boolean {
  try {
    const tag = Buffer.from(storedKey, 'base64').subarray(0, 3).toString('latin1');
    return OS_CRYPT_VERSION_TAGS.includes(tag);
  } catch {
    return false;
  }
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
 *
 * "Encryption is available" is not enough on its own, though. The key can be
 * ciphertext this install genuinely cannot read — safeStorage derives its key
 * from an OS keyring entry tied to the application name, so renaming the app
 * strands everything encrypted under the old one. Measured: with
 * gnome-libsecret a value encrypted as "enclave" fails to decrypt as "eaves";
 * with kwallet6 it still decrypts. macOS Keychain is keyed the same way as
 * libsecret. Without the tag check below, that lands in exactly the branch
 * this function was written to prevent — a base64 blob sent to a provider as
 * an API key.
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

  if (isEncryptedPayload(storedKey)) {
    logger.error(
      'A stored credential is encrypted but cannot be decrypted on this system. This ' +
      'usually means it was saved by a different application identity — for example ' +
      'before the rename to Eaves — and the OS keyring entry it was sealed with is no ' +
      'longer the one in use. Re-enter the key to store it again.'
    );
    return null;
  }

  // Not tagged as ciphertext, so it predates encryption being added.
  logger.debug('Key appears to be stored in plaintext (legacy format)');
  return storedKey;
}
