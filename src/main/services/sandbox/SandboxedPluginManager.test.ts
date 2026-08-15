/**
 * SandboxedPluginManager Tests
 *
 * Focused on the lifecycle-integrity fixes: a worker that fails to spawn
 * must not leave dangling manager-level listeners (item 1's manager-side
 * half — PluginWorker.test.ts covers the worker-thread half), disablePlugin
 * must actually tear the worker + bridges/gate down rather than just
 * flipping a flag (item 2), and a ResourceMonitor-initiated kill must be
 * observable to the manager so it stops handing out the plugin's tools
 * (item 3's manager-side half — ResourceMonitor.test.ts covers the
 * double-counting half).
 *
 * Everything below the manager is mocked: PluginWorker, the bridges, the
 * permission gate, the resource monitor, and the repositories (the last of
 * these specifically to avoid pulling the real repositories/index.ts import
 * graph — and its top-level `better-sqlite3` native binding — into a test
 * run that skips the ABI rebuild step, per the project's test-running rules).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { PluginManifest } from '../../../shared/types';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger', () => ({ logger: mockLogger }));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fake/app',
    getPath: () => '/fake/userData',
    isPackaged: true,
  },
}));

// The manager touches the filesystem for the plugins directory + entry-point
// checks; none of that is what these tests are about, so keep it inert.
vi.mock('fs', () => {
  const impl = {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    cpSync: vi.fn(),
  };
  return { ...impl, default: impl };
});

const { eventBusHandlers, eventBusMock } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
  return {
    eventBusHandlers: handlers,
    eventBusMock: {
      emitEvent: vi.fn(),
      onEvent: vi.fn((type: string, handler: (event: { data?: unknown }) => void) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      }),
    },
  };
});
vi.mock('../EventBus', () => ({ eventBus: eventBusMock }));

vi.mock('../PluginConfigManager', () => ({
  getPluginConfigManager: () => ({ getConfig: vi.fn(() => ({})), deleteConfig: vi.fn() }),
}));

const { pluginStateRepositoryMock } = vi.hoisted(() => ({
  pluginStateRepositoryMock: {
    isEnabled: vi.fn(() => null),
    setEnabled: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('../../repositories', () => ({
  getPluginStorageRepository: () => ({}),
  getPluginStateRepository: () => pluginStateRepositoryMock,
}));

vi.mock('../PluginDataAccess', () => ({ dispatchDataMethod: vi.fn() }));

const { permissionGateMock, callbackRegistryMock, eventBridgeMock, toolBridgeMock, serviceBridgeMock, resourceMonitorMock } =
  vi.hoisted(() => ({
    permissionGateMock: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), assertPermission: vi.fn() },
    callbackRegistryMock: { unregisterPlugin: vi.fn() },
    eventBridgeMock: { registerWorker: vi.fn(), unregisterWorker: vi.fn() },
    toolBridgeMock: { registerWorker: vi.fn(), unregisterWorker: vi.fn() },
    serviceBridgeMock: {
      registerWorker: vi.fn(),
      unregisterWorker: vi.fn(),
      getDefaultProvider: vi.fn(),
      getServiceMethods: vi.fn(),
      callServiceMethod: vi.fn(),
      callDefault: vi.fn(),
    },
    resourceMonitorMock: { track: vi.fn(), untrack: vi.fn(), start: vi.fn(), stop: vi.fn() },
  }));
vi.mock('./PermissionGate', () => ({ getPermissionGate: () => permissionGateMock }));
vi.mock('./CallbackRegistry', () => ({ getCallbackRegistry: () => callbackRegistryMock }));
vi.mock('./EventBridge', () => ({ getEventBridge: () => eventBridgeMock }));
vi.mock('./ToolBridge', () => ({ getToolBridge: () => toolBridgeMock }));
vi.mock('./ServiceBridge', () => ({ getServiceBridge: () => serviceBridgeMock }));
vi.mock('./ResourceMonitor', () => ({ getResourceMonitor: () => resourceMonitorMock }));

const { createdWorkers } = vi.hoisted(() => ({ createdWorkers: [] as FakePluginWorker[] }));

class FakePluginWorker extends EventEmitter {
  config: unknown;
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  isRunning = vi.fn(() => true);
  removeAllListenersSpy = vi.fn();

  constructor(config: unknown) {
    super();
    this.config = config;
  }

  removeAllListeners(event?: string | symbol): this {
    this.removeAllListenersSpy(event);
    return super.removeAllListeners(event);
  }
}

vi.mock('./PluginWorker', () => ({
  // A plain `function`, not an arrow, because `new PluginWorker(...)`
  // requires the mock implementation to be constructible.
  PluginWorker: vi.fn().mockImplementation(function (config: unknown) {
    const w = new FakePluginWorker(config);
    createdWorkers.push(w);
    return w;
  }),
}));

import { SandboxedPluginManager } from './SandboxedPluginManager';
import { getPluginStateRepository } from '../../repositories';

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'com.example.test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    type: 'tool',
    entry: 'index.js',
    permissions: [],
    sandboxVersion: 1,
    path: '/fake/plugins/test-plugin',
    source: 'user',
    folderName: 'test-plugin',
    ...overrides,
  } as PluginManifest;
}

describe('SandboxedPluginManager', () => {
  let manager: SandboxedPluginManager;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBusHandlers.clear();
    createdWorkers.length = 0;
    manager = new SandboxedPluginManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadPlugin failure cleanup (item 1, manager-side)', () => {
    it('unregisters the gate/bridges/monitor and detaches manager-level listeners when worker.start() fails', async () => {
      const manifest = makeManifest();
      // Fail the very next worker's start().
      const originalMock = (await import('./PluginWorker')).PluginWorker as unknown as ReturnType<typeof vi.fn>;
      originalMock.mockImplementationOnce(function (config: unknown) {
        const w = new FakePluginWorker(config);
        w.start.mockRejectedValue(new Error('activate() never resolved'));
        createdWorkers.push(w);
        return w;
      });

      await expect(manager.loadPlugin(manifest)).rejects.toThrow('activate() never resolved');

      expect(permissionGateMock.unregisterPlugin).toHaveBeenCalledWith(manifest.id);
      expect(eventBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(toolBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(serviceBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(resourceMonitorMock.untrack).toHaveBeenCalledWith(manifest.id);

      const failedWorker = createdWorkers[0];
      expect(failedWorker.removeAllListenersSpy).toHaveBeenCalled();

      // And the plugin must not be listed as loaded.
      expect(manager.isPluginLoaded(manifest.id)).toBe(false);
    });
  });

  describe('disablePlugin / enablePlugin (item 2)', () => {
    it('disable actually stops the worker and unregisters bridges/gate, not just a flag flip', async () => {
      const manifest = makeManifest();
      await manager.loadPlugin(manifest);
      const worker = createdWorkers[0];
      expect(manager.isPluginEnabled(manifest.id)).toBe(true);

      vi.clearAllMocks();
      await manager.disablePlugin(manifest.id);

      expect(worker.stop).toHaveBeenCalledTimes(1);
      expect(eventBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(toolBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(serviceBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(permissionGateMock.unregisterPlugin).toHaveBeenCalledWith(manifest.id);
      expect(resourceMonitorMock.untrack).toHaveBeenCalledWith(manifest.id);
      expect(manager.isPluginEnabled(manifest.id)).toBe(false);
      expect(getPluginStateRepository().setEnabled).toHaveBeenCalledWith(manifest.id, false);
    });

    it('enable spawns a fresh worker and brings the plugin back to a running state', async () => {
      const manifest = makeManifest();
      await manager.loadPlugin(manifest);
      await manager.disablePlugin(manifest.id);
      vi.clearAllMocks();

      await manager.enablePlugin(manifest.id);

      // A new worker instance, not the disabled one, backs the plugin now.
      expect(createdWorkers.length).toBe(2);
      const newWorker = createdWorkers[1];
      expect(newWorker.start).toHaveBeenCalledTimes(1);
      expect(permissionGateMock.registerPlugin).toHaveBeenCalledWith(manifest.id, manifest.permissions);
      expect(eventBridgeMock.registerWorker).toHaveBeenCalledWith(manifest.id, newWorker, permissionGateMock);
      expect(resourceMonitorMock.track).toHaveBeenCalledWith(manifest.id, newWorker);
      expect(manager.isPluginEnabled(manifest.id)).toBe(true);
      expect(getPluginStateRepository().setEnabled).toHaveBeenCalledWith(manifest.id, true);
    });

    it('does not start a plugin that is persisted as disabled', async () => {
      const manifest = makeManifest();
      (getPluginStateRepository().isEnabled as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      await manager.loadPlugin(manifest);

      // The load path used to spawn first and record `enabled: false` after,
      // so a disabled plugin came back to life on every launch — activated,
      // holding its grants, still receiving events — while the UI showed it
      // as off. Nothing may be spawned or registered here.
      expect(createdWorkers.length).toBe(0);
      expect(permissionGateMock.registerPlugin).not.toHaveBeenCalled();
      expect(eventBridgeMock.registerWorker).not.toHaveBeenCalled();
      expect(resourceMonitorMock.track).not.toHaveBeenCalled();

      // It is still loaded and listed, just not running — otherwise it could
      // never be re-enabled from the UI.
      expect(manager.isPluginLoaded(manifest.id)).toBe(true);
      expect(manager.isPluginEnabled(manifest.id)).toBe(false);
    });

    it('enables a plugin that was loaded disabled', async () => {
      const manifest = makeManifest();
      (getPluginStateRepository().isEnabled as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
      await manager.loadPlugin(manifest);
      vi.clearAllMocks();

      await manager.enablePlugin(manifest.id);

      expect(createdWorkers.length).toBe(1);
      expect(createdWorkers[0].start).toHaveBeenCalledTimes(1);
      expect(manager.isPluginEnabled(manifest.id)).toBe(true);
    });

    it('unloads a plugin that was loaded disabled without a worker to stop', async () => {
      const manifest = makeManifest();
      (getPluginStateRepository().isEnabled as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
      await manager.loadPlugin(manifest);

      await expect(manager.unloadPlugin(manifest.id)).resolves.not.toThrow();
      expect(manager.isPluginLoaded(manifest.id)).toBe(false);
    });

    it('disabling an already-disabled plugin is a no-op', async () => {
      const manifest = makeManifest();
      await manager.loadPlugin(manifest);
      await manager.disablePlugin(manifest.id);
      const worker = createdWorkers[0];
      vi.clearAllMocks();

      await manager.disablePlugin(manifest.id);

      expect(worker.stop).not.toHaveBeenCalled();
      expect(eventBridgeMock.unregisterWorker).not.toHaveBeenCalled();
    });
  });

  describe('resource-termination observability (item 3, manager-side)', () => {
    it('drops the plugin from the live surface when ResourceMonitor reports a termination', async () => {
      const manifest = makeManifest();
      await manager.loadPlugin(manifest);
      const worker = createdWorkers[0];
      vi.clearAllMocks();

      const handlers = eventBusHandlers.get('plugin:resource-violation') ?? [];
      expect(handlers.length).toBeGreaterThan(0);
      handlers.forEach((h) => h({ data: { pluginId: manifest.id, action: 'terminated' } }));

      // The worker was already stopped by ResourceMonitor — the manager must
      // not call stop() again, only tear down what still thinks it's live.
      expect(worker.stop).not.toHaveBeenCalled();
      expect(eventBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(toolBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(serviceBridgeMock.unregisterWorker).toHaveBeenCalledWith(manifest.id);
      expect(permissionGateMock.unregisterPlugin).toHaveBeenCalledWith(manifest.id);
      expect(manager.isPluginEnabled(manifest.id)).toBe(false);

      // Transient policy action, not a user choice — must not persist as
      // "disabled" so the plugin comes back on next launch.
      expect(getPluginStateRepository().setEnabled).not.toHaveBeenCalled();
    });

    it('ignores resource-violation events that are only warnings', async () => {
      const manifest = makeManifest();
      await manager.loadPlugin(manifest);
      vi.clearAllMocks();

      const handlers = eventBusHandlers.get('plugin:resource-violation') ?? [];
      handlers.forEach((h) => h({ data: { pluginId: manifest.id, action: 'warning' } }));

      expect(manager.isPluginEnabled(manifest.id)).toBe(true);
      expect(eventBridgeMock.unregisterWorker).not.toHaveBeenCalled();
    });
  });
  /**
   * Uninstall derives the directory from the plugin id when nothing is
   * loaded under that id — a guess about what occupies the path, followed by
   * an unconditional recursive delete. Install already refuses to overwrite a
   * directory another plugin claims; this is the same guard on the way out.
   */
  describe('removeUserPlugin ownership', () => {
    const fsMock = fs as unknown as {
      existsSync: ReturnType<typeof vi.fn>;
      readFileSync: ReturnType<typeof vi.fn>;
      rmSync: ReturnType<typeof vi.fn>;
    };

    const occupiedBy = (id: string | null) => {
      fsMock.existsSync.mockImplementation(() => true);
      fsMock.readFileSync.mockImplementation((p: string) =>
        String(p).endsWith('plugin.json') && id ? JSON.stringify({ id }) : '{}',
      );
    };

    it('deletes the directory when its manifest claims the plugin being removed', async () => {
      occupiedBy('com.alice.notes');
      await manager.removeUserPlugin('com.alice.notes');
      expect(fsMock.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('com-alice-notes'),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('refuses when the directory is claimed by a different plugin', async () => {
      occupiedBy('com.alice.notes');
      await expect(manager.removeUserPlugin('org.bob.notes')).rejects.toThrow(/different plugin/);
      expect(fsMock.rmSync).not.toHaveBeenCalled();
    });

    it('refuses when nothing there identifies itself', async () => {
      occupiedBy(null);
      await expect(manager.removeUserPlugin('com.alice.notes')).rejects.toThrow(/not identifiable/);
      expect(fsMock.rmSync).not.toHaveBeenCalled();
    });

    it('trusts the folder a loaded plugin was actually discovered in', async () => {
      // No manifest read is needed here: folderName came from discovery, not
      // from guessing at the id.
      const manifest = makeManifest({ id: 'com.alice.notes', folderName: 'legacy-folder' });
      await manager.loadPlugin(manifest);
      occupiedBy(null);

      await manager.removeUserPlugin('com.alice.notes');

      expect(fsMock.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('legacy-folder'),
        expect.objectContaining({ recursive: true }),
      );
    });
  });
});
