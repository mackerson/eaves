/**
 * One vocabulary for what a plugin permission *means*.
 *
 * This used to live inside pluginConsentWindow.ts, which was fine while the
 * install dialog was the only place a person read a grant. It is not any more:
 * the Workshop bench describes a draft's access before you keep it, and two
 * tables saying slightly different things about `data:messages:write` is the
 * drift mode worth designing out — the whole point of both surfaces is that a
 * person can believe what they say.
 */

/**
 * Plain English for each grant. Falling back to the raw id reads as noise at
 * exactly the moment the user is being asked to make a trust decision.
 */
export const PERMISSION_LABELS: Record<string, string> = {
  'data:agents:read': 'Read your agents',
  'data:projects:read': 'Read your projects',
  'data:channels:read': 'Read your channels',
  'data:chats:read': 'Read your chats',
  'data:messages:read': 'Read the messages in your chats',
  'data:settings:read': 'Read your settings',
  'data:tasks:write': 'Create or modify tasks',
  'data:notes:write': 'Create or modify notes',
  'data:messages:write': 'Write messages',
  'data:chats:write': 'Create or modify chats',
  'data:agents:write': 'Create or modify agents',
  'ui:views:register': 'Add its own views to the app',
  'ui:notifications:show': 'Show notifications',
  'events:listen': 'Observe app events',
  'events:emit': 'Emit app events',
  'tools:register': 'Add tools your agents can use',
  'services:register': 'Provide services to other plugins',
  'services:call': 'Use services from other plugins',
  'storage:read': 'Read its own stored data',
  'storage:write': 'Store its own data',
  'secrets:read': 'Read secrets it has stored (sealed with your OS keychain)',
  'secrets:write': 'Store secrets sealed with your OS keychain',
  'network:http': 'Make network requests',
  'system:filesystem': 'Read and write files on your computer',
  'net:socket': 'Open raw TCP/TLS connections to servers',
  // Coarse aliases — legal in a manifest, but the sandbox matches only the
  // granular ids, so these grant nothing. Shown separately, never as capabilities.
  'data:read': 'Read your data',
  'data:write': 'Modify your data',
  'ui:register': 'Add its own UI',
  'storage:access': 'Use its own storage',
  'network:access': 'Use the network',
};

/** The union's own "Dangerous (require explicit grant)" group. */
export const ELEVATED_PERMISSIONS = new Set(['network:http', 'system:filesystem', 'net:socket']);

/** Grants the sandbox never matches — declaring one confers no access. */
export const INERT_PERMISSIONS = new Set([
  'data:read', 'data:write', 'ui:register', 'storage:access', 'network:access',
]);

/**
 * Grants that no entry in PERMISSION_REQUIREMENTS unlocks.
 *
 * They are real in the sense that the consent dialog shows them and the user
 * agrees to them, but nothing in PermissionGate ever matches them: a plugin
 * holding `system:filesystem` reaches the disk by calling `require('fs')`
 * directly, which the worker's module list is documented not to stop (see
 * CLAUDE.md — advisory, not a boundary). So they are labels, not gates, and a
 * surface that shows them beside gated grants without saying so is describing
 * an enforcement that does not exist.
 */
export const UNGATED_PERMISSIONS = new Set(['network:http', 'system:filesystem']);

export const permissionLabel = (permission: string): string =>
  PERMISSION_LABELS[permission] || permission;
