/**
 * Callback Registry
 *
 * Manages function references that need to cross the worker boundary.
 * Since functions cannot be serialized, we assign IDs and track them
 * in the main process, then invoke them via messages.
 */

import { CallbackRef, createMessageId } from './types';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

/**
 * A registered callback with metadata
 */
export interface RegisteredCallback {
  id: string;
  pluginId: string;
  fn: (...args: unknown[]) => unknown;
  createdAt: number;
  invocationCount: number;
  lastInvokedAt?: number;
  description?: string;
}

/**
 * Callback invocation result
 */
export interface CallbackInvocationResult {
  success: boolean;
  result?: unknown;
  error?: Error;
  duration: number;
}

// ============================================================================
// Callback Registry Class
// ============================================================================

/**
 * CallbackRegistry tracks function references for cross-boundary invocation
 */
export class CallbackRegistry {
  private callbacks = new Map<string, RegisteredCallback>();
  private pluginCallbacks = new Map<string, Set<string>>(); // pluginId -> callbackIds
  private maxCallbacksPerPlugin: number;

  constructor(maxCallbacksPerPlugin = 1000) {
    this.maxCallbacksPerPlugin = maxCallbacksPerPlugin;
  }

  /**
   * Register a callback function and return a serializable reference
   */
  register(
    pluginId: string,
    fn: (...args: unknown[]) => unknown,
    description?: string
  ): CallbackRef {
    // Check limit
    const pluginCbs = this.pluginCallbacks.get(pluginId);
    if (pluginCbs && pluginCbs.size >= this.maxCallbacksPerPlugin) {
      throw new Error(
        `Plugin ${pluginId} has reached the maximum number of callbacks (${this.maxCallbacksPerPlugin})`
      );
    }

    const id = `cb_${pluginId}_${createMessageId()}`;

    const callback: RegisteredCallback = {
      id,
      pluginId,
      fn,
      createdAt: Date.now(),
      invocationCount: 0,
      description,
    };

    this.callbacks.set(id, callback);

    // Track by plugin for cleanup
    if (!this.pluginCallbacks.has(pluginId)) {
      this.pluginCallbacks.set(pluginId, new Set());
    }
    this.pluginCallbacks.get(pluginId)!.add(id);

    logger.debug(`[CallbackRegistry] Registered callback ${id} for plugin ${pluginId}`);

    // Return a serializable reference
    return {
      __type: 'CallbackRef',
      callbackId: id,
      signature: {
        paramCount: fn.length,
        isAsync: fn.constructor.name === 'AsyncFunction',
      },
    };
  }

  /**
   * Invoke a callback by its ID
   */
  async invoke(
    callbackId: string,
    args: unknown[]
  ): Promise<CallbackInvocationResult> {
    const startTime = Date.now();

    const callback = this.callbacks.get(callbackId);
    if (!callback) {
      return {
        success: false,
        error: new Error(`Callback ${callbackId} not found or expired`),
        duration: Date.now() - startTime,
      };
    }

    callback.invocationCount++;
    callback.lastInvokedAt = Date.now();

    try {
      const result = await callback.fn(...args);
      return {
        success: true,
        result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      logger.error(`[CallbackRegistry] Callback ${callbackId} threw error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Unregister a specific callback
   */
  unregister(callbackId: string): boolean {
    const callback = this.callbacks.get(callbackId);
    if (!callback) return false;

    this.callbacks.delete(callbackId);

    const pluginCbs = this.pluginCallbacks.get(callback.pluginId);
    if (pluginCbs) {
      pluginCbs.delete(callbackId);
      if (pluginCbs.size === 0) {
        this.pluginCallbacks.delete(callback.pluginId);
      }
    }

    logger.debug(`[CallbackRegistry] Unregistered callback ${callbackId}`);
    return true;
  }

  /**
   * Unregister all callbacks for a plugin
   */
  unregisterPlugin(pluginId: string): number {
    const callbackIds = this.pluginCallbacks.get(pluginId);
    if (!callbackIds) return 0;

    const count = callbackIds.size;
    for (const id of callbackIds) {
      this.callbacks.delete(id);
    }
    this.pluginCallbacks.delete(pluginId);

    logger.debug(
      `[CallbackRegistry] Unregistered ${count} callbacks for plugin ${pluginId}`
    );
    return count;
  }

  /**
   * Check if a callback exists
   */
  has(callbackId: string): boolean {
    return this.callbacks.has(callbackId);
  }

  /**
   * Get callback info (without the function)
   */
  getInfo(callbackId: string): Omit<RegisteredCallback, 'fn'> | null {
    const callback = this.callbacks.get(callbackId);
    if (!callback) return null;

    const { fn, ...info } = callback;
    return info;
  }

  /**
   * Get callback count for a plugin
   */
  getPluginCallbackCount(pluginId: string): number {
    return this.pluginCallbacks.get(pluginId)?.size ?? 0;
  }

  /**
   * Get all callback IDs for a plugin
   */
  getPluginCallbackIds(pluginId: string): string[] {
    const ids = this.pluginCallbacks.get(pluginId);
    return ids ? Array.from(ids) : [];
  }

  /**
   * Get total callback count
   */
  get size(): number {
    return this.callbacks.size;
  }

  /**
   * Get registered plugin count
   */
  get pluginCount(): number {
    return this.pluginCallbacks.size;
  }

  /**
   * Get statistics about callbacks
   */
  getStats(): {
    totalCallbacks: number;
    pluginCount: number;
    byPlugin: Record<string, number>;
    totalInvocations: number;
  } {
    const byPlugin: Record<string, number> = {};
    let totalInvocations = 0;

    for (const [pluginId, ids] of this.pluginCallbacks) {
      byPlugin[pluginId] = ids.size;
    }

    for (const callback of this.callbacks.values()) {
      totalInvocations += callback.invocationCount;
    }

    return {
      totalCallbacks: this.callbacks.size,
      pluginCount: this.pluginCallbacks.size,
      byPlugin,
      totalInvocations,
    };
  }

  /**
   * Clean up stale callbacks (not invoked for a certain time)
   */
  cleanupStale(maxAgeMs = 3600000): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, callback] of this.callbacks) {
      const lastActive = callback.lastInvokedAt ?? callback.createdAt;
      if (now - lastActive > maxAgeMs) {
        this.unregister(id);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(`[CallbackRegistry] Cleaned up ${removed} stale callbacks`);
    }

    return removed;
  }

  /**
   * Clear all callbacks
   */
  clear(): void {
    this.callbacks.clear();
    this.pluginCallbacks.clear();
    logger.debug('[CallbackRegistry] Cleared all callbacks');
  }
}

// ============================================================================
// Worker-Side Callback Proxy
// ============================================================================

/**
 * Pending callback invocation tracker (for worker side)
 */
interface PendingInvocation {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * CallbackProxy creates callable functions from CallbackRefs (for worker side)
 */
export class CallbackProxy {
  private pendingInvocations = new Map<string, PendingInvocation>();
  private defaultTimeoutMs: number;

  constructor(
    private sendMessage: (type: string, data: unknown) => void,
    defaultTimeoutMs = 30000
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Create a callable function from a CallbackRef
   */
  createFunction(ref: CallbackRef): (...args: unknown[]) => Promise<unknown> {
    return async (...args: unknown[]): Promise<unknown> => {
      const invocationId = createMessageId();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingInvocations.delete(invocationId);
          reject(new Error(`Callback ${ref.callbackId} timed out`));
        }, this.defaultTimeoutMs);

        this.pendingInvocations.set(invocationId, { resolve, reject, timeout });

        this.sendMessage('callback:invoke', {
          callbackId: ref.callbackId,
          invocationId,
          args,
        });
      });
    };
  }

  /**
   * Handle callback result from main process
   */
  handleResult(invocationId: string, result: unknown): boolean {
    const pending = this.pendingInvocations.get(invocationId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pendingInvocations.delete(invocationId);
    pending.resolve(result);
    return true;
  }

  /**
   * Handle callback error from main process
   */
  handleError(invocationId: string, error: Error | string): boolean {
    const pending = this.pendingInvocations.get(invocationId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pendingInvocations.delete(invocationId);
    pending.reject(typeof error === 'string' ? new Error(error) : error);
    return true;
  }

  /**
   * Get count of pending invocations
   */
  get pendingCount(): number {
    return this.pendingInvocations.size;
  }

  /**
   * Cancel all pending invocations
   */
  cancelAll(reason = 'Cancelled'): void {
    for (const [, pending] of this.pendingInvocations) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingInvocations.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let callbackRegistryInstance: CallbackRegistry | null = null;

/**
 * Get the global CallbackRegistry instance
 */
export function getCallbackRegistry(): CallbackRegistry {
  if (!callbackRegistryInstance) {
    callbackRegistryInstance = new CallbackRegistry();
  }
  return callbackRegistryInstance;
}

/**
 * Reset the global CallbackRegistry instance (for testing)
 */
export function resetCallbackRegistry(): void {
  callbackRegistryInstance = null;
}
