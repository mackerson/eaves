import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/eaves-vec-test', isPackaged: true } }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./migrations', () => ({ runMigrations: vi.fn() }));
vi.mock('./encryption', () => ({ encryptAPIKey: vi.fn() }));
vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: function () { return {}; } }));

const { getLoadablePath } = vi.hoisted(() => ({ getLoadablePath: vi.fn() }));
vi.mock('sqlite-vec', () => ({ getLoadablePath, load: vi.fn() }));

import { resolveVecExtensionPath } from './database';

/**
 * sqlite-vec resolves the extension with require.resolve and the path is then
 * handed to dlopen, which has no idea what an asar is. asarUnpack puts the real
 * file under app.asar.unpacked but require.resolve keeps reporting the packed
 * path — so both halves are needed, and without them every packaged build
 * silently degraded to FTS-only search forever.
 */
describe('resolveVecExtensionPath', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects a packed path to the unpacked copy', () => {
    const packed = path.join('/opt', 'Eaves', 'resources', 'app.asar', 'node_modules', 'sqlite-vec-linux-x64', 'vec0.so');
    getLoadablePath.mockReturnValue(packed);

    expect(resolveVecExtensionPath()).toBe(
      path.join('/opt', 'Eaves', 'resources', 'app.asar.unpacked', 'node_modules', 'sqlite-vec-linux-x64', 'vec0.so'),
    );
  });

  it('leaves a dev path (no asar) alone', () => {
    const dev = path.join('/home', 'dev', 'eaves', 'node_modules', 'sqlite-vec-linux-x64', 'vec0.so');
    getLoadablePath.mockReturnValue(dev);

    expect(resolveVecExtensionPath()).toBe(dev);
  });

  // Only the directory segment is a redirect target. A path that merely
  // contains the substring elsewhere must not be rewritten.
  it('only rewrites the app.asar path segment', () => {
    const odd = path.join('/home', 'dev', 'app.asar-notes', 'node_modules', 'sqlite-vec-linux-x64', 'vec0.so');
    getLoadablePath.mockReturnValue(odd);

    expect(resolveVecExtensionPath()).toBe(odd);
  });
});
