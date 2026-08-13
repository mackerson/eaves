/**
 * EventBridge Tests
 *
 * Tests for event subscription and dispatch bridging between plugins and
 * EventBus, including permission gating (events:listen / events:emit) and the
 * host-owned-event emit deny-list (anti-forgery).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { EventBridge, getEventBridge, resetEventBridge, isHostOwnedEventType } from './EventBridge';
import { PermissionGate } from './PermissionGate';
import { logger } from '../logger';
import type { PluginPermission } from '../../../shared/types';

// Mock EventBus
vi.mock('../EventBus', () => {
  const handlers = new Map<string, Set<Function>>();

  return {
    eventBus: {
      // Returns a disposer, matching the real EventBus.onEvent contract (which
      // wraps the handler, making offEvent(type, bareHandler) a no-op).
      onEvent: vi.fn((eventType: string, handler: Function) => {
        if (!handlers.has(eventType)) {
          handlers.set(eventType, new Set());
        }
        handlers.get(eventType)!.add(handler);
        return () => handlers.get(eventType)?.delete(handler);
      }),
      offEvent: vi.fn((_eventType: string, _handler: Function) => {
        // No-op, mirroring the real EventBus hazard: bare-handler offEvent
        // never detaches because onEvent registered a wrapper. Detach only
        // works through the disposer onEvent returns.
      }),
      emitEvent: vi.fn((eventType: string, data: unknown, _source?: string) => {
        // Simulate event emission to handlers
        handlers.get(eventType)?.forEach((h) => h({ data }));
      }),
      // Helper for tests to trigger events
      _getHandlers: () => handlers,
      _clearHandlers: () => handlers.clear(),
    },
  };
});

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
function createMockWorker() {
  const emitter = new EventEmitter();
  return {
    on: vi.fn((event: string, handler: Function) => {
      emitter.on(event, handler);
    }),
    off: vi.fn((event: string, handler: Function) => {
      emitter.off(event, handler);
    }),
    dispatchEvent: vi.fn(),
    isRunning: vi.fn(() => true),
    // Helper to simulate worker events
    _emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

const ALL_EVENT_PERMS: PluginPermission[] = ['events:listen', 'events:emit'];

describe('EventBridge', () => {
  let bridge: EventBridge;
  let gate: PermissionGate;
  let eventBusMock: any;

  // Register a worker + grant the given event permissions on the shared gate.
  // Defaults to full event permissions so the behavioral tests exercise the
  // happy path; the gating tests pass narrower permission sets explicitly.
  function register(
    pluginId: string,
    worker: ReturnType<typeof createMockWorker>,
    perms: PluginPermission[] = ALL_EVENT_PERMS
  ) {
    gate.registerPlugin(pluginId, perms);
    bridge.registerWorker(pluginId, worker as any, gate);
  }

  beforeEach(async () => {
    bridge = new EventBridge();
    gate = new PermissionGate();
    eventBusMock = (await import('../EventBus')).eventBus;
    eventBusMock._clearHandlers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    bridge.clear();
  });

  describe('registerWorker', () => {
    it('should register worker and set up event listeners', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);

      expect(worker.on).toHaveBeenCalledWith('event-subscribe', expect.any(Function));
      expect(worker.on).toHaveBeenCalledWith('event-unsubscribe', expect.any(Function));
      expect(worker.on).toHaveBeenCalledWith('event-emit', expect.any(Function));
    });
  });

  describe('unregisterWorker', () => {
    it('should cleanup subscriptions when unregistering worker', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);
      bridge.subscribe('plugin-1', 'test:event', 'cb-1');

      expect(bridge.getPluginSubscriptionCount('plugin-1')).toBe(1);

      bridge.unregisterWorker('plugin-1');

      expect(bridge.getPluginSubscriptionCount('plugin-1')).toBe(0);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to events', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);

      bridge.subscribe('plugin-1', 'test:event', 'cb-1');

      expect(eventBusMock.onEvent).toHaveBeenCalledWith('test:event', expect.any(Function));
      expect(bridge.totalSubscriptions).toBe(1);
    });

    it('should track subscriptions by plugin', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);

      bridge.subscribe('plugin-1', 'event1', 'cb-1');
      bridge.subscribe('plugin-1', 'event2', 'cb-2');

      expect(bridge.getPluginSubscriptionCount('plugin-1')).toBe(2);
    });

    it('should forward events to worker', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);
      bridge.subscribe('plugin-1', 'test:event', 'cb-1');

      // Simulate event bus emitting an event
      const handlers = eventBusMock._getHandlers();
      const eventHandlers = handlers.get('test:event');
      expect(eventHandlers).toBeDefined();

      // Call the handler
      const handler = Array.from(eventHandlers!)[0] as Function;
      handler({ data: { value: 'test' } });

      expect(worker.dispatchEvent).toHaveBeenCalledWith(
        'test:event',
        { value: 'test' },
        'plugin-1'
      );
    });

    it('should not subscribe for unregistered worker', () => {
      bridge.subscribe('unknown-plugin', 'test:event', 'cb-1');

      expect(eventBusMock.onEvent).not.toHaveBeenCalled();
      expect(bridge.totalSubscriptions).toBe(0);
    });
  });

  describe('unsubscribe', () => {
    it('should unsubscribe from events', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);
      bridge.subscribe('plugin-1', 'test:event', 'cb-1');

      const result = bridge.unsubscribe('cb-1');

      expect(result).toBe(true);
      expect(bridge.totalSubscriptions).toBe(0);
      // Detached for real: a subsequent emit reaches no worker (the disposer
      // ran, not the bare-handler offEvent no-op).
      eventBusMock.emitEvent('test:event', {});
      expect(worker.dispatchEvent).not.toHaveBeenCalled();
    });

    it('should return false for unknown callback', () => {
      const result = bridge.unsubscribe('unknown-cb');
      expect(result).toBe(false);
    });

    it('should cleanup plugin subscriptions tracking', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);
      bridge.subscribe('plugin-1', 'event1', 'cb-1');
      bridge.subscribe('plugin-1', 'event2', 'cb-2');

      bridge.unsubscribe('cb-1');

      expect(bridge.getPluginSubscriptionCount('plugin-1')).toBe(1);

      bridge.unsubscribe('cb-2');

      expect(bridge.getPluginSubscriptionCount('plugin-1')).toBe(0);
    });
  });

  describe('emit', () => {
    it('should emit events to EventBus', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);

      bridge.emit('plugin-1', 'custom:event', { value: 'test' });

      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'custom:event',
        { value: 'test' },
        'plugin-1'
      );
    });
  });

  describe('cleanupPlugin', () => {
    it('should cleanup all subscriptions for a plugin', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);
      bridge.subscribe('plugin-1', 'event1', 'cb-1');
      bridge.subscribe('plugin-1', 'event2', 'cb-2');
      bridge.subscribe('plugin-1', 'event3', 'cb-3');

      const count = bridge.cleanupPlugin('plugin-1');

      expect(count).toBe(3);
      expect(bridge.getPluginSubscriptionCount('plugin-1')).toBe(0);
      expect(bridge.totalSubscriptions).toBe(0);
    });

    it('should not affect other plugins', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      register('plugin-1', worker1);
      register('plugin-2', worker2);

      bridge.subscribe('plugin-1', 'event1', 'cb-1');
      bridge.subscribe('plugin-2', 'event2', 'cb-2');

      bridge.cleanupPlugin('plugin-1');

      expect(bridge.getPluginSubscriptionCount('plugin-1')).toBe(0);
      expect(bridge.getPluginSubscriptionCount('plugin-2')).toBe(1);
    });

    it('should return 0 for plugin with no subscriptions', () => {
      const count = bridge.cleanupPlugin('unknown-plugin');
      expect(count).toBe(0);
    });
  });

  describe('getPluginEventTypes', () => {
    it('should return subscribed event types', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);
      bridge.subscribe('plugin-1', 'event1', 'cb-1');
      bridge.subscribe('plugin-1', 'event2', 'cb-2');
      bridge.subscribe('plugin-1', 'event1', 'cb-3'); // Duplicate event type

      const types = bridge.getPluginEventTypes('plugin-1');

      expect(types).toContain('event1');
      expect(types).toContain('event2');
      expect(types.length).toBe(2); // Unique event types
    });

    it('should return empty array for unknown plugin', () => {
      const types = bridge.getPluginEventTypes('unknown');
      expect(types).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should clear all subscriptions', () => {
      const worker1 = createMockWorker();
      const worker2 = createMockWorker();
      register('plugin-1', worker1);
      register('plugin-2', worker2);

      bridge.subscribe('plugin-1', 'event1', 'cb-1');
      bridge.subscribe('plugin-2', 'event2', 'cb-2');

      bridge.clear();

      expect(bridge.totalSubscriptions).toBe(0);
    });
  });

  describe('worker event handlers', () => {
    it('should handle event-subscribe from worker', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);

      // Simulate worker emitting subscribe event
      worker._emit('event-subscribe', 'test:event', 'cb-1');

      expect(bridge.totalSubscriptions).toBe(1);
    });

    it('should handle event-unsubscribe from worker', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);

      // Subscribe first
      worker._emit('event-subscribe', 'test:event', 'cb-1');
      expect(bridge.totalSubscriptions).toBe(1);

      // Then unsubscribe
      worker._emit('event-unsubscribe', 'test:event', 'cb-1');
      expect(bridge.totalSubscriptions).toBe(0);
    });

    it('should handle event-emit from worker', () => {
      const worker = createMockWorker();
      register('plugin-1', worker);

      worker._emit('event-emit', 'custom:event', { value: 'test' });

      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'custom:event',
        { value: 'test' },
        'plugin-1'
      );
    });
  });

  // ==========================================================================
  // Permission gating
  // ==========================================================================

  describe('subscribe permission gating (events:listen)', () => {
    it('denies subscribe when the plugin lacks events:listen', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, []); // no permissions granted

      bridge.subscribe('plugin-1', 'some:event', 'cb-1');

      expect(eventBusMock.onEvent).not.toHaveBeenCalled();
      expect(bridge.totalSubscriptions).toBe(0);
    });

    it('allows subscribe when the plugin has events:listen', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, ['events:listen']);

      bridge.subscribe('plugin-1', 'some:event', 'cb-1');

      expect(eventBusMock.onEvent).toHaveBeenCalledWith('some:event', expect.any(Function));
      expect(bridge.totalSubscriptions).toBe(1);
    });

    it('fails closed when no permission gate is wired for the plugin', () => {
      const worker = createMockWorker();
      // Register the worker directly without granting any permission.
      gate.registerPlugin('plugin-1', ['events:listen']);
      bridge.registerWorker('plugin-1', worker as any, new PermissionGate());

      bridge.subscribe('plugin-1', 'some:event', 'cb-1');

      // The gate passed to registerWorker has no record of plugin-1 → denied.
      expect(bridge.totalSubscriptions).toBe(0);
    });
  });

  describe('emit permission gating (events:emit)', () => {
    it('denies emitting ANY event when the plugin lacks events:emit', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, ['events:listen']); // listen but not emit

      bridge.emit('plugin-1', 'plugin-namespace:thing', { value: 1 });

      expect(eventBusMock.emitEvent).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Emit deny-list (anti-forgery of host-owned events)
  // ==========================================================================

  describe('emit host-owned event deny-list', () => {
    // Each host-owned namespace must be blocked even WITH events:emit granted.
    const hostOwned = [
      'message:created',
      'agent:updated',
      'channel:created',
      'approval:requested',
      // Host services that emit outside the AppEventType union — the gaps the
      // adversarial pass caught. routine:* is the sharp one: it reaches the
      // renderer via ActivityPersistence and drives RoutinesView state.
      'routine:execution:completed',
      'routine:scheduler:started',
      'service:registered',
      'messaging:bridge:started',
    ];

    for (const eventType of hostOwned) {
      it(`blocks emit of host-owned "${eventType}" even with events:emit`, () => {
        const worker = createMockWorker();
        register('plugin-1', worker, ['events:emit']);

        bridge.emit('plugin-1', eventType, { forged: true });

        expect(eventBusMock.emitEvent).not.toHaveBeenCalled();
      });
    }

    it('allows a plugin-authored import event (chatgpt-import:progress)', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, ['events:emit']);

      bridge.emit('plugin-1', 'chatgpt-import:progress', { pct: 42 });

      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'chatgpt-import:progress',
        { pct: 42 },
        'plugin-1'
      );
    });

    it('allows an arbitrary plugin-namespaced event type', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, ['events:emit']);

      bridge.emit('plugin-1', 'my-plugin:custom-thing', { ok: true });

      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'my-plugin:custom-thing',
        { ok: true },
        'plugin-1'
      );
    });

    it('stamps the pluginId as the event source on allowed emits', () => {
      const worker = createMockWorker();
      register('plugin-7', worker, ['events:emit']);

      bridge.emit('plugin-7', 'my-plugin:ping', { n: 1 });

      // Third positional arg to emitEvent is the source (pluginId) stamp.
      expect(eventBusMock.emitEvent).toHaveBeenCalledWith(
        'my-plugin:ping',
        { n: 1 },
        'plugin-7'
      );
    });
  });

  // ==========================================================================
  // Denied-permission diagnostics: warn once per (plugin, permission), not per
  // dropped call — a plugin emitting in a loop must not spam the log, but the
  // author must still get one actionable message.
  // ==========================================================================
  describe('denied-permission warning is deduped and actionable', () => {
    it('warns once per plugin for repeated denied emits, naming the permission', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, []); // no events:emit

      bridge.emit('plugin-1', 'my-plugin:a', {});
      bridge.emit('plugin-1', 'my-plugin:b', {});
      bridge.emit('plugin-1', 'my-plugin:c', {});

      const emitWarnings = (logger.warn as any).mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('events:emit')
      );
      expect(emitWarnings).toHaveLength(1);
      expect(emitWarnings[0][0]).toContain('plugin-1');
      expect(emitWarnings[0][0]).toContain('manifest');
    });

    it('warns separately for the listen and emit permissions', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, []); // neither permission

      bridge.subscribe('plugin-1', 'some:event', 'cb-1');
      bridge.emit('plugin-1', 'my-plugin:a', {});

      const calls = (logger.warn as any).mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.filter((m: string) => m?.includes('events:listen'))).toHaveLength(1);
      expect(calls.filter((m: string) => m?.includes('events:emit'))).toHaveLength(1);
    });

    it('re-warns after the worker is unregistered and re-registered', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, []);
      bridge.emit('plugin-1', 'my-plugin:a', {});
      bridge.unregisterWorker('plugin-1');
      register('plugin-1', worker, []);
      bridge.emit('plugin-1', 'my-plugin:b', {});

      const emitWarnings = (logger.warn as any).mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('events:emit')
      );
      expect(emitWarnings).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Unsubscribe actually detaches (fail-open leak fix)
  // ==========================================================================

  describe('subscription cleanup detaches from EventBus', () => {
    it('unsubscribe stops delivering events to the worker', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, ['events:listen']);
      bridge.subscribe('plugin-1', 'my-plugin:tick', 'cb-1');

      eventBusMock.emitEvent('my-plugin:tick', { n: 1 });
      expect(worker.dispatchEvent).toHaveBeenCalledTimes(1);

      bridge.unsubscribe('cb-1');
      eventBusMock.emitEvent('my-plugin:tick', { n: 2 });

      // Still 1 — the handler was detached via the disposer, not left leaking.
      expect(worker.dispatchEvent).toHaveBeenCalledTimes(1);
    });

    it('cleanupPlugin detaches every subscription', () => {
      const worker = createMockWorker();
      register('plugin-1', worker, ['events:listen']);
      bridge.subscribe('plugin-1', 'my-plugin:a', 'cb-1');
      bridge.subscribe('plugin-1', 'my-plugin:b', 'cb-2');

      bridge.cleanupPlugin('plugin-1');
      eventBusMock.emitEvent('my-plugin:a', {});
      eventBusMock.emitEvent('my-plugin:b', {});

      expect(worker.dispatchEvent).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Deny-list drift guard: every namespace a host service actually emits must be
// in HOST_EVENT_NAMESPACES, or a plugin with events:emit could forge it. This
// is what caught routine/service/messaging; it fails automatically when a new
// host namespace is introduced without updating the deny-list.
// ============================================================================

describe('host-event deny-list has no drift', () => {
  it('every namespace emitted by host code is host-owned', async () => {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const { join } = await import('path');

    // Plugin-authored namespaces legitimately emitted through the bridge — the
    // allowlist the deny-list intentionally lets through.
    const PLUGIN_NAMESPACES = new Set([
      'chatgpt-import', 'character-card-import', 'claude-context',
      'sync', 'marketplace', 'webview',
    ]);

    const root = join(process.cwd(), 'src', 'main');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(root);

    // Match emitEvent('ns:…') / "ns:…" / `ns:…`. The namespace char class is
    // widened past lowercase-hyphen so a future uppercase/camelCase namespace
    // (e.g. `billing:charged`, `Billing:x`) can't slip the guard. Backtick is
    // included so template-literal emits are caught too. A dynamic prefix
    // (`emitEvent(`${x}:…`)`) starts with `$`, doesn't match `[A-Za-z]`, and is
    // intentionally skipped — the namespace isn't statically knowable.
    const emitRe = /emitEvent\(\s*['"`]([A-Za-z][\w-]*):/g;
    const offenders: string[] = [];
    for (const file of files) {
      // EventBridge itself forwards plugin-authored events — skip it.
      if (file.endsWith('EventBridge.ts')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(emitRe)) {
        const ns = m[1];
        if (PLUGIN_NAMESPACES.has(ns)) continue;
        if (!isHostOwnedEventType(`${ns}:x`)) {
          offenders.push(`${ns} (${file.replace(process.cwd() + '/', '')})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetEventBridge();
  });

  it('getEventBridge should return same instance', () => {
    const bridge1 = getEventBridge();
    const bridge2 = getEventBridge();
    expect(bridge1).toBe(bridge2);
  });

  it('resetEventBridge should create new instance', () => {
    const bridge1 = getEventBridge();
    resetEventBridge();
    const bridge2 = getEventBridge();
    // After reset, it should be a different instance
    // (We can't directly compare since reset creates new one lazily)
    expect(bridge2).toBeDefined();
  });
});
