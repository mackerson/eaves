// Permission Types — canonical definition in shared/types.ts

import type { PluginPermission } from '../../../shared/types';
export type { PluginPermission };

export const PermissionGroups = {
  /** Read-only access to data and events */
  readOnly: [
    'data:agents:read',
    'data:projects:read',
    'data:channels:read',
    'data:chats:read',
    'data:settings:read',
    'events:listen',
    'storage:read',
  ] as PluginPermission[],

  /** Standard plugin permissions */
  standard: [
    'data:agents:read',
    'data:projects:read',
    'data:channels:read',
    'data:chats:read',
    'data:settings:read',
    'data:tasks:write',
    'data:notes:write',
    'events:listen',
    'events:emit',
    'storage:read',
    'storage:write',
    'ui:views:register',
    'ui:notifications:show',
  ] as PluginPermission[],

  /** Tool provider permissions */
  tool: [
    'data:agents:read',
    'data:chats:read',
    'tools:register',
    'events:listen',
    'events:emit',
    'storage:read',
    'storage:write',
  ] as PluginPermission[],

  /** Service provider permissions */
  service: [
    'data:agents:read',
    'data:chats:read',
    'services:register',
    'services:call',
    'events:listen',
    'events:emit',
    'storage:read',
    'storage:write',
  ] as PluginPermission[],
} as const;

// ============================================================================
// Message Protocol Types
// ============================================================================

export type SandboxMessageType =
  // Lifecycle
  | 'plugin:init'
  | 'plugin:ready'
  | 'plugin:error'
  | 'plugin:shutdown'
  // RPC (Request/Response pattern)
  | 'rpc:request'
  | 'rpc:response'
  | 'rpc:error'
  // Callbacks (main -> worker)
  | 'callback:invoke'
  | 'callback:result'
  | 'callback:error'
  // Events (bidirectional)
  | 'event:subscribe'
  | 'event:unsubscribe'
  | 'event:emit'
  | 'event:dispatch'
  // Tools
  | 'tool:execute'
  | 'tool:result'
  // Health
  | 'health:check'
  | 'health:response';

export type APINamespace =
  | 'data'
  | 'actions'
  | 'ui'
  | 'events'
  | 'tools'
  | 'services'
  | 'storage';

export interface SandboxMessage {
  type: SandboxMessageType;
  id: string;
  pluginId: string;
  timestamp: number;
}

export interface PluginInitMessage extends SandboxMessage {
  type: 'plugin:init';
  manifest: {
    id: string;
    name: string;
    version: string;
    permissions: PluginPermission[];
  };
  entryPath: string;
  config: Record<string, unknown>;
}

export interface PluginReadyMessage extends SandboxMessage {
  type: 'plugin:ready';
}

export interface PluginErrorMessage extends SandboxMessage {
  type: 'plugin:error';
  error: SerializedError;
}

export interface PluginShutdownMessage extends SandboxMessage {
  type: 'plugin:shutdown';
  graceful: boolean;
}

// ============================================================================
// RPC Messages
// ============================================================================

export interface RPCRequest extends SandboxMessage {
  type: 'rpc:request';
  namespace: APINamespace;
  method: string;
  args: SerializableValue[];
}

export interface RPCResponse extends SandboxMessage {
  type: 'rpc:response';
  requestId: string;
  result: SerializableValue;
}

export interface RPCError extends SandboxMessage {
  type: 'rpc:error';
  requestId: string;
  error: SerializedError;
}

// ============================================================================
// Callback Messages
// ============================================================================

export interface CallbackRef {
  __type: 'CallbackRef';
  callbackId: string;
  signature?: {
    paramCount: number;
    isAsync: boolean;
  };
}

export interface CallbackInvokeMessage extends SandboxMessage {
  type: 'callback:invoke';
  callbackId: string;
  invocationId: string;
  args: SerializableValue[];
}

export interface CallbackResultMessage extends SandboxMessage {
  type: 'callback:result';
  invocationId: string;
  result: SerializableValue;
}

export interface CallbackErrorMessage extends SandboxMessage {
  type: 'callback:error';
  invocationId: string;
  error: SerializedError;
}

// ============================================================================
// Event Messages
// ============================================================================

export interface EventSubscribeMessage extends SandboxMessage {
  type: 'event:subscribe';
  eventType: string;
  callbackId: string;
}

export interface EventUnsubscribeMessage extends SandboxMessage {
  type: 'event:unsubscribe';
  eventType: string;
  callbackId: string;
}

export interface EventEmitMessage extends SandboxMessage {
  type: 'event:emit';
  eventType: string;
  data: SerializableValue;
}

export interface EventDispatchMessage extends SandboxMessage {
  type: 'event:dispatch';
  eventType: string;
  data: SerializableValue;
  source?: string;
}

// ============================================================================
// Tool Messages
// ============================================================================

export interface ToolExecuteMessage extends SandboxMessage {
  type: 'tool:execute';
  executionId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage extends SandboxMessage {
  type: 'tool:result';
  executionId: string;
  result: SerializableValue;
  error?: SerializedError;
}

// ============================================================================
// Health Messages
// ============================================================================

export interface HealthCheckMessage extends SandboxMessage {
  type: 'health:check';
}

export interface HealthResponseMessage extends SandboxMessage {
  type: 'health:response';
  status: 'healthy' | 'busy' | 'degraded';
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  activeRequests: number;
}

// ============================================================================
// Serialization Types
// ============================================================================

export type SerializableValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | SerializableValue[]
  | { [key: string]: SerializableValue }
  | CallbackRef;

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

// ============================================================================
// Worker State Types
// ============================================================================

export type WorkerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed';

export interface ResourceLimits {
  /** Maximum heap memory in MB (default: 128) */
  maxHeapMB: number;
  /** Maximum old generation heap in MB (default: 96) */
  maxOldGenerationMB: number;
  /** API call timeout in ms (default: 30000) */
  apiTimeoutMs: number;
  /** Tool execution timeout in ms (default: 120000) */
  toolTimeoutMs: number;
  /** Health check interval in ms (default: 10000) */
  healthCheckIntervalMs: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxHeapMB: 128,
  maxOldGenerationMB: 96,
  apiTimeoutMs: 30000,
  toolTimeoutMs: 120000,
  healthCheckIntervalMs: 10000,
};

export interface WorkerConfig {
  pluginId: string;
  manifestPath: string;
  entryPath: string;
  permissions: PluginPermission[];
  config: Record<string, unknown>;
  resourceLimits?: Partial<ResourceLimits>;
  /**
   * Resolved Electron paths passed in to the worker so plugins don't need
   * `require('electron')` (which fails in worker threads). Filled in by the
   * SandboxedPluginManager from `app.getPath(...)` at startup.
   */
  userDataPath: string;
  avatarsPath: string;
}

export interface WorkerHealth {
  state: WorkerState;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    percentUsed: number;
  };
  activeRequests: number;
  lastHealthCheck: number;
  uptime: number;
  restartCount: number;
}

// ============================================================================
// Union Types for Message Handling
// ============================================================================

export type WorkerToMainMessage =
  | PluginReadyMessage
  | PluginErrorMessage
  | RPCRequest
  | CallbackResultMessage
  | CallbackErrorMessage
  | EventSubscribeMessage
  | EventUnsubscribeMessage
  | EventEmitMessage
  | ToolResultMessage
  | HealthResponseMessage;

export type MainToWorkerMessage =
  | PluginInitMessage
  | PluginShutdownMessage
  | RPCResponse
  | RPCError
  | CallbackInvokeMessage
  | EventDispatchMessage
  | ToolExecuteMessage
  | HealthCheckMessage;

export function isCallbackRef(value: unknown): value is CallbackRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    (value as CallbackRef).__type === 'CallbackRef'
  );
}

export function createMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
