/**
 * Renderer process types - imports shared types and adds renderer-specific types
 */
export * from '../shared/types';

// Renderer-specific types
export type View = 'agents' | 'projects' | 'channels' | 'chats' | 'tasks' | 'notes' | 'activity' | 'settings' | string; // string allows plugin views

/** Tabs of the settings view — kept here so callers can deep-link into one. */
export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'defaults'
  | 'providers'
  | 'memory'
  | 'integrations'
  | 'sync'
  | 'advanced'
  | 'updates'
  | 'data';

export interface PluginView {
  id: string;
  title: string;
  icon?: string;
  component: string; // Component name to resolve
  showInSidebar?: boolean;
  pluginId: string;
}

export interface ToolCallState {
  id: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
  status: 'running' | 'completed' | 'error';
}

