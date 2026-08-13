/**
 * Plugin Sandbox Protocol
 *
 * Message serialization, validation, and utility functions
 * for communication between main process and worker threads.
 */

import {
  SerializableValue,
  SerializedError,
  SandboxMessage,
  RPCRequest,
  RPCResponse,
  RPCError,
  APINamespace,
  createMessageId,
  isCallbackRef
} from './types';

// ============================================================================
// Serialization
// ============================================================================

/**
 * Check if a value is serializable (can cross worker boundary)
 */
export function isSerializable(value: unknown, visited = new WeakSet()): boolean {
  // Primitives
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return !Number.isNaN(value) && Number.isFinite(value);
  if (typeof value === 'string') return true;

  // Functions are not serializable
  if (typeof value === 'function') return false;

  // Symbols are not serializable
  if (typeof value === 'symbol') return false;

  // Objects
  if (typeof value === 'object') {
    // Check for circular references
    if (visited.has(value)) return false;
    visited.add(value);

    // CallbackRef is a special serializable marker
    if (isCallbackRef(value)) return true;

    // Arrays
    if (Array.isArray(value)) {
      return value.every((item) => isSerializable(item, visited));
    }

    // Plain objects only
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      // Not a plain object (e.g., Date, Map, Set, class instance)
      return false;
    }

    // Check all values
    return Object.values(value).every((v) => isSerializable(v, visited));
  }

  return false;
}

/**
 * Deep clone a value, replacing non-serializable values with placeholders
 */
export function sanitizeForSerialization(
  value: unknown,
  visited = new WeakMap<object, unknown>()
): SerializableValue {
  // Primitives
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null;
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'string') return value;

  // Functions become null
  if (typeof value === 'function') return null;

  // Symbols become null
  if (typeof value === 'symbol') return null;

  // Objects
  if (typeof value === 'object') {
    // Check for circular references
    if (visited.has(value)) {
      return '[Circular]' as SerializableValue;
    }

    // CallbackRef passes through
    if (isCallbackRef(value)) return value;

    // Arrays
    if (Array.isArray(value)) {
      visited.set(value, []);
      const result = value.map((item) => sanitizeForSerialization(item, visited));
      visited.set(value, result);
      return result;
    }

    // Handle special objects
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return serializeError(value) as unknown as SerializableValue;
    }
    if (value instanceof Map) {
      return Object.fromEntries(
        Array.from(value.entries()).map(([k, v]) => [
          String(k),
          sanitizeForSerialization(v, visited),
        ])
      );
    }
    if (value instanceof Set) {
      return Array.from(value).map((v) => sanitizeForSerialization(v, visited));
    }

    // Plain objects
    visited.set(value, {});
    const result: Record<string, SerializableValue> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = sanitizeForSerialization(val, visited);
    }
    visited.set(value, result);
    return result;
  }

  return null;
}

/**
 * Serialize an error for transmission
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
      stack: error.stack,
    };
  }

  if (typeof error === 'string') {
    return {
      name: 'Error',
      message: error,
    };
  }

  return {
    name: 'UnknownError',
    message: String(error),
  };
}

/**
 * Deserialize an error from transmission
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
  if (serialized.code) {
    (error as NodeJS.ErrnoException).code = serialized.code;
  }
  return error;
}

// ============================================================================
// Message Creation
// ============================================================================

/**
 * Create an RPC request message
 */
export function createRPCRequest(
  pluginId: string,
  namespace: APINamespace,
  method: string,
  args: SerializableValue[]
): RPCRequest {
  return {
    type: 'rpc:request',
    id: createMessageId(),
    pluginId,
    timestamp: Date.now(),
    namespace,
    method,
    args,
  };
}

/**
 * Create an RPC response message
 */
export function createRPCResponse(
  pluginId: string,
  requestId: string,
  result: SerializableValue
): RPCResponse {
  return {
    type: 'rpc:response',
    id: createMessageId(),
    pluginId,
    timestamp: Date.now(),
    requestId,
    result: sanitizeForSerialization(result),
  };
}

/**
 * Create an RPC error message
 */
export function createRPCError(
  pluginId: string,
  requestId: string,
  error: unknown
): RPCError {
  return {
    type: 'rpc:error',
    id: createMessageId(),
    pluginId,
    timestamp: Date.now(),
    requestId,
    error: serializeError(error),
  };
}

// ============================================================================
// Message Validation
// ============================================================================

const VALID_NAMESPACES: APINamespace[] = [
  'data',
  'actions',
  'ui',
  'events',
  'tools',
  'services',
  'storage',
];

/**
 * Validate a sandbox message has required fields
 */
export function validateMessage(message: unknown): message is SandboxMessage {
  if (typeof message !== 'object' || message === null) return false;

  const msg = message as Record<string, unknown>;

  return (
    typeof msg.type === 'string' &&
    typeof msg.id === 'string' &&
    typeof msg.pluginId === 'string' &&
    typeof msg.timestamp === 'number'
  );
}

/**
 * Validate an RPC request message
 */
export function validateRPCRequest(message: unknown): message is RPCRequest {
  if (!validateMessage(message)) return false;

  const msg = message as RPCRequest;

  return (
    msg.type === 'rpc:request' &&
    typeof msg.namespace === 'string' &&
    VALID_NAMESPACES.includes(msg.namespace) &&
    typeof msg.method === 'string' &&
    msg.method.length > 0 &&
    Array.isArray(msg.args)
  );
}

/**
 * Validate an RPC response message
 */
export function validateRPCResponse(message: unknown): message is RPCResponse {
  if (!validateMessage(message)) return false;

  const msg = message as RPCResponse;

  return msg.type === 'rpc:response' && typeof msg.requestId === 'string';
}

/**
 * Validate an RPC error message
 */
export function validateRPCError(message: unknown): message is RPCError {
  if (!validateMessage(message)) return false;

  const msg = message as RPCError;

  return (
    msg.type === 'rpc:error' &&
    typeof msg.requestId === 'string' &&
    typeof msg.error === 'object' &&
    msg.error !== null
  );
}

// ============================================================================
// Request/Response Correlation
// ============================================================================

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  createdAt: number;
}

/**
 * Manages pending RPC requests with timeout handling
 */
export class RequestCorrelator<T = unknown> {
  private pending = new Map<string, PendingRequest<T>>();
  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 30000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Register a pending request
   */
  register(requestId: string, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request ${requestId} timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`));
      }, timeoutMs ?? this.defaultTimeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        createdAt: Date.now(),
      });
    });
  }

  /**
   * Resolve a pending request
   */
  resolve(requestId: string, result: T): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(result);
    return true;
  }

  /**
   * Reject a pending request
   */
  reject(requestId: string, error: Error): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.reject(error);
    return true;
  }

  /**
   * Check if a request is pending
   */
  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Get count of pending requests
   */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(reason = 'Cancelled'): void {
    for (const [_requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * Get stats about pending requests
   */
  getStats(): { count: number; oldest: number | null } {
    let oldest: number | null = null;
    for (const pending of this.pending.values()) {
      if (oldest === null || pending.createdAt < oldest) {
        oldest = pending.createdAt;
      }
    }
    return { count: this.pending.size, oldest };
  }
}

// ============================================================================
// Method Path Utilities
// ============================================================================

/**
 * Parse a method path like "agents.getAll" into namespace and method
 */
export function parseMethodPath(path: string): { namespace: string; method: string } | null {
  const parts = path.split('.');
  if (parts.length < 2) return null;

  const namespace = parts[0];
  const method = parts.slice(1).join('.');

  return { namespace, method };
}

/**
 * Create a method path from namespace and method
 */
export function createMethodPath(namespace: string, method: string): string {
  return `${namespace}.${method}`;
}
