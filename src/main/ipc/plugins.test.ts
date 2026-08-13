/**
 * Plugin IPC Handlers Tests
 *
 * Tests for all IPC handlers in plugins.ts including:
 * - Plugin listing and views
 * - Plugin enable/disable/reload
 * - Plugin configuration
 * - Plugin tools and events
 * - Service registry
 * - Event history
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import { registerPluginHandlers } from './plugins';
import { eventBus } from '../services/EventBus';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  // Included so transitively-loaded modules (database → app.getPath) resolve
  // regardless of test order — otherwise this suite fails in isolation.
  app: {
    getPath: (name: string) => (name === 'temp' ? '/tmp' : '/tmp/enclave-plugins-test'),
  },
}));

// Mock EventBus
vi.mock('../services/EventBus', () => ({
  eventBus: {
    emitEvent: vi.fn(),
    onEvent: vi.fn(),
    getEventHistory: vi.fn(() => []),
    clearHistory: vi.fn(),
  },
}));

// Mock logger
vi.mock('../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Create mock plugin managers
const createMockPluginManager = () => ({
  getPluginsWithState: vi.fn(() => []),
  getRegisteredViews: vi.fn(() => []),
  getRegisteredTerminalViews: vi.fn(() => []),
  getLoadedPlugins: vi.fn(() => []),
  reloadPlugin: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  executePluginTool: vi.fn(),
});

const createMockPluginConfigManager = () => ({
  getConfig: vi.fn(() => ({})),
  setConfig: vi.fn(),
});

let mockPluginManager: ReturnType<typeof createMockPluginManager>;
let mockPluginConfigManager: ReturnType<typeof createMockPluginConfigManager>;

// Mock PluginManager (now using SandboxedPluginManager)
vi.mock('../services/sandbox', async () => {
  // Delegate to the real anti-forgery predicate so the deny-list under test is
  // the actual one, not a stub that could drift from HOST_EVENT_NAMESPACES.
  const { isHostOwnedEventType } = await vi.importActual<
    typeof import('../services/sandbox/EventBridge')
  >('../services/sandbox/EventBridge');
  return {
    getSandboxedPluginManager: () => mockPluginManager,
    isHostOwnedEventType,
  };
});

vi.mock('../services/PluginConfigManager', () => ({
  getPluginConfigManager: () => mockPluginConfigManager,
}));

const mockServiceRegistry = {
  discover: vi.fn(() => []),
  getAllRegistrations: vi.fn(() => []),
  getServiceTypes: vi.fn(() => []),
  hasProviders: vi.fn(() => false),
  call: vi.fn(),
};
vi.mock('../services/ServiceRegistry', () => ({
  getServiceRegistry: () => mockServiceRegistry,
}));

// Mock validation (use real implementation for actual validation)
vi.mock('../../shared/validation', async () => {
  const actual = await vi.importActual('../../shared/validation');
  return actual;
});

describe('Plugin IPC Handlers', () => {
  let handlers: Map<string, Function>;
  let mockEvent: any;
  let mockMainWindow: BrowserWindow | null;
  let getMainWindow: () => BrowserWindow | null;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockPluginManager = createMockPluginManager();
    mockPluginConfigManager = createMockPluginConfigManager();

    // Create handlers map
    handlers = new Map();

    // Mock ipcMain.handle to capture handlers
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
      return ipcMain;
    });

    // Create mock event
    mockEvent = {
      sender: {
        send: vi.fn(),
      },
    };

    // Create mock window
    mockMainWindow = {
      webContents: {
        send: vi.fn(),
      },
    } as any;

    getMainWindow = () => mockMainWindow;

    vi.clearAllMocks();

    // Register handlers
    registerPluginHandlers(getMainWindow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('get-plugins', () => {
    it('should return plugins with view information', async () => {
      const mockPlugins = [
        { id: 'plugin-1', name: 'Plugin 1', enabled: true },
        { id: 'plugin-2', name: 'Plugin 2', enabled: false },
      ];
      const mockViews = [
        { id: 'view-1', pluginId: 'plugin-1', name: 'View 1' },
      ];

      mockPluginManager.getPluginsWithState.mockReturnValue(mockPlugins);
      mockPluginManager.getRegisteredViews.mockReturnValue(mockViews);

      const handler = handlers.get('get-plugins')!;
      const result = await handler(mockEvent);

      expect(result).toEqual([
        { ...mockPlugins[0], hasView: true, viewId: 'view-1' },
        { ...mockPlugins[1], hasView: false, viewId: undefined },
      ]);
    });

    it('should handle plugins with no views', async () => {
      const mockPlugins = [{ id: 'plugin-1', name: 'Plugin 1', enabled: true }];
      mockPluginManager.getPluginsWithState.mockReturnValue(mockPlugins);
      mockPluginManager.getRegisteredViews.mockReturnValue([]);

      const handler = handlers.get('get-plugins')!;
      const result = await handler(mockEvent);

      expect(result[0].hasView).toBe(false);
      expect(result[0].viewId).toBeUndefined();
    });
  });

  describe('get-plugin-views', () => {
    it('should return views from enabled non-import plugins', async () => {
      const mockPlugins = [
        { id: 'plugin-1', name: 'Plugin 1', enabled: true, type: 'ui' },
        { id: 'plugin-2', name: 'Plugin 2', enabled: true, type: 'import' },
        { id: 'plugin-3', name: 'Plugin 3', enabled: false, type: 'ui' },
      ];
      const mockViews = [
        { id: 'view-1', pluginId: 'plugin-1', name: 'View 1' },
        { id: 'view-2', pluginId: 'plugin-2', name: 'View 2' },
        { id: 'view-3', pluginId: 'plugin-3', name: 'View 3' },
      ];
      const mockManifests = [
        { id: 'plugin-1', ui: { entry: 'index.js' }, folderName: 'plugin-1' },
      ];

      mockPluginManager.getPluginsWithState.mockReturnValue(mockPlugins);
      mockPluginManager.getRegisteredViews.mockReturnValue(mockViews);
      mockPluginManager.getLoadedPlugins.mockReturnValue(mockManifests);

      const handler = handlers.get('get-plugin-views')!;
      const result = await handler(mockEvent);

      // Should only include view-1 (enabled, non-import)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('view-1');
      expect(result[0].uiMetadata).toEqual({ entry: 'index.js' });
      expect(result[0].folderName).toBe('plugin-1');
    });

    it('should exclude import plugins', async () => {
      const mockPlugins = [
        { id: 'import-plugin', name: 'Import', enabled: true, type: 'import' },
      ];
      const mockViews = [
        { id: 'view-1', pluginId: 'import-plugin', name: 'View' },
      ];

      mockPluginManager.getPluginsWithState.mockReturnValue(mockPlugins);
      mockPluginManager.getRegisteredViews.mockReturnValue(mockViews);
      mockPluginManager.getLoadedPlugins.mockReturnValue([]);

      const handler = handlers.get('get-plugin-views')!;
      const result = await handler(mockEvent);

      expect(result).toHaveLength(0);
    });
  });

  describe('get-plugin-terminal-views', () => {
    it('should return registered terminal views', async () => {
      const mockTerminalViews = [
        { id: 'term-1', pluginId: 'plugin-1', name: 'Terminal 1' },
      ];

      mockPluginManager.getRegisteredTerminalViews.mockReturnValue(mockTerminalViews);

      const handler = handlers.get('get-plugin-terminal-views')!;
      const result = await handler(mockEvent);

      expect(result).toEqual(mockTerminalViews);
    });
  });

  describe('get-import-plugin-views', () => {
    it('should return views from enabled import plugins', async () => {
      const mockPlugins = [
        { id: 'plugin-1', name: 'Plugin 1', enabled: true, type: 'import', description: 'Import plugin' },
        { id: 'plugin-2', name: 'Plugin 2', enabled: true, type: 'ui' },
      ];
      const mockViews = [
        { id: 'view-1', pluginId: 'plugin-1', name: 'View 1' },
        { id: 'view-2', pluginId: 'plugin-2', name: 'View 2' },
      ];
      const mockManifests = [
        { id: 'plugin-1', ui: { entry: 'index.js' }, folderName: 'plugin-1' },
      ];

      mockPluginManager.getPluginsWithState.mockReturnValue(mockPlugins);
      mockPluginManager.getRegisteredViews.mockReturnValue(mockViews);
      mockPluginManager.getLoadedPlugins.mockReturnValue(mockManifests);

      const handler = handlers.get('get-import-plugin-views')!;
      const result = await handler(mockEvent);

      // Should only include view-1 (import plugin)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('view-1');
      expect(result[0].description).toBe('Import plugin');
      expect(result[0].uiMetadata).toEqual({ entry: 'index.js' });
    });
  });

  describe('reload-plugin', () => {
    it('should reload plugin with valid ID', async () => {
      mockPluginManager.reloadPlugin.mockResolvedValue(undefined);

      const handler = handlers.get('reload-plugin')!;
      const result = await handler(mockEvent, 'test-plugin');

      expect(mockPluginManager.reloadPlugin).toHaveBeenCalledWith('test-plugin');
      expect(result).toEqual({ success: true });
    });

    it('should reject invalid plugin ID', async () => {
      const handler = handlers.get('reload-plugin')!;
      const result = await handler(mockEvent, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockPluginManager.reloadPlugin).not.toHaveBeenCalled();
    });

    it('should reject plugin ID with invalid characters', async () => {
      const handler = handlers.get('reload-plugin')!;
      const result = await handler(mockEvent, 'plugin@invalid');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle reload errors', async () => {
      mockPluginManager.reloadPlugin.mockRejectedValue(new Error('Reload failed'));

      const handler = handlers.get('reload-plugin')!;
      const result = await handler(mockEvent, 'test-plugin');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Reload failed');
    });
  });

  describe('enable-plugin', () => {
    it('should enable plugin and notify views changed', async () => {
      mockPluginManager.enablePlugin.mockResolvedValue(undefined);

      const handler = handlers.get('enable-plugin')!;
      const result = await handler(mockEvent, 'test-plugin');

      expect(mockPluginManager.enablePlugin).toHaveBeenCalledWith('test-plugin');
      expect(mockEvent.sender.send).toHaveBeenCalledWith('plugin-views-changed');
      expect(result).toEqual({ success: true });
    });

    it('should reject invalid plugin ID', async () => {
      const handler = handlers.get('enable-plugin')!;
      const result = await handler(mockEvent, '');

      expect(result.success).toBe(false);
      expect(mockPluginManager.enablePlugin).not.toHaveBeenCalled();
    });
  });

  describe('disable-plugin', () => {
    it('should disable plugin and notify views changed', async () => {
      mockPluginManager.disablePlugin.mockResolvedValue(undefined);

      const handler = handlers.get('disable-plugin')!;
      const result = await handler(mockEvent, 'test-plugin');

      expect(mockPluginManager.disablePlugin).toHaveBeenCalledWith('test-plugin');
      expect(mockEvent.sender.send).toHaveBeenCalledWith('plugin-views-changed');
      expect(result).toEqual({ success: true });
    });

    it('should reject invalid plugin ID', async () => {
      const handler = handlers.get('disable-plugin')!;
      const result = await handler(mockEvent, '');

      expect(result.success).toBe(false);
      expect(mockPluginManager.disablePlugin).not.toHaveBeenCalled();
    });
  });

  describe('toggle-plugin', () => {
    it('should enable plugin when enabled is true', async () => {
      mockPluginManager.enablePlugin.mockResolvedValue(undefined);

      const handler = handlers.get('toggle-plugin')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', enabled: true });

      expect(mockPluginManager.enablePlugin).toHaveBeenCalledWith('test-plugin');
      expect(mockPluginManager.disablePlugin).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should disable plugin when enabled is false', async () => {
      mockPluginManager.disablePlugin.mockResolvedValue(undefined);

      const handler = handlers.get('toggle-plugin')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', enabled: false });

      expect(mockPluginManager.disablePlugin).toHaveBeenCalledWith('test-plugin');
      expect(mockPluginManager.enablePlugin).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should reject invalid plugin ID', async () => {
      const handler = handlers.get('toggle-plugin')!;
      const result = await handler(mockEvent, { pluginId: '', enabled: true });

      expect(result.success).toBe(false);
      expect(mockPluginManager.enablePlugin).not.toHaveBeenCalled();
    });

    it('should reject non-boolean enabled parameter', async () => {
      const handler = handlers.get('toggle-plugin')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', enabled: 'invalid' });

      expect(result.success).toBe(false);
    });

    it('should handle toggle errors', async () => {
      mockPluginManager.enablePlugin.mockRejectedValue(new Error('Enable failed'));

      const handler = handlers.get('toggle-plugin')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', enabled: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Enable failed');
    });
  });

  describe('get-event-history', () => {
    it('should return all events when no filter provided', async () => {
      const mockEvents = [
        { type: 'event1', timestamp: 1000, source: 'test', data: { foo: 'bar' } },
        { type: 'event2', timestamp: 2000, source: 'test2', data: { baz: 'qux' } },
      ];

      // eventBus is already imported and mocked
      eventBus.getEventHistory.mockReturnValue(mockEvents);

      const handler = handlers.get('get-event-history')!;
      const result = await handler(mockEvent, undefined);

      expect(eventBus.getEventHistory).toHaveBeenCalledWith(undefined);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('event1');
      expect(result[0].data).toEqual({ foo: 'bar' });
    });

    it('should filter events by type', async () => {
      const mockEvents = [
        { type: 'plugin:loaded', timestamp: 1000, source: 'test', data: {} },
      ];

      // eventBus is already imported and mocked
      eventBus.getEventHistory.mockReturnValue(mockEvents);

      const handler = handlers.get('get-event-history')!;
      const result = await handler(mockEvent, 'plugin:loaded');

      expect(eventBus.getEventHistory).toHaveBeenCalledWith('plugin:loaded');
    });

    it('should reject invalid filter type', async () => {
      const handler = handlers.get('get-event-history')!;
      const result = await handler(mockEvent, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should serialize Error objects in event data', async () => {
      const error = new Error('Test error');
      const mockEvents = [
        { type: 'error', timestamp: 1000, source: 'test', data: { error } },
      ];

      // eventBus is already imported and mocked
      eventBus.getEventHistory.mockReturnValue(mockEvents);

      const handler = handlers.get('get-event-history')!;
      const result = await handler(mockEvent, undefined);

      expect(result[0].data.error).toEqual({
        name: 'Error',
        message: 'Test error',
        stack: error.stack,
      });
    });

    it('should skip functions in event data', async () => {
      const mockEvents = [
        {
          type: 'test',
          timestamp: 1000,
          source: 'test',
          data: {
            value: 'keep',
            fn: () => 'skip'
          }
        },
      ];

      // eventBus is already imported and mocked
      eventBus.getEventHistory.mockReturnValue(mockEvents);

      const handler = handlers.get('get-event-history')!;
      const result = await handler(mockEvent, undefined);

      expect(result[0].data.value).toBe('keep');
      expect(result[0].data.fn).toBeUndefined();
    });

    it('should handle events without data', async () => {
      const mockEvents = [
        { type: 'test', timestamp: 1000, source: 'test' },
      ];

      // eventBus is already imported and mocked
      eventBus.getEventHistory.mockReturnValue(mockEvents);

      const handler = handlers.get('get-event-history')!;
      const result = await handler(mockEvent, undefined);

      expect(result[0].data).toBeUndefined();
    });
  });

  describe('subscribe-to-events', () => {
    it('should return success', async () => {
      const handler = handlers.get('subscribe-to-events')!;
      const result = await handler(mockEvent);

      expect(result).toEqual({ success: true });
    });
  });

  describe('clear-event-history', () => {
    it('should clear event history', async () => {
      // eventBus is already imported and mocked

      const handler = handlers.get('clear-event-history')!;
      const result = await handler(mockEvent);

      expect(eventBus.clearHistory).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('plugin:event', () => {
    it('should emit event with data', async () => {
      // eventBus is already imported and mocked

      const handler = handlers.get('plugin:event')!;
      const result = await handler(mockEvent, { event: 'test-event', data: { foo: 'bar' } });

      // Renderer emits are stamped 'plugin-ui', never 'core'.
      expect(eventBus.emitEvent).toHaveBeenCalledWith('test-event', { foo: 'bar' }, 'plugin-ui');
      expect(result).toEqual({ success: true });
    });

    it('should emit event without data', async () => {
      // eventBus is already imported and mocked

      const handler = handlers.get('plugin:event')!;
      const result = await handler(mockEvent, { event: 'test-event' });

      expect(eventBus.emitEvent).toHaveBeenCalledWith('test-event', undefined, 'plugin-ui');
      expect(result).toEqual({ success: true });
    });

    it('should block emit of a host-owned event type (anti-forgery)', async () => {
      const handler = handlers.get('plugin:event')!;
      const result = await handler(mockEvent, { event: 'message:created', data: { forged: true } });

      expect(result.success).toBe(false);
      expect(result.error).toContain('host-owned');
      expect(eventBus.emitEvent).not.toHaveBeenCalled();
    });

    it('should reject invalid event name', async () => {
      const handler = handlers.get('plugin:event')!;
      const result = await handler(mockEvent, { event: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject missing event field', async () => {
      const handler = handlers.get('plugin:event')!;
      const result = await handler(mockEvent, { data: {} });

      expect(result.success).toBe(false);
    });
  });

  describe('execute-plugin-tool', () => {
    it('should execute plugin tool with args', async () => {
      mockPluginManager.executePluginTool.mockResolvedValue({ result: 'success' });

      const handler = handlers.get('execute-plugin-tool')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', toolName: 'my-tool', args: { input: 'test' } });

      expect(mockPluginManager.executePluginTool).toHaveBeenCalledWith(
        'test-plugin',
        'my-tool',
        { input: 'test' }
      );
      expect(result).toEqual({ result: 'success' });
    });

    it('should reject invalid plugin ID', async () => {
      const handler = handlers.get('execute-plugin-tool')!;
      const result = await handler(mockEvent, { pluginId: '', toolName: 'tool', args: {} });

      expect(result.success).toBe(false);
      expect(mockPluginManager.executePluginTool).not.toHaveBeenCalled();
    });

    it('should reject invalid tool name', async () => {
      const handler = handlers.get('execute-plugin-tool')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', toolName: '', args: {} });

      expect(result.success).toBe(false);
      expect(mockPluginManager.executePluginTool).not.toHaveBeenCalled();
    });

    it('should handle tool execution errors', async () => {
      mockPluginManager.executePluginTool.mockRejectedValue(new Error('Tool failed'));

      const handler = handlers.get('execute-plugin-tool')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', toolName: 'my-tool', args: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Tool failed');
    });

    it('should accept any valid args object', async () => {
      mockPluginManager.executePluginTool.mockResolvedValue({ result: 'ok' });

      const handler = handlers.get('execute-plugin-tool')!;
      await handler(mockEvent, { pluginId: 'test-plugin', toolName: 'tool', args: { complex: { nested: { data: [1, 2, 3] } } } });

      expect(mockPluginManager.executePluginTool).toHaveBeenCalledWith(
        'test-plugin',
        'tool',
        { complex: { nested: { data: [1, 2, 3] } } }
      );
    });
  });

  describe('get-plugin-config', () => {
    it('should return plugin config with schema and values', async () => {
      const mockPlugins = [
        {
          id: 'test-plugin',
          name: 'Test Plugin',
          config: {
            apiKey: { type: 'string', description: 'API Key' },
          },
        },
      ];
      const mockUserConfig = { apiKey: 'secret' };

      mockPluginManager.getPluginsWithState.mockReturnValue(mockPlugins);
      mockPluginConfigManager.getConfig.mockReturnValue(mockUserConfig);

      const handler = handlers.get('get-plugin-config')!;
      const result = await handler(mockEvent, 'test-plugin');

      expect(result).toEqual({
        schema: mockPlugins[0].config,
        values: mockUserConfig,
        pluginId: 'test-plugin',
        pluginName: 'Test Plugin',
      });
    });

    it('should reject invalid plugin ID', async () => {
      const handler = handlers.get('get-plugin-config')!;

      const result = await handler(mockEvent, '');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error if plugin not found', async () => {
      mockPluginManager.getPluginsWithState.mockReturnValue([]);

      const handler = handlers.get('get-plugin-config')!;
      const result = await handler(mockEvent, 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Plugin nonexistent not found');
    });

    it('should handle plugin with no config schema', async () => {
      const mockPlugins = [
        {
          id: 'test-plugin',
          name: 'Test Plugin',
          // No config field
        },
      ];

      mockPluginManager.getPluginsWithState.mockReturnValue(mockPlugins);
      mockPluginConfigManager.getConfig.mockReturnValue({});

      const handler = handlers.get('get-plugin-config')!;
      const result = await handler(mockEvent, 'test-plugin');

      expect(result.schema).toEqual({});
    });
  });

  describe('set-plugin-config', () => {
    // A write is now checked against what the installed plugin declares, so
    // every case here needs a plugin that actually exists and a schema.
    const installTestPlugin = () => {
      mockPluginManager.getPluginsWithState.mockReturnValue([
        {
          id: 'test-plugin',
          name: 'Test Plugin',
          config: { apiKey: { type: 'string' }, retries: { type: 'number' } },
        },
      ]);
    };

    it('should set config, reload plugin, and notify views changed', async () => {
      installTestPlugin();
      mockPluginConfigManager.setConfig.mockReturnValue(undefined);
      mockPluginManager.reloadPlugin.mockResolvedValue(undefined);

      const handler = handlers.get('set-plugin-config')!;
      const result = await handler(mockEvent, { pluginId: 'test-plugin', config: { apiKey: 'new-key' } });

      expect(mockPluginConfigManager.setConfig).toHaveBeenCalledWith('test-plugin', { apiKey: 'new-key' });
      expect(mockPluginManager.reloadPlugin).toHaveBeenCalledWith('test-plugin');
      expect(mockEvent.sender.send).toHaveBeenCalledWith('plugin-views-changed');
      expect(result).toEqual({ success: true });
    });

    it('should reject invalid plugin ID', async () => {
      const handler = handlers.get('set-plugin-config')!;
      const result = await handler(mockEvent, { pluginId: '', config: {} });

      expect(result.success).toBe(false);
      expect(mockPluginConfigManager.setConfig).not.toHaveBeenCalled();
    });

    it('should accept every setting the plugin declares', async () => {
      installTestPlugin();
      mockPluginManager.reloadPlugin.mockResolvedValue(undefined);

      const handler = handlers.get('set-plugin-config')!;
      await handler(mockEvent, { pluginId: 'test-plugin', config: { apiKey: 'value', retries: 3 } });

      expect(mockPluginConfigManager.setConfig).toHaveBeenCalledWith('test-plugin', {
        apiKey: 'value',
        retries: 3,
      });
    });

    // Previously this handler wrote whatever it was handed, to any id, and
    // then reloaded the plugin so the worker picked it up.
    it('refuses a key the plugin never declared', async () => {
      installTestPlugin();

      const handler = handlers.get('set-plugin-config')!;
      const result = await handler(mockEvent, {
        pluginId: 'test-plugin',
        config: { apiKey: 'ok', proxy: 'http://attacker' },
      });

      expect(result.success).toBe(false);
      expect(mockPluginConfigManager.setConfig).not.toHaveBeenCalled();
      expect(mockPluginManager.reloadPlugin).not.toHaveBeenCalled();
    });

    it('refuses a declared key written with the wrong type', async () => {
      installTestPlugin();

      const handler = handlers.get('set-plugin-config')!;
      const result = await handler(mockEvent, {
        pluginId: 'test-plugin',
        config: { retries: 'lots' },
      });

      expect(result.success).toBe(false);
      expect(mockPluginConfigManager.setConfig).not.toHaveBeenCalled();
    });

    it('refuses a write to a plugin that is not installed', async () => {
      mockPluginManager.getPluginsWithState.mockReturnValue([]);

      const handler = handlers.get('set-plugin-config')!;
      const result = await handler(mockEvent, { pluginId: 'ghost-plugin', config: {} });

      expect(result.success).toBe(false);
      expect(mockPluginConfigManager.setConfig).not.toHaveBeenCalled();
    });
  });

  describe('discover-services', () => {
    it('should discover services by type', async () => {
      const mockServices = [
        { id: 'service-1', type: 'storage' },
      ];

      mockServiceRegistry.discover.mockReturnValue(mockServices);

      const handler = handlers.get('discover-services')!;
      const result = await handler(mockEvent, 'storage');

      expect(mockServiceRegistry.discover).toHaveBeenCalledWith('storage');
      expect(result).toEqual(mockServices);
    });

    it('should reject empty service type', async () => {
      const handler = handlers.get('discover-services')!;
      const result = await handler(mockEvent, '');

      expect(result.success).toBe(false);
      expect(mockServiceRegistry.discover).not.toHaveBeenCalled();
    });

    it('should reject service type that is too long', async () => {
      const handler = handlers.get('discover-services')!;
      const longType = 'a'.repeat(101);
      const result = await handler(mockEvent, longType);

      expect(result.success).toBe(false);
    });
  });

  describe('get-registered-services', () => {
    it('should return all registered services', async () => {
      const mockServices = [
        { id: 'service-1', type: 'storage' },
        { id: 'service-2', type: 'auth' },
      ];

      mockServiceRegistry.getAllRegistrations.mockReturnValue(mockServices);

      const handler = handlers.get('get-registered-services')!;
      const result = await handler(mockEvent);

      expect(result).toEqual(mockServices);
    });
  });

  describe('get-service-types', () => {
    it('should return all service types', async () => {
      const mockTypes = ['storage', 'auth', 'network'];

      mockServiceRegistry.getServiceTypes.mockReturnValue(mockTypes);

      const handler = handlers.get('get-service-types')!;
      const result = await handler(mockEvent);

      expect(result).toEqual(mockTypes);
    });
  });

  describe('has-service-providers', () => {
    it('should return true when providers exist', async () => {
      mockServiceRegistry.hasProviders.mockReturnValue(true);

      const handler = handlers.get('has-service-providers')!;
      const result = await handler(mockEvent, 'storage');

      expect(mockServiceRegistry.hasProviders).toHaveBeenCalledWith('storage');
      expect(result).toBe(true);
    });

    it('should return false when no providers exist', async () => {
      mockServiceRegistry.hasProviders.mockReturnValue(false);

      const handler = handlers.get('has-service-providers')!;
      const result = await handler(mockEvent, 'unknown');

      expect(result).toBe(false);
    });

    it('should reject invalid service type', async () => {
      const handler = handlers.get('has-service-providers')!;
      const result = await handler(mockEvent, '');

      expect(result.success).toBe(false);
      expect(mockServiceRegistry.hasProviders).not.toHaveBeenCalled();
    });
  });

  describe('call-service', () => {
    it('should call service method with args', async () => {
      mockServiceRegistry.call.mockResolvedValue({ data: 'result' });

      const handler = handlers.get('call-service')!;
      const result = await handler(mockEvent, { serviceType: 'storage', method: 'save', args: ['key', 'value'] });

      expect(mockServiceRegistry.call).toHaveBeenCalledWith('storage', 'save', 'key', 'value');
      expect(result).toEqual({ success: true, result: { data: 'result' } });
    });

    it('should handle service call errors', async () => {
      mockServiceRegistry.call.mockRejectedValue(new Error('Service error'));

      const handler = handlers.get('call-service')!;
      const result = await handler(mockEvent, { serviceType: 'storage', method: 'save', args: ['key'] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Service error');
    });

    it('should reject invalid service type', async () => {
      const handler = handlers.get('call-service')!;
      const result = await handler(mockEvent, { serviceType: '', method: 'method', args: [] });

      expect(result.success).toBe(false);
      expect(mockServiceRegistry.call).not.toHaveBeenCalled();
    });

    it('should reject invalid method name', async () => {
      const handler = handlers.get('call-service')!;
      const result = await handler(mockEvent, { serviceType: 'storage', method: '', args: [] });

      expect(result.success).toBe(false);
      expect(mockServiceRegistry.call).not.toHaveBeenCalled();
    });

    it('should accept no args', async () => {
      mockServiceRegistry.call.mockResolvedValue('ok');

      const handler = handlers.get('call-service')!;
      const result = await handler(mockEvent, { serviceType: 'storage', method: 'getAll', args: [] });

      expect(mockServiceRegistry.call).toHaveBeenCalledWith('storage', 'getAll');
      expect(result.success).toBe(true);
    });

    it('should accept multiple args', async () => {
      mockServiceRegistry.call.mockResolvedValue('ok');

      const handler = handlers.get('call-service')!;
      await handler(mockEvent, { serviceType: 'storage', method: 'update', args: ['id', { name: 'test' }, true] });

      expect(mockServiceRegistry.call).toHaveBeenCalledWith(
        'storage',
        'update',
        'id',
        { name: 'test' },
        true
      );
    });
  });

  describe('event forwarding', () => {
    it('should register event forwarding when getMainWindow provided', () => {
      // eventBus is already imported and mocked

      // Should have registered for plugin:ui:toast
      expect(eventBus.onEvent).toHaveBeenCalledWith('plugin:ui:toast', expect.any(Function));

      // Should have registered for plugin:ui:notification
      expect(eventBus.onEvent).toHaveBeenCalledWith('plugin:ui:notification', expect.any(Function));

      // Should have registered for import plugin events
      expect(eventBus.onEvent).toHaveBeenCalledWith('chatgpt-import:progress', expect.any(Function));
      expect(eventBus.onEvent).toHaveBeenCalledWith('chatgpt-import:complete', expect.any(Function));
    });

    it('should forward plugin:ui:toast to renderer', () => {
      // eventBus is already imported and mocked

      // Find the toast handler
      const toastCall = eventBus.onEvent.mock.calls.find(
        (call: any) => call[0] === 'plugin:ui:toast'
      );
      expect(toastCall).toBeDefined();

      const handler = toastCall[1];
      handler({ data: { message: 'Test toast' } });

      expect(mockMainWindow?.webContents.send).toHaveBeenCalledWith(
        'plugin:ui:toast',
        { message: 'Test toast' }
      );
    });

    it('should forward plugin:ui:notification to renderer', () => {
      // eventBus is already imported and mocked

      const notificationCall = eventBus.onEvent.mock.calls.find(
        (call: any) => call[0] === 'plugin:ui:notification'
      );
      expect(notificationCall).toBeDefined();

      const handler = notificationCall[1];
      handler({ data: { title: 'Test notification' } });

      expect(mockMainWindow?.webContents.send).toHaveBeenCalledWith(
        'plugin:ui:notification',
        { title: 'Test notification' }
      );
    });

    it('should handle null window gracefully', () => {
      mockMainWindow = null;

      // eventBus is already imported and mocked

      const toastCall = eventBus.onEvent.mock.calls.find(
        (call: any) => call[0] === 'plugin:ui:toast'
      );
      const handler = toastCall[1];

      // Should not throw when window is null
      expect(() => {
        handler({ data: { message: 'Test' } });
      }).not.toThrow();
    });

    it('should not register event forwarding when getMainWindow not provided', () => {
      vi.clearAllMocks();

      // Clear handlers and re-register without getMainWindow
      handlers.clear();
      registerPluginHandlers();

      // eventBus is already imported and mocked

      // Should not have registered event listeners
      expect(eventBus.onEvent).not.toHaveBeenCalled();
    });
  });
});