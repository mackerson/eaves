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
 *
 * Exported because it is also the authoritative answer to "what can a plugin
 * call, and what does it have to declare to call it" — which is what the
 * plugin API catalog reports to an agent authoring one. Deriving that from
 * this map rather than restating it keeps the two from drifting.
 */
export const PERMISSION_REQUIREMENTS = {
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
  'data.messages.getByChat': ['data:messages:read'],
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

  // Secrets namespace — per-plugin, safeStorage-sealed, fail-closed
  'secrets.get': ['secrets:read'],
  'secrets.keys': ['secrets:read'],
  'secrets.set': ['secrets:write'],
  'secrets.delete': ['secrets:write'],
} satisfies Record<string, PluginPermission[]>;

/** Every method the gate knows about. */
export type GatedMethod = keyof typeof PERMISSION_REQUIREMENTS;

/**
 * Look up an arbitrary (untrusted) method path. The table's keys are a literal
 * union so the signature table below can be checked exhaustively against it;
 * this is the one place that widening back to `string` is allowed, and it
 * returns undefined for anything unmapped — which callers treat as deny.
 */
function requirementsFor(methodPath: string): PluginPermission[] | undefined {
  return (PERMISSION_REQUIREMENTS as Record<string, PluginPermission[]>)[methodPath];
}

/**
 * How each of those methods is actually called.
 *
 * This lives beside the requirements rather than in the catalog that renders
 * it, and it is typed `Record<GatedMethod, string>` on purpose: adding a gated
 * method without documenting its signature is a compile error, and documenting
 * a method that does not exist is too. That kills the drift mode where the two
 * tables disagree about which methods exist.
 *
 * It does NOT prove the prose matches the implementation — only a generator
 * reading the source could. It exists because an agent shown `showNotification()`
 * and nothing else guessed the Web Notification shape, passed an object where a
 * string was expected, and took the renderer down with it.
 */
export const METHOD_SIGNATURES: Record<GatedMethod, string> = {
  'data.agents.getAll': '(): Promise<Agent[]>',
  'data.agents.getById': '(id: string): Promise<Agent | null>',
  'data.projects.getAll': '(): Promise<Project[]>',
  'data.projects.getById': '(id: string): Promise<Project | null>',
  'data.projects.getCurrent': '(): Promise<Project | null>',
  'data.channels.getAll': '(): Promise<Channel[]>',
  'data.channels.getById': '(id: string): Promise<Channel | null>',
  'data.channels.getCurrent': '(): Promise<Channel | null>',
  'data.chats.getAll': '(options?: { limit?: number }): Promise<Chat[]>',
  'data.chats.getById': '(id: string): Promise<Chat | null>',
  'data.chats.getByAgent': '(agentId: string, options?: { limit?: number }): Promise<Chat[]>',
  'data.chats.getCurrent': '(): Promise<Chat | null>',
  'data.messages.getByChat':
    '(chatId: string, options?: { limit?: number }): Promise<ChatMessage[]> — active branch only, oldest first',
  'data.settings.get': '(): Promise<Settings>',
  'data.settings.getCurrent': '(): Promise<Settings>',

  'actions.createTask': '(task: { title: string; description?: string; projectId?: string }): Promise<Task>',
  'actions.createNote': '(note: { title: string; content: string; projectId?: string }): Promise<Note>',
  'actions.createChat':
    '(chat: { name: string; agentId: string; tags?: string; bridge?: boolean }): Promise<Chat> ' +
    '— bridge: true marks the chat as owned by the calling plugin, which then receives ' +
    "outbound agent replies via its 'messaging-provider' service",
  'actions.createAgent': '(agent: { name: string; systemPrompt?: string; model?: string }): Promise<Agent>',
  'actions.bulkImportMessages': '(chatId: string, messages: unknown[]): Promise<{ imported: number }>',
  'actions.bulkImportAttachments': '(attachments: unknown[]): Promise<{ imported: number }>',

  'ui.showNotification':
    "(notification: string | { title: string; body?: string; icon?: string }): Promise<void> " +
    "— a desktop notification. Pass a bare string for body-only. For transient in-app text use showToast.",
  'ui.showToast': "(message: string, duration?: number): Promise<void> — transient in-app text, string only",
  'ui.registerView':
    "(view: { id: string; title: string; icon?: string; component: string }): Promise<void> " +
    "— `component` must name an export in the manifest's `ui.components`",
  'ui.registerTerminalView': '(view: { id: string; title: string; icon?: string; component: string }): Promise<void>',
  'ui.registerSidebarItem': '(item: { id: string; title: string; icon?: string; view?: string }): Promise<void>',
  'ui.registerCommand': '(command: { id: string; title: string; handler: () => void | Promise<void> }): Promise<void>',
  'ui.showModal': '(modal: { title: string; content: string }): Promise<void>',
  'ui.showConfirm': '(options: { title: string; message: string }): Promise<boolean>',

  'events.on': '(eventType: string, handler: (data: unknown) => void): string — returns a callback id for off()',
  'events.off': '(eventType: string, callbackId: string): void',
  'events.once': '(eventType: string, handler: (data: unknown) => void): string',
  'events.emit': '(eventType: string, data?: unknown): Promise<void>',

  'tools.register':
    "(name: string, tool: { description: string; inputSchema: object; " +
    "execute: (args: Record<string, unknown>) => Promise<unknown>; needsApproval?: boolean }): Promise<void> " +
    "— inputSchema is JSON Schema; `needsApproval` is a static boolean, not a function",
  'tools.unregister': '(name: string): Promise<void>',

  'services.register': '(service: { type: string; id: string; implementation: unknown }): Promise<void>',
  'services.unregister': '(id: string): Promise<void>',
  'services.discover': '(serviceType: string): Promise<unknown[]>',
  'services.get': '(id: string): Promise<unknown | null>',
  'services.getDefault': '(serviceType: string): Promise<unknown | null>',
  'services.call': '(id: string, method: string, args?: unknown[]): Promise<unknown>',
  'services.hasProviders': '(serviceType: string): Promise<boolean>',
  'services.onRegistered': '(serviceType: string, handler: (service: unknown) => void): Promise<string>',
  'services.onUnregistered': '(serviceType: string, handler: (service: unknown) => void): Promise<string>',

  'storage.get': '(key: string): Promise<unknown>',
  'storage.set': '(key: string, value: unknown): Promise<void>',
  'storage.delete': '(key: string): Promise<void>',
  'storage.clear': '(): Promise<void>',
  'storage.keys': '(): Promise<string[]>',

  'secrets.get':
    '(key: string): Promise<string | null> — null if never set; throws when OS encryption is ' +
    'unavailable or the stored value cannot be decrypted. Values are never returned in plaintext from disk.',
  'secrets.keys': '(): Promise<string[]> — key names only, never values',
  'secrets.set':
    '(key: string, value: string): Promise<void> — sealed with the OS keychain (safeStorage); ' +
    'throws when OS encryption is unavailable (no plaintext fallback)',
  'secrets.delete': '(key: string): Promise<boolean>',
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
    const requiredPermissions = requirementsFor(methodPath);

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
    return requirementsFor(methodPath) || [];
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
