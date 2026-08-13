/**
 * Plugin Sandbox System
 *
 * Provides full process isolation for plugins using Worker Threads.
 * This module exports all sandbox-related functionality.
 */

// Types
export * from './types';

// Protocol
export {
  isSerializable,
  sanitizeForSerialization,
  serializeError,
  deserializeError,
  createRPCRequest,
  createRPCResponse,
  createRPCError,
  validateMessage,
  validateRPCRequest,
  validateRPCResponse,
  validateRPCError,
  RequestCorrelator,
  parseMethodPath,
  createMethodPath,
} from './protocol';

// Permission Gate
export {
  PermissionGate,
  PermissionDeniedError,
  getPermissionGate,
  resetPermissionGate,
} from './PermissionGate';
export type { PermissionCheckResult, PluginPermissionSet } from './PermissionGate';

// Callback Registry
export {
  CallbackRegistry,
  CallbackProxy,
  getCallbackRegistry,
  resetCallbackRegistry,
} from './CallbackRegistry';
export type { RegisteredCallback, CallbackInvocationResult } from './CallbackRegistry';

// Plugin Worker
export { PluginWorker } from './PluginWorker';
export type { PluginWorkerEvents } from './PluginWorker';

// Bridges
export { EventBridge, getEventBridge, resetEventBridge, isHostOwnedEventType } from './EventBridge';
export { ToolBridge, getToolBridge, resetToolBridge } from './ToolBridge';
export type { PluginTool } from './ToolBridge';
export { ServiceBridge, getServiceBridge, resetServiceBridge } from './ServiceBridge';

// Resource Monitor
export {
  ResourceMonitor,
  getResourceMonitor,
  resetResourceMonitor,
} from './ResourceMonitor';

// Sandboxed Plugin Manager
export {
  SandboxedPluginManager,
  getSandboxedPluginManager,
  resetSandboxedPluginManager,
} from './SandboxedPluginManager';
