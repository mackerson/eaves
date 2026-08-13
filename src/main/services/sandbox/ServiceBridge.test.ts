/**
 * ServiceBridge Tests
 *
 * Tests for cross-plugin service registration and communication.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServiceBridge, getServiceBridge, resetServiceBridge } from './ServiceBridge';

// Mock ServiceRegistry
const mockServiceRegistry = {
  register: vi.fn(),
  unregister: vi.fn(),
  discover: vi.fn().mockReturnValue([]),
  hasProviders: vi.fn().mockReturnValue(false),
};

vi.mock('../ServiceRegistry', () => ({
  getServiceRegistry: () => mockServiceRegistry,
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

describe('ServiceBridge', () => {
  let bridge: ServiceBridge;

  beforeEach(() => {
    bridge = new ServiceBridge();
    vi.clearAllMocks();
  });

  afterEach(() => {
    bridge.clear();
  });

  describe('registerWorker', () => {
    it('should register worker', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      // Worker is registered - can register services
      bridge.registerService('plugin-1', 'test-service', ['method1'], {});
      expect(bridge.totalServices).toBe(1);
    });
  });

  describe('unregisterWorker', () => {
    it('should cleanup services when unregistering worker', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'service-1', ['method1'], {});
      bridge.registerService('plugin-1', 'service-2', ['method2'], {});

      expect(bridge.totalServices).toBe(2);

      bridge.unregisterWorker('plugin-1');

      expect(bridge.totalServices).toBe(0);
    });
  });

  describe('registerService', () => {
    it('should register a service', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      bridge.registerService('plugin-1', 'memory-backend', ['store', 'retrieve', 'search'], {
        version: '1.0',
        features: ['metadata'],
      });

      expect(bridge.totalServices).toBe(1);
    });

    it('should register with main ServiceRegistry', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);

      bridge.registerService('plugin-1', 'memory-backend', ['store', 'retrieve'], {
        version: '1.0',
      });

      expect(mockServiceRegistry.register).toHaveBeenCalledWith(
        'plugin-1',
        'memory-backend',
        expect.any(Object), // proxy API
        expect.objectContaining({ version: '1.0' })
      );
    });

    it('should not register if worker not found', () => {
      bridge.registerService('unknown', 'service', ['method'], {});
      expect(bridge.totalServices).toBe(0);
    });
  });

  describe('unregisterService', () => {
    it('should unregister a service', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'my-service', ['method1'], {});

      const result = bridge.unregisterService('plugin-1', 'my-service');

      expect(result).toBe(true);
      expect(bridge.totalServices).toBe(0);
    });

    it('should unregister from main ServiceRegistry', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'my-service', ['method1'], {});

      vi.clearAllMocks();
      bridge.unregisterService('plugin-1', 'my-service');

      expect(mockServiceRegistry.unregister).toHaveBeenCalledWith('plugin-1', 'my-service');
    });

    it('should return false for non-existent service', () => {
      const result = bridge.unregisterService('plugin-1', 'unknown');
      expect(result).toBe(false);
    });
  });

  describe('callServiceMethod', () => {
    it('should call service method via worker', async () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'my-service', ['doSomething'], {});

      await bridge.callServiceMethod('my-service', 'plugin-1', 'doSomething', ['arg1', 'arg2']);

      expect(worker.executeTool).toHaveBeenCalledWith(
        'service:my-service:doSomething',
        expect.objectContaining({ args: ['arg1', 'arg2'] })
      );
    });

    it('should throw for non-existent service', async () => {
      await expect(
        bridge.callServiceMethod('unknown', 'plugin-1', 'method', [])
      ).rejects.toThrow('not found');
    });

    it('should throw for non-existent method', async () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'my-service', ['method1'], {});

      await expect(
        bridge.callServiceMethod('my-service', 'plugin-1', 'unknownMethod', [])
      ).rejects.toThrow("Method 'unknownMethod' not found");
    });

    it('should throw if worker not running', async () => {
      const worker = createMockWorker({ isRunning: false });
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'my-service', ['method1'], {});

      await expect(
        bridge.callServiceMethod('my-service', 'plugin-1', 'method1', [])
      ).rejects.toThrow('not running');
    });
  });

  describe('getServiceMethods', () => {
    it('should return method names for a service', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'my-service', ['method1', 'method2', 'method3'], {});

      const methods = bridge.getServiceMethods('my-service', 'plugin-1');

      expect(methods).toContain('method1');
      expect(methods).toContain('method2');
      expect(methods).toContain('method3');
    });

    it('should return null for non-existent service', () => {
      expect(bridge.getServiceMethods('unknown', 'plugin-1')).toBeNull();
    });
  });

  describe('discover', () => {
    it('should delegate to ServiceRegistry', () => {
      mockServiceRegistry.discover.mockReturnValue([
        { pluginId: 'plugin-1', serviceType: 'memory-backend', metadata: {} },
      ]);

      const providers = bridge.discover('memory-backend');

      expect(mockServiceRegistry.discover).toHaveBeenCalledWith('memory-backend');
      expect(providers).toHaveLength(1);
    });
  });

  describe('hasProviders', () => {
    it('should delegate to ServiceRegistry', () => {
      mockServiceRegistry.hasProviders.mockReturnValue(true);

      const result = bridge.hasProviders('memory-backend');

      expect(mockServiceRegistry.hasProviders).toHaveBeenCalledWith('memory-backend');
      expect(result).toBe(true);
    });
  });

  describe('getDefaultProvider', () => {
    it('should return first provider from discover', () => {
      mockServiceRegistry.discover.mockReturnValue([
        { pluginId: 'plugin-1', serviceType: 'memory-backend', metadata: {} },
        { pluginId: 'plugin-2', serviceType: 'memory-backend', metadata: {} },
      ]);

      const provider = bridge.getDefaultProvider('memory-backend');

      expect(provider?.pluginId).toBe('plugin-1');
    });

    it('should return null when no providers', () => {
      mockServiceRegistry.discover.mockReturnValue([]);

      const provider = bridge.getDefaultProvider('memory-backend');

      expect(provider).toBeNull();
    });
  });

  describe('callDefault', () => {
    it('should call method on default provider', async () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'my-service', ['method1'], {});

      mockServiceRegistry.discover.mockReturnValue([
        { pluginId: 'plugin-1', serviceType: 'my-service', metadata: {} },
      ]);

      await bridge.callDefault('my-service', 'method1', 'arg1');

      expect(worker.executeTool).toHaveBeenCalled();
    });

    it('should throw when no providers', async () => {
      mockServiceRegistry.discover.mockReturnValue([]);

      await expect(
        bridge.callDefault('unknown-service', 'method', 'arg')
      ).rejects.toThrow('No providers found');
    });
  });

  describe('getPluginServices', () => {
    it('should return all service types for a plugin', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'service-a', ['method1'], {});
      bridge.registerService('plugin-1', 'service-b', ['method2'], {});

      const services = bridge.getPluginServices('plugin-1');

      expect(services).toContain('service-a');
      expect(services).toContain('service-b');
    });

    it('should return empty array for unknown plugin', () => {
      expect(bridge.getPluginServices('unknown')).toEqual([]);
    });
  });

  describe('cleanupPlugin', () => {
    it('should cleanup all services for a plugin', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'service-a', ['m1'], {});
      bridge.registerService('plugin-1', 'service-b', ['m2'], {});
      bridge.registerService('plugin-1', 'service-c', ['m3'], {});

      const count = bridge.cleanupPlugin('plugin-1');

      expect(count).toBe(3);
      expect(bridge.totalServices).toBe(0);
    });

    it('should unregister from main ServiceRegistry', () => {
      const worker = createMockWorker();
      bridge.registerWorker('plugin-1', worker as any);
      bridge.registerService('plugin-1', 'service-a', ['m1'], {});
      bridge.registerService('plugin-1', 'service-b', ['m2'], {});

      vi.clearAllMocks();
      bridge.cleanupPlugin('plugin-1');

      expect(mockServiceRegistry.unregister).toHaveBeenCalledTimes(2);
    });

    it('should return 0 for unknown plugin', () => {
      expect(bridge.cleanupPlugin('unknown')).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear all services', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      bridge.registerWorker('plugin-1', worker1 as any);
      bridge.registerWorker('plugin-2', worker2 as any);

      bridge.registerService('plugin-1', 'service-a', ['m1'], {});
      bridge.registerService('plugin-2', 'service-b', ['m2'], {});

      bridge.clear();

      expect(bridge.totalServices).toBe(0);
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetServiceBridge();
  });

  it('getServiceBridge should return same instance', () => {
    const bridge1 = getServiceBridge();
    const bridge2 = getServiceBridge();
    expect(bridge1).toBe(bridge2);
  });

  it('resetServiceBridge should clear and reset', () => {
    const bridge1 = getServiceBridge();
    const worker = createMockWorker();
    bridge1.registerWorker('plugin-1', worker as any);
    bridge1.registerService('plugin-1', 'service', ['m'], {});

    resetServiceBridge();

    const bridge2 = getServiceBridge();
    expect(bridge2.totalServices).toBe(0);
  });
});
