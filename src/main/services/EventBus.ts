import { EventEmitter } from 'events';
import { logger } from './logger';

/**
 * Application-wide event bus for plugin system and internal communication
 * Provides type-safe event handling with logging and error handling
 */

export type AppEventType =
  // Data events
  | 'agent:created' | 'agent:updated' | 'agent:deleted'
  | 'project:created' | 'project:updated' | 'project:deleted' | 'project:switched'
  | 'channel:created' | 'channel:updated' | 'channel:deleted' | 'channel:switched'
  | 'message:created' | 'message:updated' | 'message:deleted'
  | 'task:created' | 'task:toggled' | 'task:deleted'
  | 'note:created' | 'note:deleted'

  // AI events
  | 'chat:start' | 'chat:stream' | 'chat:complete' | 'chat:error' | 'chat:aborted'
  | 'agent:spend'
  | 'tool:call' | 'tool:result' | 'tool:error'

  // Code execution events
  | 'code-execution:start' | 'code-execution:complete' | 'code-execution:error'
  | 'code-execution:cancelled' | 'code-execution:output'

  // Workflow events
  | 'workflow:node:executing' | 'workflow:node:completed' | 'workflow:node:error'

  // MCP Code API events
  | 'mcp-code-api:generated' | 'mcp-code-api:call' | 'mcp-code-api:result'

  // Plugin tool events
  | 'plugin:tool:called' | 'plugin:tool:result'

  // UI events
  | 'view:changed'

  // App lifecycle
  | 'app:ready' | 'app:shutdown'

  // Plugin events
  | 'plugin:loaded' | 'plugin:unloaded' | 'plugin:error'

  // Messaging bridge events
  | 'messaging:bridge:started' | 'messaging:bridge:stopped' | 'messaging:bridge:error'
  | 'messaging:auth:rejected'

  // Routine scheduler
  | 'routine:scheduler:paused' | 'routine:scheduler:resumed';

export interface AppEvent {
  type: AppEventType | string; // Allow custom plugin events
  data?: unknown;
  timestamp: number;
  source?: string; // Plugin ID or 'core'
}

/**
 * Global event bus singleton
 * Wraps Node.js EventEmitter with additional features:
 * - Logging of all events
 * - Error handling
 * - Event history (useful for debugging)
 */
class EventBus extends EventEmitter {
  private eventHistory: AppEvent[] = [];
  private maxHistorySize = 100;
  private wildcardHandlers: Set<(event: AppEvent) => void> = new Set();

  constructor() {
    super();
    // Increase listener limit for plugins
    this.setMaxListeners(100);
  }

  emitEvent(type: AppEventType | string, data?: unknown, source: string = 'core'): void {
    const event: AppEvent = {
      type,
      data,
      timestamp: Date.now(),
      source
    };

    // Log event (only in debug mode to avoid spam)
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Event emitted', { type, source, hasData: !!data });
    }

    // Store in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Notify wildcard handlers (for persistence, monitoring, etc.)
    this.wildcardHandlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        logger.error('Error in wildcard event handler', { type, error });
      }
    });

    // Emit the event
    this.emit(type, event);
  }

  onEvent(type: AppEventType | string, handler: (event: AppEvent) => void): () => void {
    // Wrap the handler so a throw inside one subscriber can't poison sibling
    // subscribers via Node's EventEmitter `error` path. The wrapped fn is the
    // one we register, so it's also the one we have to remove on cleanup —
    // `offEvent(type, handler)` with the bare handler is a no-op against the
    // wrapped registration and would leak the subscription, so this returns a
    // closure that removes the wrapper itself.
    const wrapped = (event: AppEvent) => {
      try {
        handler(event);
      } catch (error) {
        logger.error('Error in event handler', { type, error });
      }
    };
    this.on(type, wrapped);
    return () => { this.off(type, wrapped); };
  }

  onceEvent(type: AppEventType | string, handler: (event: AppEvent) => void): void {
    this.once(type, (event: AppEvent) => {
      try {
        handler(event);
      } catch (error) {
        logger.error('Error in event handler', { type, error });
      }
    });
  }

  offEvent(type: AppEventType | string, handler: (event: AppEvent) => void): void {
    this.off(type, handler);
  }

  /**
   * Subscribe to ALL events (wildcard listener)
   * Useful for persistence, monitoring, and debugging
   * Returns cleanup function to unsubscribe
   */
  onAllEvents(handler: (event: AppEvent) => void): () => void {
    this.wildcardHandlers.add(handler);
    return () => {
      this.wildcardHandlers.delete(handler);
    };
  }

  /**
   * Get event history (useful for debugging)
   */
  getEventHistory(filterType?: string): AppEvent[] {
    if (filterType) {
      return this.eventHistory.filter(e => e.type === filterType);
    }
    return [...this.eventHistory];
  }

  clearHistory(): void {
    this.eventHistory = [];
  }
}

let _eventBusInstance: EventBus | null = null;
export function getEventBus(): EventBus {
  if (!_eventBusInstance) _eventBusInstance = new EventBus();
  return _eventBusInstance;
}
export const eventBus = getEventBus();
