/**
 * Permission Gate
 *
 * Runtime permission enforcement for sandboxed plugins.
 * Validates that plugins have declared required permissions
 * before allowing API calls.
 */

import { PluginPermission, APINamespace } from './types';
import { createMethodPath } from './protocol';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export interface PermissionCheckResult {
  allowed: boolean;
  missingPermissions: PluginPermission[];
  reason?: string;
}

export interface PluginPermissionSet {
  pluginId: string;
  permissions: Set<PluginPermission>;
  registeredAt: number;
}

// ============================================================================
// Permission Requirements Map
// ============================================================================

/**
 * Maps API methods to required permissions
 * Format: "namespace.method" -> [required permissions]
 */
const PERMISSION_REQUIREMENTS: Record<string, PluginPermission[]> = {
  // Data namespace - read operations
  'data.agents.getAll': ['data:agents:read'],
  'data.agents.getById': ['data:agents:read'],
  'data.projects.getAll': ['data:projects:read'],
  'data.projects.getById': ['data:projects:read'],
  'data.projects.getCurrent': ['data:projects:read'],
  'data.channels.getAll': ['data:channels:read'],
  'data.channels.getById': ['data:channels:read'],
  'data.channels.getCurrent': ['data:channels:read'],
  'data.chats.getAll': ['data:chats:read'],
  'data.chats.getById': ['data:chats:read'],
  'data.chats.getByAgent': ['data:chats:read'],
  'data.chats.getCurrent': ['data:chats:read'],
  'data.settings.get': ['data:settings:read'],
  'data.settings.getCurrent': ['data:settings:read'],

  // Actions namespace - write operations
  'actions.createTask': ['data:tasks:write'],
  'actions.createNote': ['data:notes:write'],
  'actions.createChat': ['data:chats:write'],
  'actions.createAgent': ['data:agents:write'],
  'actions.bulkImportMessages': ['data:messages:write'],
  'actions.bulkImportAttachments': ['data:messages:write'],

  // UI namespace
  'ui.showNotification': ['ui:notifications:show'],
  'ui.showToast': ['ui:notifications:show'],
  'ui.registerView': ['ui:views:register'],
  'ui.registerTerminalView': ['ui:views:register'],
  'ui.registerSidebarItem': ['ui:views:register'],
  'ui.registerCommand': ['ui:views:register'],
  'ui.showModal': ['ui:notifications:show'],
  'ui.showConfirm': ['ui:notifications:show'],

  // Events namespace
  'events.on': ['events:listen'],
  'events.off': ['events:listen'],
  'events.once': ['events:listen'],
  'events.emit': ['events:emit'],

  // Tools namespace
  'tools.register': ['tools:register'],
  'tools.unregister': ['tools:register'],

  // Services namespace
  'services.register': ['services:register'],
  'services.unregister': ['services:register'],
  'services.discover': ['services:call'],
  'services.get': ['services:call'],
  'services.getDefault': ['services:call'],
  'services.call': ['services:call'],
  'services.hasProviders': ['services:call'],
  'services.onRegistered': ['services:call'],
  'services.onUnregistered': ['services:call'],

  // Storage namespace
  'storage.get': ['storage:read'],
  'storage.set': ['storage:write'],
  'storage.delete': ['storage:write'],
  'storage.clear': ['storage:write'],
  'storage.keys': ['storage:read'],
};

// ============================================================================
// Permission Gate Class
// ============================================================================

/**
 * PermissionGate enforces runtime permission checks for plugin API calls
 */
export class PermissionGate {
  private pluginPermissions = new Map<string, PluginPermissionSet>();
  private deniedCalls = new Map<string, number>(); // Track denied calls for rate limiting

  /**
   * Register permissions for a plugin
   */
  registerPlugin(pluginId: string, permissions: PluginPermission[]): void {
    this.pluginPermissions.set(pluginId, {
      pluginId,
      permissions: new Set(permissions),
      registeredAt: Date.now(),
    });

    logger.debug(`[PermissionGate] Registered permissions for plugin ${pluginId}:`, {
      permissions,
    });
  }

  /**
   * Unregister a plugin's permissions
   */
  unregisterPlugin(pluginId: string): void {
    this.pluginPermissions.delete(pluginId);
    logger.debug(`[PermissionGate] Unregistered plugin ${pluginId}`);
  }

  /**
   * Check if a plugin has permission to call an API method
   */
  checkPermission(
    pluginId: string,
    namespace: APINamespace,
    method: string
  ): PermissionCheckResult {
    const methodPath = createMethodPath(namespace, method);
    const requiredPermissions = PERMISSION_REQUIREMENTS[methodPath];

    // If no requirements defined, deny by default — unmapped methods must be explicitly registered
    if (!requiredPermissions || requiredPermissions.length === 0) {
      logger.warn(
        `[PermissionGate] No permission requirements mapped for ${methodPath}, denying by default`
      );
      return {
        allowed: false,
        missingPermissions: [],
        reason: `No permission requirements mapped for ${methodPath}`,
      };
    }

    // Get plugin's permissions
    const pluginPerms = this.pluginPermissions.get(pluginId);
    if (!pluginPerms) {
      logger.warn(
        `[PermissionGate] Plugin ${pluginId} has no registered permissions`
      );
      return {
        allowed: false,
        missingPermissions: requiredPermissions,
        reason: `Plugin ${pluginId} has no registered permissions`,
      };
    }

    // Check each required permission
    const missingPermissions = requiredPermissions.filter(
      (perm) => !this.hasPermission(pluginPerms.permissions, perm)
    );

    if (missingPermissions.length > 0) {
      this.recordDeniedCall(pluginId, methodPath);
      logger.warn(
        `[PermissionGate] Plugin ${pluginId} denied access to ${methodPath}`,
        { missingPermissions }
      );
      return {
        allowed: false,
        missingPermissions,
        reason: `Missing permissions: ${missingPermissions.join(', ')}`,
      };
    }

    return { allowed: true, missingPermissions: [] };
  }

  /**
   * Check permission and throw if denied
   */
  assertPermission(
    pluginId: string,
    namespace: APINamespace,
    method: string
  ): void {
    const result = this.checkPermission(pluginId, namespace, method);
    if (!result.allowed) {
      throw new PermissionDeniedError(pluginId, namespace, method, result.missingPermissions);
    }
  }

  /**
   * Check if a plugin has a specific permission (with wildcard support)
   */
  private hasPermission(
    granted: Set<PluginPermission>,
    required: PluginPermission
  ): boolean {
    // Direct match
    if (granted.has(required)) return true;

    // Check wildcard patterns
    // e.g., 'data:*:read' matches 'data:agents:read'
    for (const perm of granted) {
      if (this.matchesWildcard(perm, required)) return true;
    }

    return false;
  }

  /**
   * Check if a permission pattern matches a specific permission
   */
  private matchesWildcard(pattern: string, permission: string): boolean {
    const patternParts = pattern.split(':');
    const permParts = permission.split(':');

    if (patternParts.length !== permParts.length) return false;

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '*') continue;
      if (patternParts[i] !== permParts[i]) return false;
    }

    return true;
  }

  /**
   * Record a denied call for analytics/rate limiting
   */
  private recordDeniedCall(pluginId: string, methodPath: string): void {
    const key = `${pluginId}:${methodPath}`;
    const count = (this.deniedCalls.get(key) || 0) + 1;
    this.deniedCalls.set(key, count);

    // Warn if a plugin is repeatedly trying denied operations
    if (count === 10) {
      logger.warn(
        `[PermissionGate] Plugin ${pluginId} has been denied ${methodPath} 10 times`
      );
    }
  }

  /**
   * Get permissions for a plugin
   */
  getPluginPermissions(pluginId: string): PluginPermission[] | null {
    const perms = this.pluginPermissions.get(pluginId);
    return perms ? Array.from(perms.permissions) : null;
  }

  /**
   * Get all registered plugins
   */
  getRegisteredPlugins(): string[] {
    return Array.from(this.pluginPermissions.keys());
  }

  /**
   * Get permission requirements for a method
   */
  getRequiredPermissions(
    namespace: APINamespace,
    method: string
  ): PluginPermission[] {
    const methodPath = createMethodPath(namespace, method);
    return PERMISSION_REQUIREMENTS[methodPath] || [];
  }

  /**
   * Check if any permission requirements exist for a method
   */
  hasRequirements(namespace: APINamespace, method: string): boolean {
    const methodPath = createMethodPath(namespace, method);
    return methodPath in PERMISSION_REQUIREMENTS;
  }

  /**
   * Get denied call statistics
   */
  getDeniedStats(): Map<string, number> {
    return new Map(this.deniedCalls);
  }

  /**
   * Clear denied call statistics
   */
  clearDeniedStats(): void {
    this.deniedCalls.clear();
  }
}

// ============================================================================
// Permission Error
// ============================================================================

/**
 * Error thrown when a plugin doesn't have required permissions
 */
export class PermissionDeniedError extends Error {
  public readonly pluginId: string;
  public readonly namespace: APINamespace;
  public readonly method: string;
  public readonly missingPermissions: PluginPermission[];

  constructor(
    pluginId: string,
    namespace: APINamespace,
    method: string,
    missingPermissions: PluginPermission[]
  ) {
    const methodPath = createMethodPath(namespace, method);
    super(
      `Plugin '${pluginId}' denied access to '${methodPath}'. ` +
        `Missing permissions: ${missingPermissions.join(', ')}`
    );

    this.name = 'PermissionDeniedError';
    this.pluginId = pluginId;
    this.namespace = namespace;
    this.method = method;
    this.missingPermissions = missingPermissions;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let permissionGateInstance: PermissionGate | null = null;

/**
 * Get the global PermissionGate instance
 */
export function getPermissionGate(): PermissionGate {
  if (!permissionGateInstance) {
    permissionGateInstance = new PermissionGate();
  }
  return permissionGateInstance;
}

/**
 * Reset the global PermissionGate instance (for testing)
 */
export function resetPermissionGate(): void {
  permissionGateInstance = null;
}
