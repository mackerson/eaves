/**
 * Registry fetch provenance.
 *
 * The marketplace UI renders three different things for "here is the registry":
 * a live listing ('network'), a stale-but-usable one ('cache', with the date so
 * the user knows how stale), and an explicit outage ('none'). Before status
 * existed, an unreachable registry and an empty one were indistinguishable —
 * both rendered as "No plugins available yet", which is a lie while offline.
 * These tests pin the three sources and the force-refresh path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const paths = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => paths.userData,
    getVersion: () => '1.0.0',
  },
}));

vi.mock('./sandbox', () => ({
  getSandboxedPluginManager: vi.fn(),
}));

vi.mock('../repositories', () => ({
  getPluginGrantsRepository: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  fetchRegistry,
  getMarketplaceListing,
  getRegistryUrl,
  resetRegistryCacheForTests,
} from './MarketplaceService';
import { getSandboxedPluginManager } from './sandbox';

const REGISTRY = {
  schemaVersion: 1,
  updated: '2026-09-30',
  plugins: [
    {
      id: 'com.eaves.webview',
      name: 'WebView Browser',
      description: 'Embedded web browser.',
      author: 'mackerson',
      homepage: 'https://example.invalid/webview',
      tier: 'official',
      latest: '2.0.1',
      permissions: ['ui:views:register'],
      release: { tag: 'v2.0.1', asset: 'webview-2.0.1.tgz', url: 'https://example.invalid/a.tgz', sha256: 'a'.repeat(64) },
    },
  ],
};

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe('fetchRegistry provenance', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-registry-test-'));
    resetRegistryCacheForTests();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getSandboxedPluginManager).mockReturnValue({
      getLoadedPlugins: () => [],
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(paths.userData, { recursive: true, force: true });
  });

  it('reports source network on a live fetch, and writes the disk cache', async () => {
    fetchMock.mockResolvedValue(okResponse(REGISTRY));

    const listing = await getMarketplaceListing();

    expect(listing.status.source).toBe('network');
    expect(listing.status.updated).toBe('2026-09-30');
    expect(listing.status.fetchedAt).not.toBeNull();
    expect(listing.plugins).toHaveLength(1);

    const cacheFile = path.join(paths.userData, 'marketplace', 'registry.json');
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')).updated).toBe('2026-09-30');
  });

  it('falls back to the disk cache when the fetch fails, and says so', async () => {
    // Prime the cache with one good fetch, then go "offline".
    fetchMock.mockResolvedValueOnce(okResponse(REGISTRY));
    await fetchRegistry();
    fetchMock.mockRejectedValue(new Error('offline'));

    const listing = await getMarketplaceListing(true);

    expect(listing.status.source).toBe('cache');
    expect(listing.status.updated).toBe('2026-09-30');
    expect(listing.status.fetchedAt).toBeNull();
    expect(listing.plugins).toHaveLength(1); // still usable, not empty
  });

  it('reports source none with an empty listing when offline and uncached', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    const listing = await getMarketplaceListing();

    expect(listing.status.source).toBe('none');
    expect(listing.plugins).toHaveLength(0);
  });

  it('serves the in-memory copy without refetching unless forced', async () => {
    fetchMock.mockResolvedValue(okResponse(REGISTRY));

    await getMarketplaceListing();
    await getMarketplaceListing();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getMarketplaceListing(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed registry body rather than caching it', async () => {
    fetchMock.mockResolvedValue(okResponse({ nope: true }));

    const listing = await getMarketplaceListing();

    expect(listing.status.source).toBe('none');
    expect(listing.plugins).toHaveLength(0);
    expect(fs.existsSync(path.join(paths.userData, 'marketplace', 'registry.json'))).toBe(false);
  });
});

describe('getRegistryUrl', () => {
  const saved = process.env.EAVES_REGISTRY_URL;

  afterEach(() => {
    if (saved === undefined) delete process.env.EAVES_REGISTRY_URL;
    else process.env.EAVES_REGISTRY_URL = saved;
  });

  it('defaults to the GitHub registry', () => {
    delete process.env.EAVES_REGISTRY_URL;
    expect(getRegistryUrl()).toContain('eaves-plugin-registry');
  });

  it('is one env var away from the mesh /directory origin (the V2 swap)', () => {
    process.env.EAVES_REGISTRY_URL = 'https://mesh.example/directory';
    expect(getRegistryUrl()).toBe('https://mesh.example/directory');
  });
});
