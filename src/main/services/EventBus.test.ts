/**
 * EventBus Tests
 *
 * Comprehensive tests for the application-wide event bus.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus, AppEvent, AppEventType } from './EventBus';

// Mock logger
vi.mock('./logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('EventBus', () => {
  let mockLogger: any;

  beforeEach(async () => {
    mockLogger = (await import('./logger')).logger;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up listeners and history
    eventBus.removeAllListeners();
    eventBus.clearHistory();
  });

  describe('emitEvent', () => {
    it('should emit an event with correct structure', () => {
      const handler = vi.fn();
      const eventType: AppEventType = 'agent:created';
      const eventData = { id: 'agent-1', name: 'Test Agent' };

      eventBus.onEvent(eventType, handler);
      eventBus.emitEvent(eventType, eventData);

      expect(handler).toHaveBeenCalledTimes(1);
      const emittedEvent: AppEvent = handler.mock.calls[0][0];
      expect(emittedEvent).toMatchObject({
        type: eventType,
        data: eventData,
        source: 'core',
      });
      expect(emittedEvent.timestamp).toBeTypeOf('number');
      expect(emittedEvent.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should emit event with custom source', () => {
      const handler = vi.fn();
      const eventType: AppEventType = 'plugin:loaded';

      eventBus.onEvent(eventType, handler);
      eventBus.emitEvent(eventType, { pluginId: 'test-plugin' }, 'plugin-manager');

      const emittedEvent: AppEvent = handler.mock.calls[0][0];
      expect(emittedEvent.source).toBe('plugin-manager');
    });

    it('should emit event without data', () => {
      const handler = vi.fn();
      const eventType: AppEventType = 'app:ready';

      eventBus.onEvent(eventType, handler);
      eventBus.emitEvent(eventType);

      const emittedEvent: AppEvent = handler.mock.calls[0][0];
      expect(emittedEvent.data).toBeUndefined();
    });

    it('should support custom event types', () => {
      const handler = vi.fn();
      const customEvent = 'custom:plugin:event';

      eventBus.onEvent(customEvent, handler);
      eventBus.emitEvent(customEvent, { custom: true });

      expect(handler).toHaveBeenCalledTimes(1);
      const emittedEvent: AppEvent = handler.mock.calls[0][0];
      expect(emittedEvent.type).toBe(customEvent);
    });

    it('should add event to history', () => {
      const eventType: AppEventType = 'task:created';
      eventBus.emitEvent(eventType, { taskId: '123' });

      const history = eventBus.getEventHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe(eventType);
    });

    it('should maintain history with max size limit', () => {
      // Emit 150 events (max is 100)
      for (let i = 0; i < 150; i++) {
        eventBus.emitEvent('message:created', { index: i });
      }

      const history = eventBus.getEventHistory();
      expect(history).toHaveLength(100);
      // Should keep the most recent events
      expect(history[0].data.index).toBe(50);
      expect(history[99].data.index).toBe(149);
    });

    it('should call wildcard handlers', () => {
      const wildcardHandler = vi.fn();
      const cleanup = eventBus.onAllEvents(wildcardHandler);

      eventBus.emitEvent('agent:created', { id: 'agent-1' });
      eventBus.emitEvent('project:updated', { id: 'project-1' });

      expect(wildcardHandler).toHaveBeenCalledTimes(2);
      cleanup();
    });
  });

  describe('onEvent', () => {
    it('should subscribe to an event', () => {
      const handler = vi.fn();
      eventBus.onEvent('agent:created', handler);

      eventBus.emitEvent('agent:created', { id: 'agent-1' });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support multiple listeners for the same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      eventBus.onEvent('project:created', handler1);
      eventBus.onEvent('project:created', handler2);
      eventBus.onEvent('project:created', handler3);

      eventBus.emitEvent('project:created', { id: 'project-1' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('should only call handlers for matching event types', () => {
      const agentHandler = vi.fn();
      const projectHandler = vi.fn();

      eventBus.onEvent('agent:created', agentHandler);
      eventBus.onEvent('project:created', projectHandler);

      eventBus.emitEvent('agent:created', { id: 'agent-1' });

      expect(agentHandler).toHaveBeenCalledTimes(1);
      expect(projectHandler).not.toHaveBeenCalled();
    });

    it('should pass complete event object to handlers', () => {
      const handler = vi.fn();
      eventBus.onEvent('message:created', handler);

      const testData = { messageId: 'msg-123', content: 'Hello' };
      eventBus.emitEvent('message:created', testData, 'plugin-test');

      const event: AppEvent = handler.mock.calls[0][0];
      expect(event.type).toBe('message:created');
      expect(event.data).toEqual(testData);
      expect(event.source).toBe('plugin-test');
      expect(typeof event.timestamp).toBe('number');
    });

    it('should return a cleanup function that detaches the handler', () => {
      // Regression coverage: handlers are wrapped in a try/catch shim before
      // registration, so removing the *bare* handler via offEvent is a no-op.
      // The returned cleanup removes the actual wrapped registration.
      const handler = vi.fn();
      const cleanup = eventBus.onEvent('agent:created', handler);

      eventBus.emitEvent('agent:created', { agentId: 'a-1' });
      expect(handler).toHaveBeenCalledTimes(1);

      cleanup();
      eventBus.emitEvent('agent:created', { agentId: 'a-2' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('onceEvent', () => {
    it('should only call handler once', () => {
      const handler = vi.fn();
      eventBus.onceEvent('app:ready', handler);

      eventBus.emitEvent('app:ready');
      eventBus.emitEvent('app:ready');
      eventBus.emitEvent('app:ready');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not interfere with regular event handlers', () => {
      const regularHandler = vi.fn();
      const onceHandler = vi.fn();

      eventBus.onEvent('task:toggled', regularHandler);
      eventBus.onceEvent('task:toggled', onceHandler);

      eventBus.emitEvent('task:toggled', { taskId: 'task-1' });
      eventBus.emitEvent('task:toggled', { taskId: 'task-2' });

      expect(regularHandler).toHaveBeenCalledTimes(2);
      expect(onceHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('offEvent', () => {
    it('should handle removing non-existent handler gracefully', () => {
      const handler = vi.fn();

      // Should not throw
      expect(() => {
        eventBus.offEvent('chat:error', handler);
      }).not.toThrow();
    });
  });

  describe('onAllEvents', () => {
    it('should call handler for all event types', () => {
      const wildcardHandler = vi.fn();
      const cleanup = eventBus.onAllEvents(wildcardHandler);

      eventBus.emitEvent('agent:created', { id: 'agent-1' });
      eventBus.emitEvent('project:updated', { id: 'project-1' });
      eventBus.emitEvent('chat:start', { chatId: '123' });

      expect(wildcardHandler).toHaveBeenCalledTimes(3);
      cleanup();
    });

    it('should return cleanup function', () => {
      const wildcardHandler = vi.fn();
      const cleanup = eventBus.onAllEvents(wildcardHandler);

      eventBus.emitEvent('agent:created', { id: 'agent-1' });
      expect(wildcardHandler).toHaveBeenCalledTimes(1);

      cleanup();
      eventBus.emitEvent('agent:updated', { id: 'agent-1' });

      expect(wildcardHandler).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should support multiple wildcard handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const cleanup1 = eventBus.onAllEvents(handler1);
      const cleanup2 = eventBus.onAllEvents(handler2);

      eventBus.emitEvent('tool:call', { toolId: 'tool-1' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      cleanup1();
      cleanup2();
    });

    it('should pass complete event to wildcard handlers', () => {
      const wildcardHandler = vi.fn();
      const cleanup = eventBus.onAllEvents(wildcardHandler);

      const eventData = { id: 'test-123' };
      eventBus.emitEvent('code-execution:start', eventData, 'executor');

      const event: AppEvent = wildcardHandler.mock.calls[0][0];
      expect(event.type).toBe('code-execution:start');
      expect(event.data).toEqual(eventData);
      expect(event.source).toBe('executor');

      cleanup();
    });
  });

  describe('getEventHistory', () => {
    it('should return all events in history', () => {
      eventBus.emitEvent('agent:created', { id: 'agent-1' });
      eventBus.emitEvent('project:created', { id: 'project-1' });
      eventBus.emitEvent('channel:created', { id: 'channel-1' });

      const history = eventBus.getEventHistory();

      expect(history).toHaveLength(3);
      expect(history[0].type).toBe('agent:created');
      expect(history[1].type).toBe('project:created');
      expect(history[2].type).toBe('channel:created');
    });

    it('should filter history by event type', () => {
      eventBus.emitEvent('agent:created', { id: 'agent-1' });
      eventBus.emitEvent('agent:updated', { id: 'agent-1' });
      eventBus.emitEvent('project:created', { id: 'project-1' });
      eventBus.emitEvent('agent:deleted', { id: 'agent-2' });

      const agentHistory = eventBus.getEventHistory('agent:updated');

      expect(agentHistory).toHaveLength(1);
      expect(agentHistory[0].type).toBe('agent:updated');
    });

    it('should return empty array when no events match filter', () => {
      eventBus.emitEvent('agent:created', { id: 'agent-1' });

      const history = eventBus.getEventHistory('project:deleted');

      expect(history).toHaveLength(0);
    });

    it('should preserve event order', () => {
      const events = ['agent:created', 'project:created', 'channel:created'];
      events.forEach((type) => eventBus.emitEvent(type as AppEventType));

      const history = eventBus.getEventHistory();

      expect(history.map((e) => e.type)).toEqual(events);
    });
  });

  describe('clearHistory', () => {
    it('should clear all event history', () => {
      eventBus.emitEvent('agent:created', { id: 'agent-1' });
      eventBus.emitEvent('project:created', { id: 'project-1' });

      expect(eventBus.getEventHistory()).toHaveLength(2);

      eventBus.clearHistory();

      expect(eventBus.getEventHistory()).toHaveLength(0);
    });

    it('should not affect active listeners', () => {
      const handler = vi.fn();
      eventBus.onEvent('message:created', handler);

      eventBus.emitEvent('message:created', { id: 'msg-1' });
      eventBus.clearHistory();
      eventBus.emitEvent('message:created', { id: 'msg-2' });

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('edge cases', () => {
    it('should handle event with no listeners', () => {
      expect(() => {
        eventBus.emitEvent('orphan:event', { data: 'test' });
      }).not.toThrow();

      const history = eventBus.getEventHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('orphan:event');
    });

    it('should handle null/undefined data', () => {
      const handler = vi.fn();
      eventBus.onEvent('test:event', handler);

      eventBus.emitEvent('test:event', null);
      eventBus.emitEvent('test:event', undefined);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0].data).toBeNull();
      expect(handler.mock.calls[1][0].data).toBeUndefined();
    });

    it('should handle complex data objects', () => {
      const handler = vi.fn();
      eventBus.onEvent('complex:event', handler);

      const complexData = {
        nested: {
          deeply: {
            value: 'test',
          },
        },
        array: [1, 2, 3],
        nullValue: null,
      };

      eventBus.emitEvent('complex:event', complexData);

      expect(handler.mock.calls[0][0].data).toEqual(complexData);
    });

    it('should handle rapid event emission', () => {
      const handler = vi.fn();
      eventBus.onEvent('rapid:event', handler);

      for (let i = 0; i < 100; i++) {
        eventBus.emitEvent('rapid:event', { index: i });
      }

      expect(handler).toHaveBeenCalledTimes(100);
    });
  });
});

describe('eventBus singleton', () => {
  it('should be defined', () => {
    expect(eventBus).toBeDefined();
  });

  it('should have expected methods', () => {
    expect(typeof eventBus.emitEvent).toBe('function');
    expect(typeof eventBus.onEvent).toBe('function');
    expect(typeof eventBus.onceEvent).toBe('function');
    expect(typeof eventBus.offEvent).toBe('function');
    expect(typeof eventBus.onAllEvents).toBe('function');
    expect(typeof eventBus.getEventHistory).toBe('function');
    expect(typeof eventBus.clearHistory).toBe('function');
  });
});
