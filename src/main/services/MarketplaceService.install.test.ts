/**
 * Coverage for the guards installPlugin relies on to be the V1 trust root.
 *
 * The curated registry plus a checksum *is* the security model — there is no
 * signing — so each of these rejections is load-bearing, and each must leave
 * nothing installed and nothing loaded:
 *   - the release asset must match the sha256 the registry published
 *   - the bundle must request exactly the permissions the user consented to
 *   - the release url must be https
 *   - the bundle's manifest must declare the id being installed, sandboxed
 *
 * These exercise the real filesystem under a temp userData dir; only the
 * network, the unpack step, and the plugin manager are stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getVersion: () => '1.0.0',
  },
}));

// The unpack step is stubbed so a test can control exactly what lands in the
// stage dir — that is the payload the manifest guards run against.
let unpackedManifest: Record<string, unknown> | null = null;
vi.mock('tar', () => ({
  extract: vi.fn(async ({ cwd }: { cwd: string }) => {
    if (unpackedManifest === null) return; // simulate a bundle with no plugin.json
    fs.writeFileSync(path.join(cwd, 'plugin.json'), JSON.stringify(unpackedManifest));
  }),
}));

const manager = {
  getUserPluginsDir: () => path.join(userDataDir, 'plugins'),
  isPluginLoaded: vi.fn(() => false),
  unloadPlugin: vi.fn(async () => {}),
  loadUserPlugin: vi.fn(async () => ({})),
  getLoadedPlugins: vi.fn(() => []),
  removeUserPlugin: vi.fn(async () => {}),
};
vi.mock('./sandbox', () => ({ getSandboxedPluginManager: () => manager }));

const grants = {
  get: vi.fn(() => undefined),
  set: vi.fn(),
  delete: vi.fn(),
};
vi.mock('../repositories', () => ({ getPluginGrantsRepository: () => grants }));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ASSET_URL = 'https://github.com/mackerson/enclave-plugin-demo/releases/download/v1.0.0/demo-1.0.0.tgz';
const PERMISSIONS = ['ui:views:register', 'storage:write'];
const BUNDLE = Buffer.from('pretend this is a gzipped tarball');
const REAL_SHA = crypto.createHash('sha256').update(BUNDLE).digest('hex');

function registryWith(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    updated: '2026-08-14',
    plugins: [
      {
        id: 'com.enclave.demo',
        name: 'Demo',
        description: 'demo',
        author: 'mackerson',
        homepage: 'https://github.com/mackerson/enclave-plugin-demo',
        tier: 'official',
        latest: '1.0.0',
        permissions: PERMISSIONS,
        release: { tag: 'v1.0.0', asset: 'demo-1.0.0.tgz', url: ASSET_URL, sha256: REAL_SHA },
        ...overrides,
      },
    ],
  };
}

/** Fresh module per test: fetchRegistry memoises the registry in module scope. */
async function loadService(registry: unknown) {
  vi.resetModules();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('registry.json')) {
        return { ok: true, status: 200, json: async () => registry } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => BUNDLE.buffer.slice(BUNDLE.byteOffset, BUNDLE.byteOffset + BUNDLE.byteLength),
      } as unknown as Response;
    })
  );
  return import('./MarketplaceService');
}

const destDir = () => path.join(userDataDir, 'plugins', 'com-enclave-demo');

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-install-test-'));
  fs.mkdirSync(path.join(userDataDir, 'plugins'), { recursive: true });
  // Consent is host-enforced and covered by its own surface; approve so these
  // tests reach the guards that run after it.
  process.env.ENCLAVE_PLUGIN_AUTO_CONSENT = '1';
  unpackedManifest = { id: 'com.enclave.demo', sandboxVersion: 1, permissions: PERMISSIONS };
  vi.clearAllMocks();
  manager.isPluginLoaded.mockReturnValue(false);
  grants.get.mockReturnValue(undefined);
});

afterEach(() => {
  delete process.env.ENCLAVE_PLUGIN_AUTO_CONSENT;
  fs.rmSync(userDataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('installPlugin integrity guards', () => {
  it('installs when the asset matches the published checksum', async () => {
    const { installPlugin } = await loadService(registryWith());

    const result = await installPlugin('com.enclave.demo');

    expect(result).toMatchObject({ id: 'com.enclave.demo', version: '1.0.0' });
    expect(manager.loadUserPlugin).toHaveBeenCalledWith('com-enclave-demo');
    expect(grants.set).toHaveBeenCalledWith('com.enclave.demo', PERMISSIONS, '1.0.0', expect.any(Number));
    expect(fs.existsSync(destDir())).toBe(true);
  });

  it('rejects an asset whose checksum does not match the registry, installing nothing', async () => {
    const wrong = 'a'.repeat(64);
    const { installPlugin } = await loadService(
      registryWith({ release: { tag: 'v1.0.0', asset: 'demo-1.0.0.tgz', url: ASSET_URL, sha256: wrong } })
    );

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/checksum mismatch/i);

    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
    expect(grants.set).not.toHaveBeenCalled();
    expect(fs.existsSync(destDir())).toBe(false);
  });

  it('rejects a bundle requesting permissions the registry did not list', async () => {
    // The user consented to PERMISSIONS; the bundle quietly wants the disk too.
    unpackedManifest = {
      id: 'com.enclave.demo',
      sandboxVersion: 1,
      permissions: [...PERMISSIONS, 'system:filesystem'],
    };
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/permissions that differ/i);

    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
    expect(grants.set).not.toHaveBeenCalled();
    expect(fs.existsSync(destDir())).toBe(false);
  });

  it('rejects a bundle declaring fewer permissions than were consented to', async () => {
    unpackedManifest = { id: 'com.enclave.demo', sandboxVersion: 1, permissions: ['ui:views:register'] };
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/permissions that differ/i);
    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
  });

  it('refuses a release url that is not https', async () => {
    const { installPlugin } = await loadService(
      registryWith({
        release: { tag: 'v1.0.0', asset: 'demo-1.0.0.tgz', url: 'http://example.com/demo.tgz', sha256: REAL_SHA },
      })
    );

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/https/i);
    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
  });

  it('rejects a bundle whose manifest declares a different id', async () => {
    unpackedManifest = { id: 'com.enclave.somethingelse', sandboxVersion: 1, permissions: PERMISSIONS };
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/does not match/i);
    expect(fs.existsSync(destDir())).toBe(false);
  });

  it('rejects a bundle that is not marked sandboxVersion 1', async () => {
    unpackedManifest = { id: 'com.enclave.demo', permissions: PERMISSIONS };
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/sandboxVersion/i);
    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
  });

  it('rejects a bundle with no plugin.json at its root', async () => {
    unpackedManifest = null;
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/missing plugin\.json/i);
  });

  it('will not install an id that is absent from the registry', async () => {
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.attacker.evil')).rejects.toThrow(/not in the plugin registry/i);
    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
  });

  it('refuses an entry that needs a newer app than this one', async () => {
    const { installPlugin } = await loadService(registryWith({ minAppVersion: '2.0.0' }));

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/needs Enclave 2\.0\.0/i);
    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
  });

  it('declines to install when the user does not consent', async () => {
    process.env.ENCLAVE_PLUGIN_AUTO_CONSENT = '0';
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/cancelled/i);
    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
    expect(fs.existsSync(destDir())).toBe(false);
  });

  it('re-prompts when an update widens the permission set', async () => {
    // Already consented to a narrower set, so consent must be sought again —
    // with auto-consent declining, the install must not proceed.
    grants.get.mockReturnValue({ permissions: ['ui:views:register'], version: '0.9.0' } as never);
    process.env.ENCLAVE_PLUGIN_AUTO_CONSENT = '0';
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).rejects.toThrow(/cancelled/i);
    expect(manager.loadUserPlugin).not.toHaveBeenCalled();
  });

  it('does not re-prompt when the permission set is unchanged', async () => {
    // Same grants as the registry lists: a reinstall must not ask again, so it
    // succeeds even though auto-consent is set to decline.
    grants.get.mockReturnValue({ permissions: [...PERMISSIONS], version: '1.0.0' } as never);
    process.env.ENCLAVE_PLUGIN_AUTO_CONSENT = '0';
    const { installPlugin } = await loadService(registryWith());

    await expect(installPlugin('com.enclave.demo')).resolves.toMatchObject({ id: 'com.enclave.demo' });
    expect(manager.loadUserPlugin).toHaveBeenCalled();
  });
});
