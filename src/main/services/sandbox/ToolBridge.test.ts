/**
 * ToolBridge Tests
 *
 * Tests for tool registration and execution bridging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolBridge, getToolBridge, resetToolBridge } from './ToolBridge';

// Mock EventBus
vi.mock('../EventBus', () => ({
  eventBus: {
    emitEvent: vi.fn(),
  },
}));

// Mock logger
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Create a mock PluginWorker
function createMockWorker(options: { isRunning?: boolean } = {}) {
  const { isRunning = true } = options;
  return {
    isRunning: vi.fn(() => isRunning),
    executeTool: vi.fn().mockResolvedValue({ result: 'success' }),
  };
}

describe('ToolBridge', () => {
  let bridge: ToolBridge;
  let eventBusMock: any;

  beforeEach(async () => {
    bridge = new ToolBridge();
    eventBusMock = (await import('../EventBus')).eventBus;
    vi.clearAllMocks();
  });

  afterEach(() => {
    bridge.clear();
  });

  describe('registerWorker', () => {
    it('should register worker', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      // Worker is registered (we can verify by trying to register a tool)
      bridge.registerTool('plugin-1', 'test-tool', { description: 'test' });
      expect(bridge.hasTool('plugin-1__test-tool')).toBe(true);
    });
  });

  describe('unregisterWorker', () => {
    it('should cleanup tools when unregistering worker', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'tool-1', { description: 'Tool 1' });
      bridge.registerTool('plugin-1', 'tool-2', { description: 'Tool 2' });

      expect(bridge.totalTools).toBe(2);

      bridge.unregisterWorker('plugin-1');

      expect(bridge.totalTools).toBe(0);
    });
  });

  describe('registerTool', () => {
    it('should register a tool with namespaced name', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      bridge.registerTool('plugin-1', 'my-tool', {
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      });

      expect(bridge.hasTool('plugin-1__my-tool')).toBe(true);
      expect(bridge.getToolPlugin('plugin-1__my-tool')).toBe('plugin-1');
    });

    it('should emit registration event with namespaced name', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      bridge.registerTool('plugin-1', 'my-tool', { description: 'test' });

      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'plugin:tool:registered',
        expect.objectContaining({
          name: 'plugin-1__my-tool',
          pluginId: 'plugin-1',
        })
      );
    });

    it('should not register if worker not found', () => {
      bridge.registerTool('unknown-plugin', 'tool', { description: 'test' });

      expect(bridge.hasTool('unknown-plugin__tool')).toBe(false);
    });

    it('should allow different plugins to register tools with same base name', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      bridge.registerWorker('plugin-1', worker1 as any);
      bridge.registerWorker('plugin-2', worker2 as any);

      bridge.registerTool('plugin-1', 'shared-name', { description: 'first' });
      bridge.registerTool('plugin-2', 'shared-name', { description: 'second' });

      // Both should exist with their namespaced names
      expect(bridge.getToolPlugin('plugin-1__shared-name')).toBe('plugin-1');
      expect(bridge.getToolPlugin('plugin-2__shared-name')).toBe('plugin-2');
      expect(bridge.totalTools).toBe(2);
    });

    it('should allow same plugin to update tool', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      bridge.registerTool('plugin-1', 'my-tool', { description: 'v1' });
      bridge.registerTool('plugin-1', 'my-tool', { description: 'v2' });

      const def = bridge.getToolDefinition('plugin-1__my-tool');
      expect(def?.description).toBe('v2');
    });

    it('emits proxyTool with inputSchema preserved (regression for v6 rename)', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      const schema = {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      };

      bridge.registerTool('plugin-1', 'fetch-thing', {
        description: 'fetch',
        inputSchema: schema,
      });

      const call = (eventBusMock.emitEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        ([eventName]) => eventName === 'plugin:tool:registered',
      );
      expect(call).toBeDefined();
      const proxyTool = call![1].tool;
      expect(proxyTool.inputSchema).toEqual(schema);
      expect(proxyTool.needsApproval).toBe(false);
    });

    it('passes needsApproval through to the proxy tool', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      bridge.registerTool('plugin-1', 'sensitive', {
        description: 'sensitive',
        needsApproval: true,
      });

      const call = (eventBusMock.emitEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        ([eventName]) => eventName === 'plugin:tool:registered',
      );
      expect(call![1].tool.needsApproval).toBe(true);
    });
  });

  describe('unregisterTool', () => {
    it('should unregister a tool', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'my-tool', { description: 'test' });

      const result = bridge.unregisterTool('plugin-1', 'my-tool');

      expect(result).toBe(true);
      expect(bridge.hasTool('plugin-1__my-tool')).toBe(false);
    });

    it('should emit unregistration event with namespaced name', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'my-tool', { description: 'test' });

      vi.clearAllMocks();
      bridge.unregisterTool('plugin-1', 'my-tool');

      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'plugin:tool:unregistered',
        expect.objectContaining({
          name: 'plugin-1__my-tool',
          pluginId: 'plugin-1',
        })
      );
    });

    it('should return false for non-existent tool', () => {
      const result = bridge.unregisterTool('plugin-1', 'unknown');
      expect(result).toBe(false);
    });

    it('should return false if plugin does not own tool', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      bridge.registerWorker('plugin-1', worker1 as any);
      bridge.registerWorker('plugin-2', worker2 as any);

      bridge.registerTool('plugin-1', 'my-tool', { description: 'test' });

      // plugin-2 trying to unregister plugin-1's tool should fail
      const result = bridge.unregisterTool('plugin-2', 'my-tool');
      expect(result).toBe(false);
      expect(bridge.hasTool('plugin-1__my-tool')).toBe(true);
    });
  });

  describe('executeTool', () => {
    it('should execute tool via worker using original name', async () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'my-tool', { description: 'test' });

      const result = await bridge.executeTool('plugin-1__my-tool', { input: 'test' });

      // Worker receives the original (non-namespaced) name
      expect(worker.executeTool).toHaveBeenCalledWith('my-tool', { input: 'test' });
      expect(result).toEqual({ result: 'success' });
    });

    it('should throw for non-existent tool', async () => {
      await expect(bridge.executeTool('unknown', {})).rejects.toThrow("Tool 'unknown' not found");
    });

    it('should throw if worker not running', async () => {
      const worker = createMockWorker({ isRunning: false });
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'my-tool', { description: 'test' });

      await expect(bridge.executeTool('plugin-1__my-tool', {})).rejects.toThrow('not running');
    });
  });

  describe('getToolDefinition', () => {
    it('should return tool definition', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'my-tool', {
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string' } },
        },
      });

      const def = bridge.getToolDefinition('plugin-1__my-tool');

      expect(def).toEqual({
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string' } },
        },
      });
    });

    it('should return null for non-existent tool', () => {
      expect(bridge.getToolDefinition('unknown')).toBeNull();
    });
  });

  describe('getPluginTools', () => {
    it('should return all namespaced tools for a plugin', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'tool-1', { description: 'Tool 1' });
      bridge.registerTool('plugin-1', 'tool-2', { description: 'Tool 2' });

      const tools = bridge.getPluginTools('plugin-1');

      expect(tools).toContain('plugin-1__tool-1');
      expect(tools).toContain('plugin-1__tool-2');
      expect(tools.length).toBe(2);
    });

    it('should return empty array for unknown plugin', () => {
      expect(bridge.getPluginTools('unknown')).toEqual([]);
    });
  });

  describe('getAllToolNames', () => {
    it('should return all namespaced tool names', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      bridge.registerWorker('plugin-1', worker1 as any);
      bridge.registerWorker('plugin-2', worker2 as any);

      bridge.registerTool('plugin-1', 'tool-a', { description: 'A' });
      bridge.registerTool('plugin-2', 'tool-b', { description: 'B' });

      const names = bridge.getAllToolNames();

      expect(names).toContain('plugin-1__tool-a');
      expect(names).toContain('plugin-2__tool-b');
    });

    it('should return empty array when no tools', () => {
      expect(bridge.getAllToolNames()).toEqual([]);
    });
  });

  describe('cleanupPlugin', () => {
    it('should cleanup all tools for a plugin', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'tool-1', { description: 'Tool 1' });
      bridge.registerTool('plugin-1', 'tool-2', { description: 'Tool 2' });
      bridge.registerTool('plugin-1', 'tool-3', { description: 'Tool 3' });

      const count = bridge.cleanupPlugin('plugin-1');

      expect(count).toBe(3);
      expect(bridge.totalTools).toBe(0);
    });

    it('should emit unregistration events for each tool', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerTool('plugin-1', 'tool-1', { description: 'Tool 1' });
      bridge.registerTool('plugin-1', 'tool-2', { description: 'Tool 2' });

      vi.clearAllMocks();
      bridge.cleanupPlugin('plugin-1');

      expect(eventBusMock.emitEvent).toHaveBeenCalledTimes(2);
    });

    it('should return 0 for unknown plugin', () => {
      expect(bridge.cleanupPlugin('unknown')).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear all tools', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      bridge.registerWorker('plugin-1', worker1 as any);
      bridge.registerWorker('plugin-2', worker2 as any);

      bridge.registerTool('plugin-1', 'tool-a', { description: 'A' });
      bridge.registerTool('plugin-2', 'tool-b', { description: 'B' });

      bridge.clear();

      expect(bridge.totalTools).toBe(0);
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetToolBridge();
  });

  it('getToolBridge should return same instance', () => {
    const bridge1 = getToolBridge();
    const bridge2 = getToolBridge();
    expect(bridge1).toBe(bridge2);
  });

  it('resetToolBridge should clear and reset', () => {
    const bridge1 = getToolBridge();
    const worker = createMockWorker();
    bridge1.registerWorker('plugin-1', worker as any);
    bridge1.registerTool('plugin-1', 'tool', { description: 'test' });

    resetToolBridge();

    const bridge2 = getToolBridge();
    expect(bridge2.totalTools).toBe(0);
  });
});
