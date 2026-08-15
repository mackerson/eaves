import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

vi.mock('./logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sentToRenderer: Array<{ channel: string; payload?: unknown }> = [];

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload?: unknown) => {
            sentToRenderer.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

const loadPlugin = vi.fn();
const reloadPlugin = vi.fn();
const isPluginLoaded = vi.fn(() => false);

vi.mock('./sandbox', () => ({
  getSandboxedPluginManager: () => ({ loadPlugin, reloadPlugin, isPluginLoaded }),
}));

import { PluginWatcher } from './PluginWatcher';

/**
 * Hot reload is the mechanism behind authoring a plugin into a running app, and
 * it had rotted silently in two ways that these tests pin down: the chokidar
 * glob that stopped matching anything, and a manifest shape the loader could
 * not consume. Both failed without an error, so only an end-to-end watch proves
 * it works.
 */
// The watcher debounces writes by 1s before acting, so these tests need more
// headroom than the 5s default.
const TEST_TIMEOUT = 20_000;

describe('PluginWatcher', () => {
  let tmpDir: string;
  let watcher: PluginWatcher;

  const manifest = {
    id: 'com.example.watched',
    name: 'Watched',
    version: '1.0.0',
    description: 'fixture',
    author: 'test',
    type: 'tool',
    sandboxVersion: 1,
    permissions: ['tools:register'],
    entry: 'index.cjs',
  };

  /** Poll until `predicate` holds, so tests track the watcher instead of racing a fixed sleep. */
  const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for watcher');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `plugin-watcher-${randomUUID()}-`));
    sentToRenderer.length = 0;
    loadPlugin.mockClear();
    reloadPlugin.mockClear();
    isPluginLoaded.mockReturnValue(false);
    watcher = new PluginWatcher();
  });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a plugin dropped into a watched directory', async () => {
    watcher.start(tmpDir, 'user');
    await watcher.whenReady();

    const pluginDir = path.join(tmpDir, 'com-example-watched');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));

    await waitFor(() => loadPlugin.mock.calls.length > 0);

    expect(loadPlugin).toHaveBeenCalledTimes(1);
  }, TEST_TIMEOUT);

  it('hands the loader a manifest it can resolve: absolute path, relative entry', async () => {
    watcher.start(tmpDir, 'user');
    await watcher.whenReady();

    const pluginDir = path.join(tmpDir, 'com-example-watched');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));

    await waitFor(() => loadPlugin.mock.calls.length > 0);

    // The loader does path.join(manifest.path, manifest.entry); an absolute
    // entry with no `path` threw ERR_INVALID_ARG_TYPE on every hot load.
    const loaded = loadPlugin.mock.calls[0][0];
    expect(loaded.path).toBe(pluginDir);
    expect(loaded.entry).toBe('index.cjs');
    expect(path.isAbsolute(loaded.entry)).toBe(false);
    expect(fs.existsSync(path.join(loaded.path, loaded.entry))).toBe(true);
  }, TEST_TIMEOUT);

  it('tags the manifest with the source of the directory it was found in', async () => {
    watcher.start(tmpDir, 'dev');
    await watcher.whenReady();

    const pluginDir = path.join(tmpDir, 'com-example-watched');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));

    await waitFor(() => loadPlugin.mock.calls.length > 0);

    // `source` decides where the renderer fetches the UI bundle from, so a
    // mislabelled tier loads the plugin but leaves its view unable to resolve.
    expect(loadPlugin.mock.calls[0][0].source).toBe('dev');
    expect(loadPlugin.mock.calls[0][0].folderName).toBe('com-example-watched');
  }, TEST_TIMEOUT);

  it('waits for an entry file written after the manifest', async () => {
    watcher.start(tmpDir, 'user');
    await watcher.whenReady();

    const pluginDir = path.join(tmpDir, 'com-example-watched');
    fs.mkdirSync(pluginDir);
    // Manifest first — the order an author or agent naturally writes in, and
    // the one that triggers the load.
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));

    await waitFor(() => sentToRenderer.some((m) => m.channel === 'plugin:detected'));
    expect(loadPlugin).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(pluginDir, 'index.cjs'), 'module.exports = {};');

    await waitFor(() => loadPlugin.mock.calls.length > 0);
    expect(loadPlugin).toHaveBeenCalledTimes(1);
  }, TEST_TIMEOUT);

  it('tells the renderer to rebuild its view list once the plugin is loaded', async () => {
    watcher.start(tmpDir, 'user');
    await watcher.whenReady();

    const pluginDir = path.join(tmpDir, 'com-example-watched');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));

    await waitFor(() => sentToRenderer.some((m) => m.channel === 'plugin:loaded'));

    // Without this the sidebar keeps its stale list, so a hot-loaded plugin
    // announces itself in a toast and then appears to have done nothing.
    expect(sentToRenderer.some((m) => m.channel === 'plugin-views-changed')).toBe(true);
  }, TEST_TIMEOUT);

  it('reloads an already-loaded plugin when its manifest changes', async () => {
    const pluginDir = path.join(tmpDir, 'com-example-watched');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));

    // ignoreInitial: only edits after start() should register.
    watcher.start(tmpDir, 'user');
    await watcher.whenReady();
    isPluginLoaded.mockReturnValue(true);

    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ ...manifest, version: '1.0.1' })
    );

    await waitFor(() => reloadPlugin.mock.calls.length > 0);

    expect(reloadPlugin).toHaveBeenCalledWith('com-example-watched');
    expect(loadPlugin).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it('ignores a manifest that fails validation', async () => {
    watcher.start(tmpDir, 'user');
    await watcher.whenReady();

    const pluginDir = path.join(tmpDir, 'com-example-broken');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'index.cjs'), 'module.exports = {};');
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'No id, no version' })
    );

    await waitFor(() => sentToRenderer.some((m) => m.channel === 'plugin:detected'));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(loadPlugin).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it('does not watch below the plugin directory', async () => {
    watcher.start(tmpDir, 'user');
    await watcher.whenReady();

    const pluginDir = path.join(tmpDir, 'com-example-watched');
    fs.mkdirSync(path.join(pluginDir, 'ui', 'nested'), { recursive: true });
    // A plugin.json this deep is not a plugin manifest — a dependency's own
    // manifest must not trigger a load.
    fs.writeFileSync(path.join(pluginDir, 'ui', 'nested', 'plugin.json'), JSON.stringify(manifest));

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(loadPlugin).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);
});
