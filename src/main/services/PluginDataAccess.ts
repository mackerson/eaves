import {
  getAgentRepository,
  getProjectRepository,
  getChannelRepository,
  getSettingsRepository,
} from '../repositories';

/**
 * Shared read-only data access layer for plugins.
 * Used by SandboxedPluginManager for plugin data access via RPC.
 */

export const pluginDataMethods: Record<string, (...args: unknown[]) => unknown> = {
  'agents.getAll': () => getAgentRepository().getAll(),
  'agents.getById': (id) => getAgentRepository().getById(id as string),
  'projects.getAll': () => getProjectRepository().getAll(),
  'projects.getById': (id) => getProjectRepository().getById(id as string),
  'projects.getCurrent': () => {
    const state = getSettingsRepository().getCurrentState();
    return state.projectId ? getProjectRepository().getById(state.projectId) : null;
  },
  'channels.getAll': () => getChannelRepository().getAll(),
  'channels.getById': (id) => getChannelRepository().getById(id as string),
  'channels.getCurrent': () => {
    const state = getSettingsRepository().getCurrentState();
    return state.channelId ? getChannelRepository().getById(state.channelId) : null;
  },
  'chats.getAll': (options) => getChannelRepository().getDirectChats(options as { includeArchived?: boolean } | undefined),
  'chats.getById': (id) => getChannelRepository().getDirectChatById(id as string),
  'chats.getByAgent': (agentId, options) =>
    getChannelRepository().getDirectChatsByAgentId(agentId as string, options as { includeArchived?: boolean } | undefined),
  'chats.getCurrent': () => {
    const state = getSettingsRepository().getCurrentState();
    return state.chatId ? getChannelRepository().getDirectChatById(state.chatId) : null;
  },
  'settings.get': () => getSettingsRepository().get(),
  'settings.getCurrent': () => getSettingsRepository().getCurrentState(),
};

/**
 * Dispatch a plugin data method by dotted name (e.g., 'agents.getAll').
 * Throws if the method is unknown.
 */
export function dispatchDataMethod(method: string, args: unknown[]): unknown {
  const handler = pluginDataMethods[method];
  if (!handler) {
    throw new Error(`Unknown data method: ${method}`);
  }
  return handler(...args);
}
