/**
 * Worker Entry Point
 *
 * This script runs inside each sandboxed plugin Worker Thread.
 * It sets up the sandbox environment, restricts dangerous APIs,
 * and loads the plugin with a proxied context.
 */

import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import { createRequire } from 'module';
import {
  MainToWorkerMessage,
  PluginReadyMessage,
  PluginErrorMessage,
  RPCRequest,
  EventSubscribeMessage,
  EventUnsubscribeMessage,
  EventEmitMessage,
  ToolResultMessage,
  HealthResponseMessage,
  PluginPermission,
  createMessageId,
  SerializableValue
} from './types';
import { serializeError, sanitizeForSerialization, RequestCorrelator } from './protocol';
import { isInsideDirectory } from './pathContainment';

// ============================================================================
// Worker Data
// ============================================================================

interface WorkerData {
  pluginId: string;
  manifestPath: string;
  entryPath: string;
  permissions: PluginPermission[];
  config: Record<string, unknown>;
  paths: {
    userData: string;
    avatars: string;
  };
}

const data = workerData as WorkerData;

// ============================================================================
// Sandbox Hardening
// ============================================================================

// Modules that are NOT allowed in sandboxed plugins.
//
// ADVISORY ONLY — this list is not a security boundary. Two known gaps:
//   1. sandboxedRequire is installed on `globalThis.require`, but Node's CJS
//      module wrapper gives every module its own `require` that shadows the
//      global — so a plugin's own `require('fs')` never reaches this gate.
//      Bundled plugins rely on that today (see character-card-import).
//   2. Entries are bare names, and the lookup uses moduleId.split('/')[0], so
//      `node:fs` matches neither this set nor ALLOWED_MODULES and falls
//      through to the unconditional require at the end of sandboxedRequire.
// The enforced boundaries are worker-thread isolation, PermissionGate on the
// RPC bridge, and ResourceMonitor. Plugins are trusted-by-install.
const FORBIDDEN_MODULES = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'vm',
  'worker_threads',
  'v8',
  'repl',
  'readline',
  'perf_hooks',
  'inspector',
  'async_hooks',
]);

// Modules that ARE allowed
const ALLOWED_MODULES = new Set([
  'path',
  'url',
  'querystring',
  'util',
  'events',
  'buffer',
  'string_decoder',
  'stream',
  'crypto', // For hashing/random, not for network
  'assert',
  'zlib',
]);

// Create a sandboxed require function
const pluginDir = path.dirname(data.entryPath);
const originalRequire = createRequire(data.entryPath);

function sandboxedRequire(moduleId: string): unknown {
  const baseModule = moduleId.split('/')[0];

  // `electron` is genuinely unresolvable inside a worker thread — a top-level
  // require('electron') in a bundled plugin's lib crashed it on EVERY app start
  // with a raw MODULE_NOT_FOUND (observed in the field, silently, for months).
  // Fail loudly and actionably instead, pointing at the supported API.
  if (baseModule === 'electron') {
    throw new Error(
      `Module 'electron' is not available in sandboxed plugins. ` +
      `Use the plugin 'context' API instead — e.g. context.utils.paths for ` +
      `userData/app paths.`
    );
  }

  // Check forbidden modules
  if (FORBIDDEN_MODULES.has(baseModule)) {
    throw new Error(
      `Module '${moduleId}' is not allowed in sandboxed plugins. ` +
      `This module provides capabilities that could be used to bypass sandbox restrictions.`
    );
  }

  // Allow built-in modules that are safe
  if (ALLOWED_MODULES.has(baseModule)) {
    return originalRequire(moduleId);
  }

  // Allow relative imports within the plugin. path.isAbsolute() catches
  // Windows absolute paths (C:\..., \\server\share) that a startsWith('/')
  // check would miss and leave unguarded.
  if (moduleId.startsWith('.') || path.isAbsolute(moduleId)) {
    const resolvedPath = path.resolve(pluginDir, moduleId);
    // Ensure the path stays within the plugin directory.
    if (!isInsideDirectory(resolvedPath, pluginDir)) {
      throw new Error(
        `Cannot require modules outside plugin directory: ${moduleId}`
      );
    }
    return originalRequire(moduleId);
  }

  // Allow node_modules within the plugin
  try {
    const resolved = originalRequire.resolve(moduleId);
    // Check if it's within the plugin directory or a safe location
    if (resolved.includes('node_modules')) {
      return originalRequire(moduleId);
    }
  } catch {
    // Module not found - let it throw naturally
  }

  return originalRequire(moduleId);
}

// Override global require
(globalThis as unknown as { require: typeof sandboxedRequire }).require = sandboxedRequire;

// Restrict dangerous globals
const restrictedGlobals: Array<[string, unknown]> = [
  // eval and Function can execute arbitrary code
  ['eval', undefined],
  ['Function', class RestrictedFunction {
    constructor() {
      throw new Error('Function constructor is disabled in sandboxed plugins');
    }
  }],
];

for (const [name, replacement] of restrictedGlobals) {
  try {
    Object.defineProperty(globalThis, name, {
      value: replacement,
      writable: false,
      configurable: false,
    });
  } catch {
    // Some properties may not be configurable
  }
}

// ============================================================================
// Plugin Context Proxy
// ============================================================================

const rpcCorrelator = new RequestCorrelator(30000);
const eventHandlers = new Map<string, Map<string, (data: SerializableValue) => void>>();
const toolExecutors = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

/**
 * Send a message to the main process
 */
function sendMessage(message: unknown): void {
  parentPort?.postMessage(message);
}

/**
 * Make an RPC call to the main process
 */
async function rpc(
  namespace: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const requestId = createMessageId();

  const request: RPCRequest = {
    type: 'rpc:request',
    id: requestId,
    pluginId: data.pluginId,
    timestamp: Date.now(),
    namespace: namespace as RPCRequest['namespace'],
    method,
    args: args.map((arg) => sanitizeForSerialization(arg) as SerializableValue),
  };

  const responsePromise = rpcCorrelator.register(requestId);
  sendMessage(request);
  return responsePromise;
}

/**
 * Create the sandboxed plugin context
 */
function createPluginContext() {
  return {
    // Plugin metadata
    plugin: {
      id: data.pluginId,
      config: data.config,
    },

    // Logging
    log: {
      debug: (message: string, ...args: unknown[]) => {
      },
      info: (message: string, ...args: unknown[]) => {
      },
      warn: (message: string, ...args: unknown[]) => {
      },
      error: (message: string, ...args: unknown[]) => {
        console.error(`[Plugin:${data.pluginId}]`, message, ...args);
      },
    },

    // Data access (read-only)
    data: {
      agents: {
        getAll: () => rpc('data', 'agents.getAll', []),
        getById: (id: string) => rpc('data', 'agents.getById', [id]),
      },
      projects: {
        getAll: () => rpc('data', 'projects.getAll', []),
        getById: (id: string) => rpc('data', 'projects.getById', [id]),
        getCurrent: () => rpc('data', 'projects.getCurrent', []),
      },
      channels: {
        getAll: () => rpc('data', 'channels.getAll', []),
        getById: (id: string) => rpc('data', 'channels.getById', [id]),
        getCurrent: () => rpc('data', 'channels.getCurrent', []),
      },
      chats: {
        getAll: (options?: unknown) => rpc('data', 'chats.getAll', [options]),
        getById: (id: string) => rpc('data', 'chats.getById', [id]),
        getByAgent: (agentId: string, options?: unknown) =>
          rpc('data', 'chats.getByAgent', [agentId, options]),
        getCurrent: () => rpc('data', 'chats.getCurrent', []),
      },
      settings: {
        get: () => rpc('data', 'settings.get', []),
        getCurrent: () => rpc('data', 'settings.getCurrent', []),
      },
    },

    // Actions (mutations)
    actions: {
      createTask: (projectId: string, content: string) =>
        rpc('actions', 'createTask', [projectId, content]),
      createNote: (projectId: string, content: string) =>
        rpc('actions', 'createNote', [projectId, content]),
      createChat: (params: unknown) =>
        rpc('actions', 'createChat', [params]),
      createAgent: (params: unknown) =>
        rpc('actions', 'createAgent', [params]),
      bulkImportMessages: (chatId: string, messages: unknown[]) =>
        rpc('actions', 'bulkImportMessages', [chatId, messages]),
      bulkImportAttachments: (attachments: unknown[]) =>
        rpc('actions', 'bulkImportAttachments', [attachments]),
    },

    // UI
    ui: {
      showNotification: (message: string, type?: string) =>
        rpc('ui', 'showNotification', [message, type]),
      showToast: (message: string, duration?: number) =>
        rpc('ui', 'showToast', [message, duration]),
      registerView: (view: unknown) =>
        rpc('ui', 'registerView', [view]),
      registerTerminalView: (view: unknown) =>
        rpc('ui', 'registerTerminalView', [view]),
      registerSidebarItem: (item: unknown) =>
        rpc('ui', 'registerSidebarItem', [item]),
      registerCommand: (command: unknown) =>
        rpc('ui', 'registerCommand', [command]),
    },

    // Events
    events: {
      on: (eventType: string, handler: (data: SerializableValue) => void) => {
        const callbackId = createMessageId();

        // Store handler locally
        if (!eventHandlers.has(eventType)) {
          eventHandlers.set(eventType, new Map());
        }
        eventHandlers.get(eventType)!.set(callbackId, handler);

        // Subscribe via main process
        const message: EventSubscribeMessage = {
          type: 'event:subscribe',
          id: createMessageId(),
          pluginId: data.pluginId,
          timestamp: Date.now(),
          eventType,
          callbackId,
        };
        sendMessage(message);

        return callbackId;
      },

      off: (eventType: string, callbackId: string) => {
        const handlers = eventHandlers.get(eventType);
        if (handlers) {
          handlers.delete(callbackId);
          if (handlers.size === 0) {
            eventHandlers.delete(eventType);
          }
        }

        // Unsubscribe via main process
        const message: EventUnsubscribeMessage = {
          type: 'event:unsubscribe',
          id: createMessageId(),
          pluginId: data.pluginId,
          timestamp: Date.now(),
          eventType,
          callbackId,
        };
        sendMessage(message);
      },

      once: (eventType: string, handler: (data: SerializableValue) => void) => {
        const callbackId = createMessageId();

        const wrappedHandler = (eventData: SerializableValue) => {
          // Remove after first call
          const handlers = eventHandlers.get(eventType);
          if (handlers) {
            handlers.delete(callbackId);
          }
          handler(eventData);
        };

        if (!eventHandlers.has(eventType)) {
          eventHandlers.set(eventType, new Map());
        }
        eventHandlers.get(eventType)!.set(callbackId, wrappedHandler);

        const message: EventSubscribeMessage = {
          type: 'event:subscribe',
          id: createMessageId(),
          pluginId: data.pluginId,
          timestamp: Date.now(),
          eventType,
          callbackId,
        };
        sendMessage(message);

        return callbackId;
      },

      emit: (eventType: string, eventData: SerializableValue) => {
        const message: EventEmitMessage = {
          type: 'event:emit',
          id: createMessageId(),
          pluginId: data.pluginId,
          timestamp: Date.now(),
          eventType,
          data: sanitizeForSerialization(eventData),
        };
        sendMessage(message);
      },
    },

    // Tools
    tools: {
      register: (
        name: string,
        tool: {
          description: string;
          // Plugin authors may declare the schema under either key:
          // `inputSchema` or `parameters`. We normalize to `inputSchema`
          // before crossing the RPC boundary so all downstream code sees one
          // shape. See ToolBridge for the receiver.
          inputSchema?: unknown;
          parameters?: unknown;
          execute: (args: Record<string, unknown>) => Promise<unknown>;
          // Static approval gate. true = always require approval, false/undefined = never.
          // Function-form needsApproval is not yet supported across the worker
          // boundary (would require an RPC roundtrip per call).
          needsApproval?: boolean;
        }
      ) => {
        // Store executor locally
        toolExecutors.set(name, tool.execute);

        // Register definition with main process
        return rpc('tools', 'register', [
          name,
          {
            description: tool.description,
            inputSchema: tool.inputSchema ?? tool.parameters,
            needsApproval: tool.needsApproval === true,
          },
        ]);
      },

      unregister: (name: string) => {
        toolExecutors.delete(name);
        return rpc('tools', 'unregister', [name]);
      },
    },

    // Services
    services: {
      register: (
        serviceType: string,
        api: Record<string, (...args: unknown[]) => unknown>,
        metadata?: unknown
      ) => {
        // Store methods locally and register names with main
        const methodNames = Object.keys(api).filter(
          (k) => typeof api[k] === 'function'
        );

        // Store for local invocation. The bridge invokes tool executors with a
        // single input object; for service methods that input is `{ args: [...] }`
        // (see ServiceBridge.callServiceMethod), so unwrap and spread the
        // positional args onto the real API method — passing the wrapper object
        // straight through would hand `store({args:[…]})` and lose key/value.
        for (const methodName of methodNames) {
          toolExecutors.set(`service:${serviceType}:${methodName}`, async (input: { args?: unknown[] }) => {
            return api[methodName](...(input?.args ?? []));
          });
        }

        return rpc('services', 'register', [serviceType, methodNames, metadata]);
      },

      unregister: (serviceType: string) =>
        rpc('services', 'unregister', [serviceType]),

      discover: (serviceType: string) =>
        rpc('services', 'discover', [serviceType]),

      get: async (serviceType: string, providerPluginId: string) => {
        const result = await rpc(
          'services',
          'get',
          [serviceType, providerPluginId]
        ) as { methods: string[] } | null;

        if (!result) return null;

        // Create proxy API
        const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
        for (const methodName of result.methods) {
          proxy[methodName] = (...args: unknown[]) =>
            rpc('services', 'call', [serviceType, providerPluginId, methodName, ...args]);
        }
        return proxy;
      },

      // Returns the same callable proxy shape as `get`. Callers use the two
      // interchangeably — chatgpt-import assigns either to `_processor` and
      // then invokes methods on it — so returning the raw RPC payload here
      // would hand back a plain object and fail on first method call.
      getDefault: async (serviceType: string) => {
        const result = await rpc(
          'services',
          'getDefault',
          [serviceType]
        ) as { pluginId: string; methods: string[] } | null;

        if (!result) return null;

        const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
        for (const methodName of result.methods) {
          proxy[methodName] = (...args: unknown[]) =>
            rpc('services', 'call', [serviceType, result.pluginId, methodName, ...args]);
        }
        return proxy;
      },

      call: (serviceType: string, method: string, ...args: unknown[]) =>
        rpc('services', 'call', [serviceType, method, ...args]),

      hasProviders: (serviceType: string) =>
        rpc('services', 'hasProviders', [serviceType]),
    },

    // Utils
    utils: {
      storage: {
        get: (key: string) => rpc('storage', 'get', [key]),
        set: (key: string, value: unknown) =>
          rpc('storage', 'set', [key, value]),
        delete: (key: string) => rpc('storage', 'delete', [key]),
        clear: () => rpc('storage', 'clear', []),
        keys: () => rpc('storage', 'keys', []) as Promise<string[]>,
      },
      log: {
        debug: (message: string, logData?: unknown) =>
          console.debug(`[Plugin:${data.pluginId}]`, message, ...(logData === undefined ? [] : [logData])),
        info: (message: string, logData?: unknown) =>
          console.info(`[Plugin:${data.pluginId}]`, message, ...(logData === undefined ? [] : [logData])),
        warn: (message: string, logData?: unknown) =>
          console.warn(`[Plugin:${data.pluginId}]`, message, ...(logData === undefined ? [] : [logData])),
        error: (message: string, logData?: unknown) =>
          console.error(`[Plugin:${data.pluginId}]`, message, ...(logData === undefined ? [] : [logData])),
      },
      // Resolved paths handed in via workerData. Plugins use these instead
      // of `require('electron').app.getPath(...)` (Electron's app object
      // isn't available inside worker threads).
      paths: data.paths,
    },
  };
}

// ============================================================================
// Message Handler
// ============================================================================

type PluginModule = {
  activate?: (ctx: unknown) => void | Promise<void>;
  deactivate?: (ctx: unknown) => void | Promise<void>;
};

/**
 * Set once activate() resolves, so the shutdown handler can reach the module
 * and its context. deactivate is only called for a plugin that finished
 * activating — a plugin whose activate threw never had a chance to take
 * ownership of anything worth releasing.
 */
let activePlugin: { module: PluginModule; context: unknown } | null = null;

/**
 * The host waits 5s for a graceful exit (PluginWorker.stop), so deactivate gets
 * a strictly smaller slice of that. It runs at most once, and a hook that
 * throws or hangs is logged and stepped over: shutdown is also the path taken
 * by disable, update, and uninstall, and plugin code must not be able to wedge
 * any of them.
 */
const DEACTIVATE_TIMEOUT_MS = 3000;

async function runDeactivate(): Promise<void> {
  const active = activePlugin;
  activePlugin = null;
  if (!active || typeof active.module.deactivate !== 'function') return;

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(active.module.deactivate(active.context)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deactivate exceeded ${DEACTIVATE_TIMEOUT_MS}ms`)),
          DEACTIVATE_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    console.error(`[Plugin:${data.pluginId}] deactivate failed:`, error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

parentPort?.on('message', async (message: MainToWorkerMessage) => {
  try {
    switch (message.type) {
      case 'plugin:shutdown':
        // Give the plugin its deactivate hook before tearing anything down.
        // Ordered ahead of cancelAll on purpose: deactivate's whole point is
        // flushing state, which it does over RPC to the host.
        await runDeactivate();
        rpcCorrelator.cancelAll('Shutdown');
        process.exit(0);
        break;

      case 'rpc:response':
        rpcCorrelator.resolve(message.requestId, message.result);
        break;

      case 'rpc:error':
        rpcCorrelator.reject(
          message.requestId,
          new Error(message.error.message)
        );
        break;

      case 'event:dispatch':
        // Dispatch to local handlers
        const handlers = eventHandlers.get(message.eventType);
        if (handlers) {
          for (const handler of handlers.values()) {
            try {
              handler(message.data);
            } catch (error) {
              console.error(
                `[Plugin:${data.pluginId}] Event handler error:`,
                error
              );
            }
          }
        }
        break;

      case 'callback:invoke':
        // No-op: the main process reaches plugin code through `event:dispatch`
        // and `tool:execute`, not through direct callback invocation.
        break;

      case 'tool:execute':
        // Execute a tool
        const executor = toolExecutors.get(message.toolName);
        const resultMessage: ToolResultMessage = {
          type: 'tool:result',
          id: createMessageId(),
          pluginId: data.pluginId,
          timestamp: Date.now(),
          executionId: message.executionId,
          result: null,
        };

        if (!executor) {
          resultMessage.error = {
            name: 'ToolNotFound',
            message: `Tool '${message.toolName}' not found`,
          };
        } else {
          try {
            const result = await executor(message.args);
            resultMessage.result = sanitizeForSerialization(result);
          } catch (error) {
            resultMessage.error = serializeError(error);
          }
        }

        sendMessage(resultMessage);
        break;

      case 'health:check':
        // Respond to health check
        const memUsage = process.memoryUsage();
        const healthResponse: HealthResponseMessage = {
          type: 'health:response',
          id: createMessageId(),
          pluginId: data.pluginId,
          timestamp: Date.now(),
          status: 'healthy',
          memoryUsage: {
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
          },
          activeRequests: rpcCorrelator.size,
        };
        sendMessage(healthResponse);
        break;
    }
  } catch (error) {
    console.error(`[Plugin:${data.pluginId}] Message handler error:`, error);
  }
});

// ============================================================================
// Plugin Loading
// ============================================================================

async function main(): Promise<void> {
  try {
    // Create the sandboxed context
    const context = createPluginContext();

    // Load the plugin module
    const pluginModule = sandboxedRequire(data.entryPath) as PluginModule;

    // Activate the plugin
    if (typeof pluginModule.activate === 'function') {
      await pluginModule.activate(context);
    }

    // Only now is the plugin eligible for deactivate on shutdown.
    activePlugin = { module: pluginModule, context };

    // Signal ready
    const readyMessage: PluginReadyMessage = {
      type: 'plugin:ready',
      id: createMessageId(),
      pluginId: data.pluginId,
      timestamp: Date.now(),
    };
    sendMessage(readyMessage);

    context.log.info('Plugin activated successfully');
  } catch (error) {
    // Signal error
    const errorMessage: PluginErrorMessage = {
      type: 'plugin:error',
      id: createMessageId(),
      pluginId: data.pluginId,
      timestamp: Date.now(),
      error: serializeError(error),
    };
    sendMessage(errorMessage);

    // Exit with error code
    process.exit(1);
  }
}

// Start the plugin
main();
