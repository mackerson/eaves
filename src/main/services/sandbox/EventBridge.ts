/**
 * Event Bridge
 *
 * Bridges events between the main process EventBus and sandboxed plugin workers.
 * Handles event subscriptions, dispatching, and cleanup.
 */

import { eventBus } from '../EventBus';
import { PluginWorker } from './PluginWorker';
import type { PermissionGate } from './PermissionGate';
import { SerializableValue } from './types';
import { sanitizeForSerialization } from './protocol';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

interface EventSubscription {
  pluginId: string;
  eventType: string;
  callbackId: string;
  handler: (event: unknown) => void;
  // Cleanup fn returned by eventBus.onEvent. EventBus wraps the handler, so
  // offEvent(type, bareHandler) is a no-op — the returned disposer is the only
  // reliable way to detach, and without it subscriptions leak past worker exit.
  dispose: () => void;
}

// ============================================================================
// Host-owned event namespaces (emit deny-list)
// ============================================================================

/**
 * Namespaces (the token before the first ':') owned by the host application.
 *
 * A sandboxed plugin may hold `events:emit` and still MUST NOT forge a
 * host-owned event: a fake `message:created`, `task:created`, or
 * `approval:requested` would drive host side-services (ActivityPersistence,
 * ShadowService memory extraction, SyncService, renderer store refreshes) as
 * if the host itself produced it. Plugin emit is therefore gated by BOTH the
 * `events:emit` permission AND this deny-list — permission alone is not enough.
 *
 * Derivation: this set mirrors the namespaces of the `AppEventType` union in
 * `EventBus.ts`. That union is a TypeScript type and is erased at runtime, so
 * it cannot be enumerated directly; we reserve its namespace prefixes instead.
 * Denial is prefix-based, so any NEW host event added under an existing
 * namespace (e.g. a future `task:archived`) is denied automatically without
 * editing this file. `approval` and `settings` are reserved host namespaces
 * that host code owns even though the current union does not yet enumerate a
 * member under them. The only residual maintenance is a brand-new top-level
 * host namespace, which must be added here when introduced.
 *
 * Plugin-authored namespaces are intentionally absent: the bundled import
 * plugins emit `chatgpt-import:*` / `character-card-import:*`, sync emits
 * `sync:*`, marketplace `marketplace:*`, etc. Those pass through untouched.
 */
const HOST_EVENT_NAMESPACES: ReadonlySet<string> = new Set([
  // AppEventType — data events
  'agent', 'project', 'channel', 'message', 'task', 'note',
  // AppEventType — AI events
  'chat', 'tool',
  // AppEventType — code execution events
  'code-execution',
  // AppEventType — workflow events
  'workflow',
  // AppEventType — MCP code API events
  'mcp-code-api',
  // AppEventType — plugin lifecycle/tool events, app lifecycle, UI
  'plugin', 'app', 'view',
  // Host services that emit outside the AppEventType union (verified against
  // every host emitEvent call site — see the EventBridge deny-list drift test):
  // RoutineScheduler, ServiceRegistry, MessagingBridgeService.
  'routine', 'service', 'messaging',
  // Reserved host namespaces (owned by host code; not yet in the union)
  'approval', 'settings',
]);

function eventNamespaceOf(eventType: string): string {
  const idx = eventType.indexOf(':');
  return idx === -1 ? eventType : eventType.slice(0, idx);
}

/**
 * True when `eventType` belongs to a host-owned namespace and must never be
 * emitted by a plugin (anti-forgery), regardless of granted permissions.
 */
export function isHostOwnedEventType(eventType: string): boolean {
  return HOST_EVENT_NAMESPACES.has(eventNamespaceOf(eventType));
}

// ============================================================================
// Event Bridge Class
// ============================================================================

/**
 * EventBridge manages event subscriptions for sandboxed plugins
 */
export class EventBridge {
  private subscriptions = new Map<string, EventSubscription>(); // callbackId -> subscription
  private pluginSubscriptions = new Map<string, Set<string>>(); // pluginId -> callbackIds
  private workers = new Map<string, PluginWorker>(); // pluginId -> worker
  private permissionGates = new Map<string, PermissionGate>(); // pluginId -> gate
  // Worker events are fire-and-forget, so a denied subscribe/emit is otherwise
  // silent to the plugin author. We can't push an error back over that
  // one-way channel without a protocol change, so at least make the main-log
  // warning actionable and emit it once per (plugin, permission) instead of
  // once per denied call (a plugin emitting in a loop would spam it).
  private warnedDenials = new Set<string>(); // `${pluginId}:${permission}`

  private warnDeniedOnce(pluginId: string, permission: string, action: string): void {
    const key = `${pluginId}:${permission}`;
    if (this.warnedDenials.has(key)) return;
    this.warnedDenials.add(key);
    logger.warn(
      `[EventBridge] Plugin "${pluginId}" attempted to ${action} but lacks the ` +
        `"${permission}" permission — add it to the plugin manifest's "permissions". ` +
        `All such calls are being dropped.`
    );
  }

  /**
   * Register a worker with the bridge.
   *
   * `permissionGate` carries the plugin's granted permissions so that plugin
   * event subscribe/emit can be gated (`events:listen` / `events:emit`) the
   * same way the RPC surface already gates data/actions/ui/etc. Without a gate
   * the plugin's events fail closed (see subscribe/emit).
   */
  registerWorker(pluginId: string, worker: PluginWorker, permissionGate: PermissionGate): void {
    this.workers.set(pluginId, worker);
    this.permissionGates.set(pluginId, permissionGate);

    // Listen for subscription events from the worker
    worker.on('event-subscribe', (eventType: string, callbackId: string) => {
      this.subscribe(pluginId, eventType, callbackId);
    });

    worker.on('event-unsubscribe', (_eventType: string, callbackId: string) => {
      this.unsubscribe(callbackId);
    });

    worker.on('event-emit', (eventType: string, data: SerializableValue) => {
      this.emit(pluginId, eventType, data);
    });

    logger.debug(`[EventBridge] Registered worker for plugin ${pluginId}`);
  }

  /**
   * Unregister a worker and cleanup subscriptions
   */
  unregisterWorker(pluginId: string): void {
    this.workers.delete(pluginId);
    this.permissionGates.delete(pluginId);
    this.cleanupPlugin(pluginId);
    // Reset the once-per-permission warning so a fixed + reloaded plugin can
    // surface the diagnostic again rather than staying silently suppressed.
    for (const key of this.warnedDenials) {
      if (key.startsWith(`${pluginId}:`)) this.warnedDenials.delete(key);
    }
    logger.debug(`[EventBridge] Unregistered worker for plugin ${pluginId}`);
  }

  /**
   * Subscribe to an event
   */
  subscribe(pluginId: string, eventType: string, callbackId: string): void {
    const worker = this.workers.get(pluginId);
    if (!worker) {
      logger.warn(`[EventBridge] Cannot subscribe: worker ${pluginId} not found`);
      return;
    }

    // Gate on `events:listen`. Fail closed if no gate was wired for the plugin.
    // Subscribe stays type-open: restricting which event types a plugin may
    // observe would break legitimate observers (event-inspector, sync). The
    // residual — a permitted plugin can eavesdrop on any event type — is
    // accepted-with-permission.
    const gate = this.permissionGates.get(pluginId);
    if (!gate || !gate.checkPermission(pluginId, 'events', 'on').allowed) {
      this.warnDeniedOnce(pluginId, 'events:listen', `subscribe to events (e.g. "${eventType}")`);
      return;
    }

    // Create handler that forwards to worker
    const handler = (event: unknown) => {
      try {
        const eventData = event && typeof event === 'object' && 'data' in event
          ? (event as { data: unknown }).data
          : event;

        worker.dispatchEvent(
          eventType,
          sanitizeForSerialization(eventData),
          pluginId
        );
      } catch (error) {
        logger.error(`[EventBridge] Error dispatching event ${eventType}:`, error);
      }
    };

    // Subscribe to EventBus, keeping the disposer for reliable detach.
    const dispose = eventBus.onEvent(eventType, handler);

    // Track subscription
    const subscription: EventSubscription = {
      pluginId,
      eventType,
      callbackId,
      handler,
      dispose,
    };
    this.subscriptions.set(callbackId, subscription);

    // Track by plugin
    if (!this.pluginSubscriptions.has(pluginId)) {
      this.pluginSubscriptions.set(pluginId, new Set());
    }
    this.pluginSubscriptions.get(pluginId)!.add(callbackId);

    logger.debug(
      `[EventBridge] Plugin ${pluginId} subscribed to ${eventType} (${callbackId})`
    );
  }

  /**
   * Unsubscribe from an event
   */
  unsubscribe(callbackId: string): boolean {
    const subscription = this.subscriptions.get(callbackId);
    if (!subscription) return false;

    // Detach via the disposer — offEvent with the bare handler is a no-op.
    subscription.dispose();

    // Remove tracking
    this.subscriptions.delete(callbackId);

    const pluginSubs = this.pluginSubscriptions.get(subscription.pluginId);
    if (pluginSubs) {
      pluginSubs.delete(callbackId);
      if (pluginSubs.size === 0) {
        this.pluginSubscriptions.delete(subscription.pluginId);
      }
    }

    logger.debug(
      `[EventBridge] Unsubscribed ${subscription.eventType} (${callbackId})`
    );
    return true;
  }

  /**
   * Emit an event from a plugin
   */
  emit(pluginId: string, eventType: string, data: SerializableValue): void {
    // Gate on `events:emit`. Fail closed if no gate was wired for the plugin.
    const gate = this.permissionGates.get(pluginId);
    if (!gate || !gate.checkPermission(pluginId, 'events', 'emit').allowed) {
      this.warnDeniedOnce(pluginId, 'events:emit', `emit events (e.g. "${eventType}")`);
      return;
    }

    // Anti-forgery: even with `events:emit`, a plugin may only emit event types
    // outside the host-owned namespaces. A forged host event would be
    // indistinguishable from a genuine one to every downstream consumer.
    if (isHostOwnedEventType(eventType)) {
      logger.warn(
        `[EventBridge] Plugin ${pluginId} blocked from emitting host-owned event ${eventType}`
      );
      return;
    }

    eventBus.emitEvent(eventType, data, pluginId);
    logger.debug(`[EventBridge] Plugin ${pluginId} emitted ${eventType}`);
  }

  /**
   * Cleanup all subscriptions for a plugin
   */
  cleanupPlugin(pluginId: string): number {
    const callbackIds = this.pluginSubscriptions.get(pluginId);
    if (!callbackIds) return 0;

    let count = 0;
    for (const callbackId of callbackIds) {
      const subscription = this.subscriptions.get(callbackId);
      if (subscription) {
        subscription.dispose();
        this.subscriptions.delete(callbackId);
        count++;
      }
    }

    this.pluginSubscriptions.delete(pluginId);

    logger.debug(`[EventBridge] Cleaned up ${count} subscriptions for ${pluginId}`);
    return count;
  }

  /**
   * Get subscription count for a plugin
   */
  getPluginSubscriptionCount(pluginId: string): number {
    return this.pluginSubscriptions.get(pluginId)?.size ?? 0;
  }

  /**
   * Get total subscription count
   */
  get totalSubscriptions(): number {
    return this.subscriptions.size;
  }

  /**
   * Get all subscribed event types for a plugin
   */
  getPluginEventTypes(pluginId: string): string[] {
    const callbackIds = this.pluginSubscriptions.get(pluginId);
    if (!callbackIds) return [];

    const eventTypes = new Set<string>();
    for (const callbackId of callbackIds) {
      const subscription = this.subscriptions.get(callbackId);
      if (subscription) {
        eventTypes.add(subscription.eventType);
      }
    }
    return Array.from(eventTypes);
  }

  /**
   * Clear all subscriptions
   */
  clear(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.dispose();
    }
    this.subscriptions.clear();
    this.pluginSubscriptions.clear();
    logger.debug('[EventBridge] Cleared all subscriptions');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let eventBridgeInstance: EventBridge | null = null;

/**
 * Get the global EventBridge instance
 */
export function getEventBridge(): EventBridge {
  if (!eventBridgeInstance) {
    eventBridgeInstance = new EventBridge();
  }
  return eventBridgeInstance;
}

/**
 * Reset the global EventBridge instance (for testing)
 */
export function resetEventBridge(): void {
  if (eventBridgeInstance) {
    eventBridgeInstance.clear();
  }
  eventBridgeInstance = null;
}
