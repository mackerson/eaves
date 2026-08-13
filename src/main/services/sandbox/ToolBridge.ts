/**
 * Tool Bridge
 *
 * Bridges tool registrations between sandboxed plugins and the main process.
 * Tools are registered with the main process but execute in the worker.
 */

import { eventBus } from '../EventBus';
import { PluginWorker } from './PluginWorker';
import { SerializableValue } from './types';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

interface ToolDefinition {
  description: string;
  // The only schema key that reaches the bridge — a plugin declaring
  // `parameters` instead is normalized to `inputSchema` by
  // SandboxedPluginManager.handleToolsRequest first.
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** Static approval gate. Function form is not yet supported for plugins. */
  needsApproval?: boolean;
}

interface RegisteredTool {
  pluginId: string;
  name: string; // The namespaced name
  originalName: string; // The original name (for worker execution)
  definition: ToolDefinition;
  worker: PluginWorker;
}

/**
 * Plugin tool interface (for registration events).
 *
 * Consumers in the main process build an AI SDK `tool({...})` from this shape.
 * Plugin authors declare these on their tool object inside the worker; their
 * values flow over the RPC boundary normalized by worker-entry.
 */
export interface PluginTool {
  description: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  /** SDK-native HITL gate. true = always require approval. */
  needsApproval?: boolean;
}

// ============================================================================
// Tool Bridge Class
// ============================================================================

/**
 * ToolBridge manages tool registrations for sandboxed plugins
 */
export class ToolBridge {
  private tools = new Map<string, RegisteredTool>(); // toolName -> registration
  private pluginTools = new Map<string, Set<string>>(); // pluginId -> toolNames
  private workers = new Map<string, PluginWorker>(); // pluginId -> worker

  /**
   * Register a worker with the bridge
   */
  registerWorker(pluginId: string, worker: PluginWorker): void {
    this.workers.set(pluginId, worker);
    logger.debug(`[ToolBridge] Registered worker for plugin ${pluginId}`);
  }

  /**
   * Unregister a worker and cleanup tools
   */
  unregisterWorker(pluginId: string): void {
    this.workers.delete(pluginId);
    this.cleanupPlugin(pluginId);
    logger.debug(`[ToolBridge] Unregistered worker for plugin ${pluginId}`);
  }

  /**
   * Register a tool from a plugin
   */
  registerTool(pluginId: string, name: string, definition: ToolDefinition): void {
    const worker = this.workers.get(pluginId);
    if (!worker) {
      logger.warn(`[ToolBridge] Cannot register tool: worker ${pluginId} not found`);
      return;
    }

    // Construct namespaced name to prevent collisions
    // Sanitize to match API tool name pattern: ^[a-zA-Z0-9_-]{1,128}$
    const namespacedName = `${pluginId}__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Check for duplicate
    const existing = this.tools.get(namespacedName);
    if (existing && existing.pluginId !== pluginId) {
      logger.warn(
        `[ToolBridge] Tool '${namespacedName}' already registered by plugin ${existing.pluginId}`
      );
      return;
    }

    // Store registration
    const registration: RegisteredTool = {
      pluginId,
      name: namespacedName,
      originalName: name,
      definition,
      worker,
    };
    this.tools.set(namespacedName, registration);

    // Track by plugin
    if (!this.pluginTools.has(pluginId)) {
      this.pluginTools.set(pluginId, new Set());
    }
    this.pluginTools.get(pluginId)!.add(namespacedName);

    // Create proxy tool for the main process
    const proxyTool: PluginTool = {
      description: definition.description,
      inputSchema: definition.inputSchema,
      needsApproval: definition.needsApproval === true,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        return this.executeTool(namespacedName, args);
      },
    };

    // Emit registration event for PluginManager
    eventBus.emitEvent('plugin:tool:registered', {
      name: namespacedName,
      tool: proxyTool,
      pluginId,
    });

    logger.info(`[ToolBridge] Registered tool '${namespacedName}' from plugin ${pluginId}`);
  }

  /**
   * Unregister a tool
   */
  unregisterTool(pluginId: string, name: string): boolean {
    const namespacedName = `${pluginId}__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const registration = this.tools.get(namespacedName);
    if (!registration || registration.pluginId !== pluginId) {
      return false;
    }

    this.tools.delete(namespacedName);

    const pluginToolSet = this.pluginTools.get(pluginId);
    if (pluginToolSet) {
      pluginToolSet.delete(namespacedName);
      if (pluginToolSet.size === 0) {
        this.pluginTools.delete(pluginId);
      }
    }

    // Emit unregistration event
    eventBus.emitEvent('plugin:tool:unregistered', {
      name: namespacedName,
      pluginId,
    });

    logger.info(`[ToolBridge] Unregistered tool '${namespacedName}' from plugin ${pluginId}`);
    return true;
  }

  /**
   * Execute a tool
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<SerializableValue> {
    const registration = this.tools.get(name);
    if (!registration) {
      throw new Error(`Tool '${name}' not found`);
    }

    if (!registration.worker.isRunning()) {
      throw new Error(
        `Plugin ${registration.pluginId} is not running, cannot execute tool '${name}'`
      );
    }

    logger.debug(`[ToolBridge] Executing tool '${name}' with args:`, args);

    const result = await registration.worker.executeTool(registration.originalName, args);

    logger.debug(`[ToolBridge] Tool '${name}' completed`);
    return result;
  }

  /**
   * Check if a tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get tool definition
   */
  getToolDefinition(name: string): ToolDefinition | null {
    const registration = this.tools.get(name);
    return registration?.definition ?? null;
  }

  /**
   * Get tool's plugin ID
   */
  getToolPlugin(name: string): string | null {
    const registration = this.tools.get(name);
    return registration?.pluginId ?? null;
  }

  /**
   * Get all tools for a plugin
   */
  getPluginTools(pluginId: string): string[] {
    const tools = this.pluginTools.get(pluginId);
    return tools ? Array.from(tools) : [];
  }

  /**
   * Get all registered tool names
   */
  getAllToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Cleanup all tools for a plugin
   */
  cleanupPlugin(pluginId: string): number {
    const toolNames = this.pluginTools.get(pluginId);
    if (!toolNames) return 0;

    let count = 0;
    for (const name of toolNames) {
      this.tools.delete(name);

      // Emit unregistration event
      eventBus.emitEvent('plugin:tool:unregistered', {
        name,
        pluginId,
      });

      count++;
    }

    this.pluginTools.delete(pluginId);

    logger.debug(`[ToolBridge] Cleaned up ${count} tools for ${pluginId}`);
    return count;
  }

  /**
   * Get total tool count
   */
  get totalTools(): number {
    return this.tools.size;
  }

  /**
   * Clear all tools
   */
  clear(): void {
    for (const [name, registration] of this.tools) {
      eventBus.emitEvent('plugin:tool:unregistered', {
        name,
        pluginId: registration.pluginId,
      });
    }
    this.tools.clear();
    this.pluginTools.clear();
    logger.debug('[ToolBridge] Cleared all tools');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let toolBridgeInstance: ToolBridge | null = null;

/**
 * Get the global ToolBridge instance
 */
export function getToolBridge(): ToolBridge {
  if (!toolBridgeInstance) {
    toolBridgeInstance = new ToolBridge();
  }
  return toolBridgeInstance;
}

/**
 * Reset the global ToolBridge instance (for testing)
 */
export function resetToolBridge(): void {
  if (toolBridgeInstance) {
    toolBridgeInstance.clear();
  }
  toolBridgeInstance = null;
}
