/**
 * Per-plugin secrets, sealed with Electron safeStorage.
 *
 * Plugin `config` is plaintext on disk, which makes it the wrong home for the
 * tokens every credentialed bridge needs (IMAP passwords, bot tokens, SASL).
 * This store is the right one: values are encrypted with the OS keychain via
 * safeStorage before they touch disk, namespaced per plugin, and reachable only
 * through the `secrets` RPC namespace behind the `secrets:read` /
 * `secrets:write` grants.
 *
 * FAIL-CLOSED: when safeStorage reports encryption unavailable (headless
 * Linux, no keyring), `set` and `get` throw — there is deliberately no
 * plaintext fallback, unlike the legacy API-key path in encryption.ts whose
 * backwards-compatibility this store does not carry. `delete` and `keys`
 * still work: they touch only key names and ciphertext, never plaintext.
 *
 * Secret values must never appear in logs, errors, or events — log key names
 * and plugin ids only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { logger } from './logger';

const SECRETS_FILE = 'plugin-secrets.json';
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 64 * 1024;

interface SecretsFile {
  version: 1;
  /** pluginId -> key -> base64(safeStorage ciphertext) */
  secrets: Record<string, Record<string, string>>;
}

export class PluginSecretsStore {
  private filePath: string;
  private data: SecretsFile | null = null;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, SECRETS_FILE);
  }

  private assertEncryptionAvailable(operation: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        `Secrets ${operation} refused: OS encryption (safeStorage) is not available. ` +
        `Secrets are never stored or returned in plaintext.`
      );
    }
  }

  private assertValidKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new Error(`Secret key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
    }
  }

  private load(): SecretsFile {
    if (this.data) return this.data;
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as SecretsFile;
        if (parsed && parsed.version === 1 && parsed.secrets && typeof parsed.secrets === 'object') {
          this.data = parsed;
          return parsed;
        }
        logger.warn('[PluginSecretsStore] Unrecognized secrets file shape; starting empty (file preserved until next write)');
      }
    } catch (error) {
      // The file holds only ciphertext, so the failure mode here is losing
      // secrets, not leaking them. Refuse rather than silently clobber.
      throw new Error(
        `Could not read plugin secrets file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.data = { version: 1, secrets: {} };
    return this.data;
  }

  private persist(): void {
    if (!this.data) return;
    const tmpPath = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }

  set(pluginId: string, key: string, value: string): void {
    this.assertValidKey(key);
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
      throw new Error(`Secret value must be a string of at most ${MAX_VALUE_LENGTH} characters`);
    }
    this.assertEncryptionAvailable('write');

    const file = this.load();
    const ciphertext = safeStorage.encryptString(value).toString('base64');
    if (!file.secrets[pluginId]) file.secrets[pluginId] = {};
    file.secrets[pluginId][key] = ciphertext;
    this.persist();
    logger.info(`[PluginSecretsStore] Stored secret for ${pluginId}`, { key });
  }

  /**
   * Returns null for a key that was never set. A key that exists but cannot
   * be decrypted (keyring changed, app identity renamed) throws instead of
   * returning null — "missing" and "unreadable" must not be confusable, or a
   * plugin would silently re-prompt for credentials it still holds.
   */
  get(pluginId: string, key: string): string | null {
    this.assertValidKey(key);
    this.assertEncryptionAvailable('read');

    const stored = this.load().secrets[pluginId]?.[key];
    if (stored === undefined) return null;

    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      throw new Error(
        `Secret '${key}' exists but cannot be decrypted by this install. ` +
        `It was sealed under a different OS keyring identity.`
      );
    }
  }

  delete(pluginId: string, key: string): boolean {
    this.assertValidKey(key);
    const file = this.load();
    const bucket = file.secrets[pluginId];
    if (!bucket || !(key in bucket)) return false;
    delete bucket[key];
    if (Object.keys(bucket).length === 0) delete file.secrets[pluginId];
    this.persist();
    return true;
  }

  keys(pluginId: string): string[] {
    return Object.keys(this.load().secrets[pluginId] ?? {});
  }

  /** Drop every secret a plugin holds — the uninstall path. */
  clearPlugin(pluginId: string): void {
    const file = this.load();
    if (!(pluginId in file.secrets)) return;
    delete file.secrets[pluginId];
    this.persist();
    logger.info(`[PluginSecretsStore] Cleared secrets for ${pluginId}`);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: PluginSecretsStore | null = null;

export function getPluginSecretsStore(): PluginSecretsStore {
  if (!instance) {
    // Lazy so tests can construct against a temp dir without electron's app.
    const { app } = require('electron') as typeof import('electron');
    instance = new PluginSecretsStore(app.getPath('userData'));
  }
  return instance;
}

export function resetPluginSecretsStore(): void {
  instance = null;
}
