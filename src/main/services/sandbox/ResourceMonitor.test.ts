/**
 * ResourceMonitor Tests
 *
 * Tests for resource tracking and enforcement for plugin workers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ResourceMonitor, getResourceMonitor, resetResourceMonitor } from './ResourceMonitor';
import { DEFAULT_RESOURCE_LIMITS } from './types';

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
  const emitter = new EventEmitter();

  return {
    on: vi.fn((event: string, handler: Function) => {
      emitter.on(event, handler);
    }),
    off: vi.fn((event: string, handler: Function) => {
      emitter.off(event, handler);
    }),
    isRunning: vi.fn(() => isRunning),
    stop: vi.fn().mockResolvedValue(undefined),
    getHealth: vi.fn(() => ({
      state: 'running',
      memoryUsage: { heapUsed: 0, heapTotal: 0, external: 0, percentUsed: 0 },
      activeRequests: 0,
      lastHealthCheck: Date.now(),
      uptime: 1000,
      restartCount: 0,
    })),
    // Helper to simulate health responses
    _emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

describe('ResourceMonitor', () => {
  let monitor: ResourceMonitor;
  let eventBusMock: any;

  beforeEach(async () => {
    monitor = new ResourceMonitor({
      checkIntervalMs: 100, // Fast interval for testing
      warningThreshold: 0.8,
      terminationThreshold: 1.5,
      maxWarningsBeforeTermination: 3,
    });
    eventBusMock = (await import('../EventBus')).eventBus;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    monitor.stop();
    monitor.clear();
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('should start monitoring', () => {
      expect(monitor.running).toBe(false);

      monitor.start();

      expect(monitor.running).toBe(true);
    });

    it('should stop monitoring', () => {
      monitor.start();
      monitor.stop();

      expect(monitor.running).toBe(false);
    });

    it('should not start twice', () => {
      monitor.start();
      monitor.start();

      expect(monitor.running).toBe(true);
    });

    it('should not stop if not running', () => {
      monitor.stop();
      expect(monitor.running).toBe(false);
    });
  });

  describe('track/untrack', () => {
    it('should track a plugin worker', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any);

      expect(monitor.pluginCount).toBe(1);
    });

    it('should set up health response listener', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any);

      expect(worker.on).toHaveBeenCalledWith('health-response', expect.any(Function));
    });

    it('should untrack a plugin', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any);
      monitor.untrack('plugin-1');

      expect(monitor.pluginCount).toBe(0);
    });

    it('should use custom limits', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, {
        maxHeapMB: 256,
        apiTimeoutMs: 60000,
      });

      const limits = monitor.getPluginLimits('plugin-1');
      expect(limits?.maxHeapMB).toBe(256);
      expect(limits?.apiTimeoutMs).toBe(60000);
      // Should use defaults for non-specified
      expect(limits?.toolTimeoutMs).toBe(DEFAULT_RESOURCE_LIMITS.toolTimeoutMs);
    });
  });

  describe('health updates', () => {
    it('should update health from worker responses', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any);

      // Simulate health response
      worker._emit('health-response', {
        memoryUsage: {
          heapUsed: 50 * 1024 * 1024, // 50MB
          heapTotal: 100 * 1024 * 1024,
          external: 10 * 1024 * 1024,
        },
        activeRequests: 2,
      });

      const health = monitor.getPluginHealth('plugin-1');
      expect(health).not.toBeNull();
      expect(health?.memoryUsage.heapUsed).toBe(50 * 1024 * 1024);
      expect(health?.activeRequests).toBe(2);
    });

    it('should calculate memory percent used', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });

      // 80MB out of 100MB limit = 80%
      worker._emit('health-response', {
        memoryUsage: {
          heapUsed: 80 * 1024 * 1024,
          heapTotal: 100 * 1024 * 1024,
          external: 0,
        },
        activeRequests: 0,
      });

      const health = monitor.getPluginHealth('plugin-1');
      expect(health?.memoryUsage.percentUsed).toBe(80);
    });

    it('should return null for unknown plugin health', () => {
      expect(monitor.getPluginHealth('unknown')).toBeNull();
    });
  });

  describe('warnings', () => {
    it('should emit warning when memory exceeds threshold', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });

      // 85MB out of 100MB = 85% (above 80% warning threshold)
      worker._emit('health-response', {
        memoryUsage: {
          heapUsed: 85 * 1024 * 1024,
          heapTotal: 100 * 1024 * 1024,
          external: 0,
        },
        activeRequests: 0,
      });

      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'plugin:resource-warning',
        expect.objectContaining({
          pluginId: 'plugin-1',
          type: 'memory',
        })
      );
    });

    it('should track warning count', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });

      // Simulate multiple warnings
      for (let i = 0; i < 3; i++) {
        worker._emit('health-response', {
          memoryUsage: {
            heapUsed: 85 * 1024 * 1024,
            heapTotal: 100 * 1024 * 1024,
            external: 0,
          },
          activeRequests: 0,
        });
      }

      expect(monitor.getWarningCount('plugin-1')).toBe(3);
    });

    it('should reset warning count', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });

      worker._emit('health-response', {
        memoryUsage: {
          heapUsed: 85 * 1024 * 1024,
          heapTotal: 100 * 1024 * 1024,
          external: 0,
        },
        activeRequests: 0,
      });

      monitor.resetWarnings('plugin-1');

      expect(monitor.getWarningCount('plugin-1')).toBe(0);
    });

    it('should return 0 warnings for unknown plugin', () => {
      expect(monitor.getWarningCount('unknown')).toBe(0);
    });
  });

  describe('violations', () => {
    it('should terminate plugin when memory exceeds termination threshold', async () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });

      // 160MB out of 100MB = 160% (above 150% termination threshold)
      worker._emit('health-response', {
        memoryUsage: {
          heapUsed: 160 * 1024 * 1024,
          heapTotal: 200 * 1024 * 1024,
          external: 0,
        },
        activeRequests: 0,
      });

      expect(worker.stop).toHaveBeenCalledWith(false); // Force stop
      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'plugin:resource-violation',
        expect.objectContaining({
          pluginId: 'plugin-1',
          type: 'memory',
          action: 'terminated',
        })
      );
    });

    it('should terminate after max warnings', async () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });

      // Trigger warnings (85% usage, above 80% threshold)
      for (let i = 0; i < 3; i++) {
        worker._emit('health-response', {
          memoryUsage: {
            heapUsed: 85 * 1024 * 1024,
            heapTotal: 100 * 1024 * 1024,
            external: 0,
          },
          activeRequests: 0,
        });
      }

      expect(worker.stop).toHaveBeenCalledWith(false);
    });
  });

  describe('warning double-counting fix', () => {
    // checkPluginHealth used to run from both updateHealth (per health:response)
    // and checkAllPlugins (its own interval) over the same lastHealth snapshot,
    // so a plugin merely in warning territory racked up ~2 warnings per
    // checkIntervalMs and hit maxWarningsBeforeTermination in a fraction of the
    // intended time.
    it('does not re-score an unchanged snapshot when checkAllPlugins sweeps', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });
      monitor.start();

      // One real sample at 85% usage (above the 80% warning threshold).
      worker._emit('health-response', {
        memoryUsage: { heapUsed: 85 * 1024 * 1024, heapTotal: 100 * 1024 * 1024, external: 0 },
        activeRequests: 0,
      });
      expect(monitor.getWarningCount('plugin-1')).toBe(1);

      // checkAllPlugins' own 100ms interval (test config) fires repeatedly
      // with no new health sample in between — must not re-score the sample
      // updateHealth already scored.
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      expect(monitor.getWarningCount('plugin-1')).toBe(1);
    });

    it('still counts each genuinely new sample exactly once', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });
      monitor.start();

      worker._emit('health-response', {
        memoryUsage: { heapUsed: 85 * 1024 * 1024, heapTotal: 100 * 1024 * 1024, external: 0 },
        activeRequests: 0,
      });
      vi.advanceTimersByTime(100); // no-op sweep over the same snapshot
      worker._emit('health-response', {
        memoryUsage: { heapUsed: 86 * 1024 * 1024, heapTotal: 100 * 1024 * 1024, external: 0 },
        activeRequests: 0,
      });

      expect(monitor.getWarningCount('plugin-1')).toBe(2);
    });
  });

  describe('getAllHealth', () => {
    it('should return health for all tracked plugins', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      monitor.track('plugin-1', worker1 as any);
      monitor.track('plugin-2', worker2 as any);

      worker1._emit('health-response', {
        memoryUsage: { heapUsed: 50 * 1024 * 1024, heapTotal: 100 * 1024 * 1024, external: 0 },
        activeRequests: 1,
      });

      const allHealth = monitor.getAllHealth();

      expect(allHealth.size).toBe(2);
      expect(allHealth.has('plugin-1')).toBe(true);
      expect(allHealth.has('plugin-2')).toBe(true);
    });
  });

  describe('getPluginLimits', () => {
    it('should return limits for tracked plugin', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any);

      const limits = monitor.getPluginLimits('plugin-1');

      expect(limits).not.toBeNull();
      expect(limits).toHaveProperty('maxHeapMB');
      expect(limits).toHaveProperty('apiTimeoutMs');
    });

    it('should return null for unknown plugin', () => {
      expect(monitor.getPluginLimits('unknown')).toBeNull();
    });
  });

  describe('updatePluginLimits', () => {
    it('should update limits for a plugin', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, { maxHeapMB: 100 });

      monitor.updatePluginLimits('plugin-1', { maxHeapMB: 200 });

      const limits = monitor.getPluginLimits('plugin-1');
      expect(limits?.maxHeapMB).toBe(200);
    });

    it('should only update specified limits', () => {
      const worker = createMockWorker();
      monitor.track('plugin-1', worker as any, {
        maxHeapMB: 100,
        apiTimeoutMs: 30000,
      });

      monitor.updatePluginLimits('plugin-1', { maxHeapMB: 200 });

      const limits = monitor.getPluginLimits('plugin-1');
      expect(limits?.maxHeapMB).toBe(200);
      expect(limits?.apiTimeoutMs).toBe(30000);
    });
  });

  describe('getStats', () => {
    it('should return monitoring statistics', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker({ isRunning: false });
      monitor.track('plugin-1', worker1 as any, { maxHeapMB: 100 });
      monitor.track('plugin-2', worker2 as any);

      // Trigger a warning
      worker1._emit('health-response', {
        memoryUsage: { heapUsed: 85 * 1024 * 1024, heapTotal: 100 * 1024 * 1024, external: 0 },
        activeRequests: 0,
      });

      const stats = monitor.getStats();

      expect(stats.totalPlugins).toBe(2);
      expect(stats.runningPlugins).toBe(1);
      expect(stats.totalWarnings).toBe(1);
      expect(stats.pluginsWithWarnings).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all tracked plugins', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      monitor.track('plugin-1', worker1 as any);
      monitor.track('plugin-2', worker2 as any);

      monitor.clear();

      expect(monitor.pluginCount).toBe(0);
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetResourceMonitor();
  });

  it('getResourceMonitor should return same instance', () => {
    const monitor1 = getResourceMonitor();
    const monitor2 = getResourceMonitor();
    expect(monitor1).toBe(monitor2);
  });

  it('resetResourceMonitor should stop and clear', () => {
    const monitor1 = getResourceMonitor();
    monitor1.start();

    resetResourceMonitor();

    const monitor2 = getResourceMonitor();
    expect(monitor2.running).toBe(false);
    expect(monitor2.pluginCount).toBe(0);
  });
});
