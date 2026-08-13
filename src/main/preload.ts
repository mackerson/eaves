import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  ChatStreamEvent,
  CreateAgentRequest,
  UpdateAgentRequest,
  CreateChannelRequest,
  UpdateChannelRequest,
  SearchChannelsRequest,
  GetChannelsByTagsRequest,
  SendMessageRequest,
  AddAgentMessageRequest,
  AddChannelParticipantRequest,
  StopStreamRequest,
  CreateChatRequest,
  UpdateChatRequest,
  SendChatMessageRequest,
  AddChatAgentMessageRequest,
  AddChatParticipantRequest,
  SearchChatsRequest,
  GetChatsByTagsRequest,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateNoteRequest,
  UpdateNoteRequest,
  ListNotesRequest,
  CreateNoteLabelRequest,
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateUserRequest,
  UpdateUserRequest,
  MCPServerRequest,
  UpdateMCPServerRequest,
  UpdateSettingsRequest,
  LogErrorRequest,
  AppState,
  MessageResponse,
  UserResponse,
  ZoomLevelState
} from '../shared/ipc-types';
import {
  Agent,
  User,
  Project,
  Channel,
  MCPServer,
  Settings,
  Task,
  Note,
  NoteLabel,
  NoteAIMetadata,
  Chat,
  ChatMessage,
  Message,
  ScheduleEvent,
  CalendarEvent,
  Milestone,
  Deadline,
  Routine,
  Workflow,
  File as ProjectFile,
  ContentBlock,
  MessageMetrics,
  PluginManifest,
  Activity,
  ThemeDefinition,
  BackupSnapshot,
  ConversationFolder,
} from './types';

// IPC handlers wrapped with ipcResult may return this error shape on failure


// Track callback→listener mappings so off() can remove the correct listener
const listenerMap = new Map<Function, Map<string, Function>>();

// Whitelist of main → renderer event channels that the generic `on()` API may
// subscribe to. Anything not in this list (exact match) or matching one of the
// allowed prefixes is rejected with a console error + no-op cleanup so the
// renderer can't snoop on channels it has no business with (e.g. a compromised
// dependency listening to `chat-stream` for message content).
//
// Audit when adding/removing a `webContents.send` channel in main. The strict
// listeners above (typed `onXyz` methods) don't go through this gate — they
// register `ipcRenderer.on` directly inside the bridge, which is already a
// boundary the renderer can't bypass.
const ALLOWED_GENERIC_CHANNELS = new Set<string>([
  'plugin:detected',
  'plugin:building',
  'plugin:loaded',
  'plugin:error',
  'plugin:ui:toast',
  'plugin:ui:notification',
  'plugin-views-changed',
]);
const ALLOWED_GENERIC_CHANNEL_PREFIXES: readonly string[] = [
  'terminal:',          // TerminalManager — terminal:data:<id>, terminal:exit:<id>
  'theme:',             // ThemeWatcher    — theme:added/updated/removed
  'chatgpt-import:',    // import plugins  — progress/complete/error/preview-result
  'character-card-import:',
  'sync:',              // SyncService     — sync:state / sync:applied / sync:schema-mismatch
];

function isGenericChannelAllowed(channel: string): boolean {
  if (ALLOWED_GENERIC_CHANNELS.has(channel)) return true;
  return ALLOWED_GENERIC_CHANNEL_PREFIXES.some(p => channel.startsWith(p));
}

contextBridge.exposeInMainWorld('electron', {
  getMemory: (): Promise<AppState> => ipcRenderer.invoke('get-memory'),
  onChatStream: (callback: (event: ChatStreamEvent | string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ChatStreamEvent | string) => callback(data);
    ipcRenderer.on('chat-stream', listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener('chat-stream', listener);
  },
  onMessageUpdated: (callback: (event: { messageId: string; contentBlocks: ContentBlock[]; content?: string; isDraft?: boolean; metrics?: MessageMetrics }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { messageId: string; contentBlocks: ContentBlock[]; content?: string; isDraft?: boolean; metrics?: MessageMetrics }) => callback(data);
    ipcRenderer.on('message-updated', listener);
    return () => ipcRenderer.removeListener('message-updated', listener);
  },
  onChannelMessageAdded: (callback: (event: { channelId: string; message: Message }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { channelId: string; message: Message }) => callback(data);
    ipcRenderer.on('channel-message-added', listener);
    return () => ipcRenderer.removeListener('channel-message-added', listener);
  },
  onChannelsChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('channels-changed', listener);
    return () => ipcRenderer.removeListener('channels-changed', listener);
  },
  onAgentsChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('agents-changed', listener);
    return () => ipcRenderer.removeListener('agents-changed', listener);
  },
  onProjectDataChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('project-data-changed', listener);
    return () => ipcRenderer.removeListener('project-data-changed', listener);
  },
  // Agents
  createAgent: (agentData: CreateAgentRequest): Promise<Agent> => ipcRenderer.invoke('create-agent', agentData),
  updateAgent: (agentId: string, updates: UpdateAgentRequest): Promise<Agent> => ipcRenderer.invoke('update-agent', { agentId, updates }),
  deleteAgent: (agentId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-agent', agentId),
  switchAgent: (agentId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('switch-agent', agentId),
  getAgents: (): Promise<{ success: boolean; agents: Agent[]; error?: string }> => ipcRenderer.invoke('list-agents'),
  fetchModels: (provider: string, baseURL?: string): Promise<{ success: boolean; models?: string[]; error?: string }> => ipcRenderer.invoke('fetch-models', { provider, baseURL }),
  listProviders: (): Promise<{
    success: boolean;
    providers?: Array<{
      id: string;
      label: string;
      icon: string;
      description: string;
      needsKey: boolean;
      isLocalEndpoint: boolean;
      docsUrl?: string;
    }>;
    error?: string;
  }> => ipcRenderer.invoke('list-providers'),
  // Users
  getUsers: (): Promise<User[]> => ipcRenderer.invoke('get-users'),
  getCurrentUser: (): Promise<User | null> => ipcRenderer.invoke('get-current-user'),
  createUser: (userData: CreateUserRequest): Promise<UserResponse> => ipcRenderer.invoke('create-user', userData),
  updateUser: (userId: string, updates: UpdateUserRequest): Promise<User> => ipcRenderer.invoke('update-user', { userId, updates }),
  deleteUser: (userId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-user', userId),
  switchUser: (userId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('switch-user', userId),
  // MCP Servers
  addMCPServer: (agentId: string, serverData: MCPServerRequest): Promise<MCPServer> => ipcRenderer.invoke('add-mcp-server', { agentId, serverData }),
  updateMCPServer: (agentId: string, serverId: string, updates: UpdateMCPServerRequest): Promise<{ success: boolean }> => ipcRenderer.invoke('update-mcp-server', { agentId, serverId, updates }),
  deleteMCPServer: (agentId: string, serverId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-mcp-server', { agentId, serverId }),
  // Projects
  createProject: (params: CreateProjectRequest): Promise<Project> => ipcRenderer.invoke('create-project', params),
  updateProject: (projectId: string, updates: UpdateProjectRequest): Promise<Project> => ipcRenderer.invoke('update-project', { projectId, updates }),
  switchProject: (projectId: string): Promise<{ success: boolean; error?: string; tasks?: Task[]; notes?: Note[]; events?: CalendarEvent[]; labels?: NoteLabel[] }> => ipcRenderer.invoke('switch-project', projectId),
  deleteProject: (projectId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-project', projectId),
  // Tasks
  addTask: (taskData: CreateTaskRequest): Promise<Task> => ipcRenderer.invoke('add-task', taskData),
  updateTask: (taskId: string, updates: UpdateTaskRequest): Promise<Task> => ipcRenderer.invoke('update-task', { taskId, updates }),
  toggleTask: (taskId: string): Promise<Task> => ipcRenderer.invoke('toggle-task', taskId),
  deleteTask: (taskId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-task', taskId),
  reorderTasks: (orders: { id: string; sortOrder: number }[]): Promise<{ success: boolean }> => ipcRenderer.invoke('reorder-tasks', orders),
  // Notes
  addNote: (noteData: CreateNoteRequest): Promise<Note> => ipcRenderer.invoke('add-note', noteData),
  updateNote: (noteId: string, updates: UpdateNoteRequest): Promise<Note> => ipcRenderer.invoke('update-note', { noteId, updates }),
  toggleNotePin: (noteId: string): Promise<Note> => ipcRenderer.invoke('toggle-note-pin', noteId),
  deleteNote: (noteId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-note', noteId),
  listNotes: (options?: ListNotesRequest): Promise<Note[]> => ipcRenderer.invoke('list-notes', options || {}),
  getNoteLabels: (projectId?: string): Promise<NoteLabel[]> => ipcRenderer.invoke('get-note-labels', projectId),
  createNoteLabel: (labelData: CreateNoteLabelRequest): Promise<NoteLabel> => ipcRenderer.invoke('create-note-label', labelData),
  deleteNoteLabel: (labelId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-note-label', labelId),
  generateNoteMetadata: (noteId: string): Promise<{ success: boolean; metadata?: NoteAIMetadata; note?: Note; error?: string }> => ipcRenderer.invoke('generate-note-metadata', noteId),
  reorderNotes: (orders: { id: string; sortOrder: number }[]): Promise<{ success: boolean }> => ipcRenderer.invoke('reorder-notes', orders),
  // Settings
  updateSettings: (settings: UpdateSettingsRequest): Promise<Settings> => ipcRenderer.invoke('update-settings', settings),
  // OOBE
  getOobeDefaults: (): Promise<{ userName: string | null; apiKeys: Partial<Record<'anthropic' | 'openai' | 'google' | 'ollama' | 'lmstudio', string | null>> }> => ipcRenderer.invoke('oobe-get-defaults'),
  validateApiKey: (params: { provider: string; apiKey: string }): Promise<{ valid: boolean; error?: string; models?: string[] }> => ipcRenderer.invoke('validate-api-key', params),
  oobeGenerate: (params: { provider: string; model: string; apiKey: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; systemPrompt?: string }): Promise<{ success: boolean; content?: string; error?: string }> => ipcRenderer.invoke('oobe-generate', params),
  onOobeStream: (callback: (event: { type: 'text' | 'done' | 'error'; content?: string; error?: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { type: 'text' | 'done' | 'error'; content?: string; error?: string }) => callback(data);
    ipcRenderer.on('oobe-stream', listener);
    return () => ipcRenderer.removeListener('oobe-stream', listener);
  },
  completeOobe: (): Promise<{ success: boolean }> => ipcRenderer.invoke('complete-oobe'),
  // Channels
  createChannel: (params: CreateChannelRequest): Promise<{ success: boolean; channel?: Channel; error?: string }> => ipcRenderer.invoke('create-channel', params),
  // Tags / archive surface — first-class on every channel, and shape-identical
  // to the chat equivalents below since both project the same rows
  getChannels: (options?: { includeArchived?: boolean }): Promise<{ success: boolean; channels?: Channel[]; error?: string }> => ipcRenderer.invoke('get-channels', options),
  archiveChannel: (channelId: string): Promise<{ success: boolean; channel?: Channel; error?: string }> => ipcRenderer.invoke('archive-channel', channelId),
  unarchiveChannel: (channelId: string): Promise<{ success: boolean; channel?: Channel; error?: string }> => ipcRenderer.invoke('unarchive-channel', channelId),
  searchChannels: (params: SearchChannelsRequest): Promise<{ success: boolean; channels?: Channel[]; error?: string }> => ipcRenderer.invoke('search-channels', params),
  getChannelsByTags: (params: GetChannelsByTagsRequest): Promise<{ success: boolean; channels?: Channel[]; error?: string }> => ipcRenderer.invoke('get-channels-by-tags', params),
  updateChannel: (channelId: string, updates: UpdateChannelRequest): Promise<Channel> => ipcRenderer.invoke('update-channel', { channelId, updates }),
  deleteChannel: (channelId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-channel', channelId),
  switchChannel: (channelId: string): Promise<{ success: boolean; channel?: Channel }> => ipcRenderer.invoke('switch-channel', channelId),
  sendMessage: (params: SendMessageRequest): Promise<MessageResponse> => ipcRenderer.invoke('send-message', params),
  // Test/QA seam: inserts an agent message directly, with no model turn and no
  // dispatch. Exposed on the bridge only because the e2e harness drives it from
  // the renderer context; product agent turns are persisted server-side.
  addAgentMessage: (params: AddAgentMessageRequest): Promise<MessageResponse> => ipcRenderer.invoke('add-agent-message', params),
  addChannelParticipant: (params: AddChannelParticipantRequest): Promise<{ success: boolean }> => ipcRenderer.invoke('add-channel-participant', params),
  updateMessage: (messageId: string, content: string): Promise<{ success: boolean; contentBlocks?: ContentBlock[] | null; error?: string }> => ipcRenderer.invoke('update-message', { messageId, content }),
  // Work sessions — one agent, one task, its own transcript
  startWorkSession: (params: { taskId: string; agentId: string; parentChannelId?: string }): Promise<{ success: boolean; session?: Chat; error?: string }> => ipcRenderer.invoke('work-sessions:start', params),
  getWorkSession: (sessionId: string): Promise<{ success: boolean; session?: Chat; error?: string }> => ipcRenderer.invoke('work-sessions:get', sessionId),
  listWorkSessionsForTask: (taskId: string): Promise<{ success: boolean; sessions?: Chat[]; error?: string }> => ipcRenderer.invoke('work-sessions:list-for-task', taskId),
  // Conversation pinning + folders (chats and channels share the table)
  setConversationPinned: (conversationId: string, pinned: boolean): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('conversation:set-pinned', { conversationId, pinned }),
  setConversationFolder: (conversationId: string, folderId: string | null): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('conversation:set-folder', { conversationId, folderId }),
  listConversationFolders: (projectId?: string): Promise<{ success: boolean; folders?: ConversationFolder[]; error?: string }> => ipcRenderer.invoke('conversation-folders:list', projectId),
  createConversationFolder: (name: string, projectId?: string): Promise<{ success: boolean; folder?: ConversationFolder; error?: string }> => ipcRenderer.invoke('conversation-folders:create', { name, projectId }),
  renameConversationFolder: (folderId: string, name: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('conversation-folders:rename', { folderId, name }),
  deleteConversationFolder: (folderId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('conversation-folders:delete', folderId),
  deleteMessage: (messageId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-message', messageId),
  stopStream: (params?: StopStreamRequest): Promise<{ success: boolean }> => ipcRenderer.invoke('stop-stream', params || {}),

  // Tool approvals (HITL)
  listPendingApprovals: (filter?: { context: 'chat' | 'channel'; contextId: string }): Promise<{
    success: boolean;
    approvals?: Array<{
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      context: 'chat' | 'channel';
      contextId: string;
      agentId: string;
      messageId: string;
      createdAt: number;
    }>;
    error?: string;
  }> => ipcRenderer.invoke('approval:list-pending', filter ?? {}),
  /** Per-conversation "stop asking me about this tool" waivers. */
  listApprovalGrants: (containerId: string): Promise<{ success: boolean; grants?: Array<{ id: string; containerId: string; agentId: string; toolName: string; grantedAt: number }>; error?: string }> =>
    ipcRenderer.invoke('approval:grants:list', containerId),
  grantToolApproval: (params: { containerId: string; agentId: string; toolName: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('approval:grants:grant', params),
  revokeToolApproval: (grantId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('approval:grants:revoke', grantId),
  /** Decide several approvals from one turn together; resumes once. */
  respondToApprovals: (params: {
    decisions: Array<{ approvalId: string; approved: boolean; reason?: string }>;
    context?: 'chat' | 'channel';
    contextId?: string;
    agentId?: string;
    messageId?: string;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('approval:respond-batch', params),
  respondToApproval: (params: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    context?: 'chat' | 'channel';
    contextId?: string;
    agentId?: string;
    messageId?: string;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('approval:respond', params),

  // Chats
  createChat: (params: CreateChatRequest): Promise<{ success: boolean; chat?: Chat; error?: string }> => ipcRenderer.invoke('create-chat', params),
  switchChat: (chatId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('switch-chat', chatId),
  updateChat: (chatId: string, updates: UpdateChatRequest): Promise<{ success: boolean; chat?: Chat; error?: string }> => ipcRenderer.invoke('update-chat', { chatId, updates }),
  archiveChat: (chatId: string): Promise<{ success: boolean; chat?: Chat; error?: string }> => ipcRenderer.invoke('archive-chat', chatId),
  unarchiveChat: (chatId: string): Promise<{ success: boolean; chat?: Chat; error?: string }> => ipcRenderer.invoke('unarchive-chat', chatId),
  deleteChat: (chatId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-chat', chatId),
  getChats: (options?: { includeArchived?: boolean }): Promise<{ success: boolean; chats?: Chat[] }> => ipcRenderer.invoke('get-chats', options),
  getChat: (chatId: string): Promise<{ success: boolean; chat?: Chat; error?: string }> => ipcRenderer.invoke('get-chat', chatId),
  getChatsByAgent: (agentId: string, options?: { includeArchived?: boolean }): Promise<{ success: boolean; chats?: Chat[] }> => ipcRenderer.invoke('get-chats-by-agent', { agentId, options }),
  searchChats: (params: SearchChatsRequest): Promise<{ success: boolean; chats?: Chat[] }> => ipcRenderer.invoke('search-chats', params),
  getChatsByTags: (params: GetChatsByTagsRequest): Promise<{ success: boolean; chats?: Chat[] }> => ipcRenderer.invoke('get-chats-by-tags', params),
  sendChatMessage: (params: SendChatMessageRequest): Promise<{ success: boolean; message?: ChatMessage; error?: string }> => ipcRenderer.invoke('send-chat-message', params),
  addChatAgentMessage: (params: AddChatAgentMessageRequest): Promise<{ success: boolean; message?: ChatMessage; error?: string }> => ipcRenderer.invoke('add-chat-agent-message', params),
  addChatParticipant: (params: AddChatParticipantRequest): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('add-chat-participant', params),
  updateChatMessage: (messageId: string, content: string): Promise<{ success: boolean; contentBlocks?: ContentBlock[] | null; error?: string }> => ipcRenderer.invoke('update-chat-message', { messageId, content }),
  deleteChatMessage: (messageId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('delete-chat-message', messageId),
  chatWithAgent: (params: { chatId: string; agentId: string }): Promise<{ success: boolean; response?: string; metrics?: MessageMetrics; aborted?: boolean; error?: string }> => ipcRenderer.invoke('chat-with-agent', params),
  regenerateChatMessage: (params: { messageId: string }): Promise<{ success: boolean; response?: string; metrics?: MessageMetrics; aborted?: boolean; error?: string }> => ipcRenderer.invoke('regenerate-chat-message', params),
  switchActiveBranch: (params: { messageId: string }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('switch-active-branch', params),
  swipeChatMessageBranch: (params: { messageId: string; direction: 'prev' | 'next' }): Promise<{ success: boolean; switchedToMessageId?: string; error?: string }> => ipcRenderer.invoke('swipe-chat-message-branch', params),
  stopChatStream: (chatId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('stop-chat-stream', chatId),
  generateChatMetadata: (params: { chatId: string; messages: ChatMessage[] }): Promise<{ success: boolean; title?: string; tags?: string; error?: string }> => ipcRenderer.invoke('generate-chat-metadata', params),
  getChatTools: (chatId: string): Promise<{ success: boolean; tools?: Array<{ name: string; label: string; category: string; enabled: boolean }>; error?: string }> => ipcRenderer.invoke('get-chat-tools', chatId),
  toggleChatTool: (chatId: string, toolName: string, enabled: boolean): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('toggle-chat-tool', { chatId, toolName, enabled }),
  duplicateChat: (chatId: string): Promise<{ success: boolean; chat?: Chat; error?: string }> => ipcRenderer.invoke('duplicate-chat', chatId),
  exportChatMarkdown: (chatId: string): Promise<{ success: boolean; filePath?: string; error?: string }> => ipcRenderer.invoke('export-chat-markdown', chatId),
  replaceAttachmentFile: (params: { assetPointer: string; filePath: string; messageId?: string }): Promise<{ success: boolean; newUrl?: string; error?: string }> => ipcRenderer.invoke('replace-attachment-file', params),

  // Electron 32 removed the `File.path` augmentation; webUtils is the supported
  // way to recover an on-disk path from a File the user picked or dropped.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // Dialog/File Pickers
  pickImages: (): Promise<{ canceled: boolean; files?: Array<{ path: string; filename: string; mimeType: string; previewDataUrl?: string }> }> => ipcRenderer.invoke('dialog:pick-images'),
  pickAvatar: (): Promise<{ canceled: boolean; filename?: string }> => ipcRenderer.invoke('dialog:pick-avatar'),
  pickBackgroundImage: (): Promise<{ canceled: boolean; path?: string }> => ipcRenderer.invoke('dialog:pick-background-image'),
  openFile: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ success: boolean; canceled: boolean; filePaths: string[] }> => ipcRenderer.invoke('dialog:open-file', options),
  openDirectory: (options?: { title?: string }): Promise<{ success: boolean; canceled: boolean; filePaths: string[] }> => ipcRenderer.invoke('dialog:open-directory', options),

  // Background image caching
  cacheBackgroundUrl: (url: string): Promise<{ success: boolean; path?: string }> => ipcRenderer.invoke('cache-background-url', url),
  getCachedBackground: (url: string): Promise<{ cached: boolean; path?: string }> => ipcRenderer.invoke('get-cached-background', url),
  clearBackgroundCache: (): Promise<{ success: boolean }> => ipcRenderer.invoke('clear-background-cache'),

  // Logs
  getLogFiles: (): Promise<Array<{ path: string; name: string; size: number; modified: number }>> => ipcRenderer.invoke('get-log-files'),
  getLogDir: (): Promise<string> => ipcRenderer.invoke('get-log-dir'),
  openLogDir: (): Promise<void> => ipcRenderer.invoke('open-log-dir'),
  // Only reads files the logger itself wrote, and only the last 1MB of one.
  readLogFile: (filePath: string): Promise<{ success: boolean; content?: string; size?: number; truncated?: boolean; error?: string }> =>
    ipcRenderer.invoke('read-log-file', filePath),
  clearLogs: (): Promise<void> => ipcRenderer.invoke('clear-logs'),
  logError: (errorData: LogErrorRequest): Promise<void> => ipcRenderer.invoke('log-error', errorData),
  // User Themes
  getUserThemes: (): Promise<ThemeDefinition[]> => ipcRenderer.invoke('get-user-themes'),
  getUserTheme: (themeId: string): Promise<ThemeDefinition | null> => ipcRenderer.invoke('get-user-theme', themeId),
  getUserThemeCSS: (themeId: string): Promise<string | null> => ipcRenderer.invoke('get-user-theme-css', themeId),
  isUserTheme: (themeId: string): Promise<boolean> => ipcRenderer.invoke('is-user-theme', themeId),
  reloadUserThemes: (): Promise<ThemeDefinition[]> => ipcRenderer.invoke('reload-user-themes'),
  getThemesDirectory: (): Promise<string> => ipcRenderer.invoke('get-themes-directory'),
  openThemesDirectory: (): Promise<{ success: boolean }> => ipcRenderer.invoke('open-themes-directory'),

  // Plugins
  getPlugins: (): Promise<Array<PluginManifest & { enabled: boolean; hasView: boolean; viewId?: string }>> => ipcRenderer.invoke('get-plugins'),
  getPluginViews: (): Promise<Array<{ id: string; title: string; icon?: string; component: string; showInSidebar?: boolean; pluginId: string; uiMetadata?: PluginManifest['ui']; folderName?: string }>> => ipcRenderer.invoke('get-plugin-views'),
  getImportPluginViews: (): Promise<Array<{ id: string; title: string; icon?: string; component: string; showInSidebar?: boolean; pluginId: string; uiMetadata?: PluginManifest['ui']; folderName?: string; description: string }>> => ipcRenderer.invoke('get-import-plugin-views'),
  getPluginTerminalViews: (): Promise<Array<{ id: string; title: string; icon?: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; showInSidebar?: boolean; pluginId: string }>> => ipcRenderer.invoke('get-plugin-terminal-views'),
  reloadPlugin: (pluginId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('reload-plugin', pluginId),
  enablePlugin: (pluginId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('enable-plugin', pluginId),
  disablePlugin: (pluginId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('disable-plugin', pluginId),
  togglePlugin: (pluginId: string, enabled: boolean): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('toggle-plugin', { pluginId, enabled }),
  getPluginRegistry: (): Promise<{ plugins: Array<{ id: string; name: string; description: string; author: string; homepage: string; tier: string; latest: string; minAppVersion?: string; permissions: string[]; release: { tag: string; asset: string; url: string; sha256: string } | null }>; installed: Record<string, string> }> => ipcRenderer.invoke('marketplace:registry'),
  installPlugin: (pluginId: string): Promise<{ success: boolean; id?: string; folderName?: string; version?: string; error?: string }> => ipcRenderer.invoke('plugin:install', pluginId),
  uninstallPlugin: (pluginId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('plugin:uninstall', pluginId),
  executePluginTool: (pluginId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('execute-plugin-tool', { pluginId, toolName, args }),
  getPluginConfig: (pluginId: string): Promise<{ schema: Record<string, unknown>; values: Record<string, unknown>; pluginId: string; pluginName: string }> => ipcRenderer.invoke('get-plugin-config', pluginId),
  setPluginConfig: (pluginId: string, config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('set-plugin-config', { pluginId, config }),
  emitPluginEvent: (event: string, data?: unknown): Promise<{ success: boolean }> => ipcRenderer.invoke('plugin:event', { event, data }),
  getEventHistory: (filterType?: string): Promise<Array<{ type: string; timestamp: number; source: string; data?: unknown }>> => ipcRenderer.invoke('get-event-history', filterType),
  subscribeToEvents: (): Promise<{ success: boolean }> => ipcRenderer.invoke('subscribe-to-events'),
  clearEventHistory: (): Promise<{ success: boolean }> => ipcRenderer.invoke('clear-event-history'),
  // Service Registry
  discoverServices: (serviceType: string): Promise<Array<{ pluginId: string; capabilities: Record<string, unknown> }>> => ipcRenderer.invoke('discover-services', serviceType),
  getRegisteredServices: (): Promise<Array<{ serviceType: string; pluginId: string; capabilities: Record<string, unknown> }>> => ipcRenderer.invoke('get-registered-services'),
  getServiceTypes: (): Promise<string[]> => ipcRenderer.invoke('get-service-types'),
  hasServiceProviders: (serviceType: string): Promise<boolean> => ipcRenderer.invoke('has-service-providers', serviceType),
  callService: (serviceType: string, method: string, ...args: unknown[]): Promise<{ success: boolean; result?: unknown; error?: string }> => ipcRenderer.invoke('call-service', { serviceType, method, args }),
  // Scheduling - Events
  getEvents: (projectId?: string): Promise<ScheduleEvent[]> => ipcRenderer.invoke('get-events', projectId),
  getEvent: (eventId: string): Promise<ScheduleEvent | null> => ipcRenderer.invoke('get-event', eventId),
  createEvent: (eventData: Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ success: boolean; event?: ScheduleEvent; error?: string }> => ipcRenderer.invoke('create-event', eventData),
  updateEvent: (eventId: string, updates: Partial<Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>>): Promise<{ success: boolean; event?: ScheduleEvent; error?: string }> => ipcRenderer.invoke('update-event', { eventId, updates }),
  deleteEvent: (eventId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('delete-event', eventId),
  getEventsByDateRange: (startTime: number, endTime: number, projectId?: string): Promise<ScheduleEvent[]> => ipcRenderer.invoke('get-events-by-date-range', { startTime, endTime, projectId }),
  // Scheduling - Milestones
  getMilestones: (projectId?: string): Promise<Milestone[]> => ipcRenderer.invoke('get-milestones', projectId),
  getMilestone: (milestoneId: string): Promise<Milestone | null> => ipcRenderer.invoke('get-milestone', milestoneId),
  createMilestone: (milestoneData: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ success: boolean; milestone?: Milestone; error?: string }> => ipcRenderer.invoke('create-milestone', milestoneData),
  updateMilestone: (milestoneId: string, updates: Partial<Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>>): Promise<{ success: boolean; milestone?: Milestone; error?: string }> => ipcRenderer.invoke('update-milestone', { milestoneId, updates }),
  deleteMilestone: (milestoneId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('delete-milestone', milestoneId),
  // Scheduling - Deadlines
  getDeadlines: (projectId?: string): Promise<Deadline[]> => ipcRenderer.invoke('get-deadlines', projectId),
  getDeadline: (deadlineId: string): Promise<Deadline | null> => ipcRenderer.invoke('get-deadline', deadlineId),
  createDeadline: (deadlineData: Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ success: boolean; deadline?: Deadline; error?: string }> => ipcRenderer.invoke('create-deadline', deadlineData),
  updateDeadline: (deadlineId: string, updates: Partial<Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>>): Promise<{ success: boolean; deadline?: Deadline; error?: string }> => ipcRenderer.invoke('update-deadline', { deadlineId, updates }),
  deleteDeadline: (deadlineId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('delete-deadline', deadlineId),
  // Scheduling - Routines
  getRoutines: (projectId?: string): Promise<Routine[]> => ipcRenderer.invoke('routines:list', projectId),
  getRoutine: (routineId: string): Promise<Routine | null> => ipcRenderer.invoke('routines:get', routineId),
  createRoutine: (routineData: Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'pinned' | 'lastStatus' | 'lastError' | 'consecutiveFailures'>): Promise<{ success: boolean; routine?: Routine; error?: string }> => ipcRenderer.invoke('routines:create', routineData),
  updateRoutine: (routineId: string, updates: Partial<Omit<Routine, 'id' | 'projectId' | 'createdAt'>>): Promise<{ success: boolean; routine?: Routine; error?: string }> => ipcRenderer.invoke('routines:update', { routineId, updates }),
  deleteRoutine: (routineId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('routines:delete', routineId),
  setRoutinesPaused: (paused: boolean): Promise<{ success: boolean; paused?: boolean; rescheduled?: number; error?: string }> => ipcRenderer.invoke('routines:set-paused', paused),
  executeRoutine: (routineId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('routines:execute', routineId),
  getSchedulerStatus: (): Promise<{ running: boolean; paused?: boolean }> => ipcRenderer.invoke('routines:scheduler-status'),
  calculateNextRun: (cronExpression: string, fromTime?: number): Promise<number> => ipcRenderer.invoke('routines:calculate-next-run', { cronExpression, fromTime }),
  // Workflows
  getWorkflows: (projectId: string): Promise<Workflow[]> => ipcRenderer.invoke('workflows:list', projectId),
  getWorkflow: (workflowId: string): Promise<Workflow | null> => ipcRenderer.invoke('workflows:get', workflowId),
  createWorkflow: (data: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt' | 'pinned'>): Promise<Workflow> => ipcRenderer.invoke('workflows:create', data),
  updateWorkflow: (workflowId: string, data: Partial<Omit<Workflow, 'id' | 'projectId' | 'createdAt'>>): Promise<Workflow | null> => ipcRenderer.invoke('workflows:update', { workflowId, data }),
  deleteWorkflow: (workflowId: string): Promise<boolean> => ipcRenderer.invoke('workflows:delete', workflowId),
  executeWorkflow: (workflowId: string, variables?: Record<string, unknown>): Promise<{ success: boolean; executionId: string; workflowId: string; startTime: number; endTime: number; duration: number; outputs: Record<string, unknown>; error?: string }> => ipcRenderer.invoke('workflows:execute', { workflowId, variables }),
  approveWorkflow: (workflowId: string): Promise<{ success: boolean; workflow?: Workflow; error?: string }> => ipcRenderer.invoke('workflows:approve', workflowId),
  getPendingReviewCount: (projectId?: string): Promise<{ success: boolean; count?: number; error?: string }> => ipcRenderer.invoke('workflows:count-pending-review', projectId),

  // Terminal
  createTerminal: (id: string, options?: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
  }): Promise<{ success: boolean; cwd?: string; error?: string }> => ipcRenderer.invoke('terminal:create', { id, options }),
  writeToTerminal: (id: string, data: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('terminal:write', { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  destroyTerminal: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('terminal:destroy', id),
  listTerminals: (): Promise<{ success: boolean; terminals?: Array<{ id: string; running: boolean }>; error?: string }> => ipcRenderer.invoke('terminal:list'),

  // Files
  listFiles: (projectId: string): Promise<ProjectFile[]> => ipcRenderer.invoke('files:list', projectId),
  addFile: (projectId: string, filePath: string): Promise<ProjectFile> => ipcRenderer.invoke('files:add', { projectId, filePath }),
  addMultipleFiles: (projectId: string, filePaths: string[]): Promise<Array<{ success: boolean; file?: ProjectFile; path?: string; error?: string }>> => ipcRenderer.invoke('files:add-multiple', { projectId, filePaths }),
  removeFile: (fileId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('files:remove', fileId),
  getFile: (fileId: string): Promise<ProjectFile | null> => ipcRenderer.invoke('files:get', fileId),
  pickFiles: (): Promise<{ canceled: boolean; paths: string[] }> => ipcRenderer.invoke('files:pick-files'),
  pickFolder: (): Promise<{ canceled: boolean; paths: string[] }> => ipcRenderer.invoke('files:pick-folder'),

  // Activity
  getActivities: (filter?: {
    types?: string[];
    categories?: string[];
    sources?: string[];
    audience?: 'user' | 'system';
    projectId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ success: boolean; activities?: Activity[]; error?: string }> => ipcRenderer.invoke('activities:list', filter),
  getActivityCategories: (audience?: 'user' | 'system'): Promise<{ success: boolean; categories?: string[]; error?: string }> => ipcRenderer.invoke('activities:categories', audience),
  getActivityRecentCount: (since?: number): Promise<{ success: boolean; count?: number; error?: string }> => ipcRenderer.invoke('activities:recent-count', since),
  clearActivities: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('activities:clear'),
  clearActivitiesBefore: (timestamp: number): Promise<{ success: boolean; deleted?: number; error?: string }> => ipcRenderer.invoke('activities:clear-before', timestamp),
  getActivityCount: (): Promise<{ success: boolean; count?: number; error?: string }> => ipcRenderer.invoke('activities:count'),
  onActivityNew: (callback: (activity: Activity) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Activity) => callback(data);
    ipcRenderer.on('activity:new', listener);
    return () => ipcRenderer.removeListener('activity:new', listener);
  },

  // Live work
  listActiveWork: (): Promise<{ success: boolean; work?: Array<{ id: string; kind: string; agentId?: string; agentName?: string; containerId?: string; label?: string; startedAt: number; cancellable: boolean }>; error?: string }> =>
    ipcRenderer.invoke('work:list-active'),
  cancelActiveWork: (id: string): Promise<{ success: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('work:cancel', { id }),

  // App
  platform: process.platform,
  setTitleBarOverlay: (colors: { color: string; symbolColor: string }): Promise<{ applied: boolean }> =>
    ipcRenderer.invoke('window:set-title-bar-overlay', colors),

  // Window view controls (View menu). Zoom returns the resulting state so the
  // menu can render the current percentage and disable at the clamp.
  zoomIn: (): Promise<ZoomLevelState> => ipcRenderer.invoke('window:zoom-in'),
  zoomOut: (): Promise<ZoomLevelState> => ipcRenderer.invoke('window:zoom-out'),
  resetZoom: (): Promise<ZoomLevelState> => ipcRenderer.invoke('window:zoom-reset'),
  getZoom: (): Promise<ZoomLevelState> => ipcRenderer.invoke('window:get-zoom'),
  toggleFullscreen: (): Promise<{ fullscreen: boolean }> => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullscreen: (): Promise<{ fullscreen: boolean }> => ipcRenderer.invoke('window:is-fullscreen'),
  toggleDevTools: (): Promise<{ open: boolean }> => ipcRenderer.invoke('window:toggle-devtools'),

  // Caption buttons — Linux runs frameless and draws its own (see main.ts).
  minimizeWindow: (): Promise<{ success: boolean }> => ipcRenderer.invoke('window:minimize'),
  /** Resulting state arrives via onMaximizeChanged — the WM applies it asynchronously. */
  toggleMaximizeWindow: (): Promise<{ success: boolean }> => ipcRenderer.invoke('window:toggle-maximize'),
  isWindowMaximized: (): Promise<{ maximized: boolean }> => ipcRenderer.invoke('window:is-maximized'),
  closeWindow: (): Promise<{ success: boolean }> => ipcRenderer.invoke('window:close'),
  onMaximizeChanged: (callback: (state: { maximized: boolean }) => void): (() => void) => {
    const listener = (_event: unknown, state: { maximized: boolean }) => callback(state);
    ipcRenderer.on('window:maximize-changed', listener);
    return () => ipcRenderer.removeListener('window:maximize-changed', listener);
  },

  /**
   * Commands chosen from the native macOS menu. The menu itself holds no
   * behaviour — it forwards the command id and the renderer's registry runs
   * it, so both menu surfaces share one implementation.
   */
  onMenuCommand: (
    callback: (payload: { commandId: string; dynamicId?: string; checked?: boolean }) => void,
  ): (() => void) => {
    const listener = (
      _event: unknown,
      payload: { commandId: string; dynamicId?: string; checked?: boolean },
    ) => callback(payload);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },

  /** Pushes checkbox and dynamic-submenu state so the native menu can redraw. */
  syncMenuState: (state: {
    checkboxes?: Record<string, boolean>;
    dynamic?: Record<string, Array<{ id: string; label: string; checked?: boolean }>>;
  }): Promise<{ success: boolean }> => ipcRenderer.invoke('menu:sync-state', state),
  getAppVersion: (): Promise<{ version: string }> => ipcRenderer.invoke('app:get-version'),
  openExternal: (url: string): Promise<{ success: boolean }> => ipcRenderer.invoke('app:open-external', { url }),
  getDataDir: (): Promise<{ path: string; appDataPath: string }> => ipcRenderer.invoke('app:get-data-dir'),
  openDataDir: (): Promise<{ success: boolean }> => ipcRenderer.invoke('app:open-data-dir'),
  quitApp: (): Promise<{ success: boolean }> => ipcRenderer.invoke('app:quit'),
  getModelCapabilities: (params: { provider: string; modelId: string }): Promise<{
    temperature: boolean; topP: boolean; stopSequences: boolean;
    rawPrompt: boolean; maxOutputTokens: boolean; toolUse: boolean;
  }> => ipcRenderer.invoke('app:get-model-capabilities', params),
  detectModelContext: (params: { provider: string; modelId: string }): Promise<{
    contextWindow: number; maxContextLength?: number; loadedContextLength?: number;
    source: 'lmstudio-api' | 'ollama-api';
  } | null> => ipcRenderer.invoke('app:detect-model-context', params),
  getToolInventory: (): Promise<import('../shared/toolCatalog').ToolInventoryEntry[]> =>
    ipcRenderer.invoke('app:get-tool-inventory'),

  // Messaging Bridges
  getMessagingBridges: (): Promise<{ success: boolean; bridges?: Array<{ platform: string; running: boolean; sessionCount: number; botUsername?: string; connectedAt?: number; lastInboundAt?: number; lastError?: { message: string; at: number } }> }> => ipcRenderer.invoke('messaging:get-bridges'),
  startMessagingBridge: (platform: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('messaging:start-bridge', { platform }),
  stopMessagingBridge: (platform: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('messaging:stop-bridge', { platform }),
  getMessagingBridgeConfig: (platform: string): Promise<{ success: boolean; hasConfig?: boolean; allowedUserIds?: string[]; autoStart?: boolean }> => ipcRenderer.invoke('messaging:get-bridge-config', { platform }),
  setMessagingBridgeConfig: (params: { platform: string; token: string; allowedUserIds: string[]; autoStart?: boolean; keepExistingToken?: boolean }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('messaging:set-bridge-config', params),
  testMessagingBridgeConnection: (platform: string): Promise<{ success: boolean; ok?: boolean; botUsername?: string; error?: string }> => ipcRenderer.invoke('messaging:test-connection', { platform }),
  deleteMessagingBridgeConfig: (platform: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('messaging:delete-bridge-config', { platform }),
  getMessagingBridgeSessions: (platform: string): Promise<{ success: boolean; sessions?: Array<{ platform: string; externalUserId: string; currentChatId: string | null; currentAgentId: string | null; lastActiveAt: number }> }> => ipcRenderer.invoke('messaging:get-sessions', { platform }),

  // Agent Memories
  getCandidateMemories: (agentId: string) => ipcRenderer.invoke('get-candidate-memories', agentId),
  getCandidateMemoryCount: (agentId: string) => ipcRenderer.invoke('get-candidate-memory-count', agentId),
  getApprovedMemories: (agentId: string) => ipcRenderer.invoke('get-approved-memories', agentId),
  reviewMemory: (memoryId: string, status: string) => ipcRenderer.invoke('review-memory', { memoryId, status }),
  bulkReviewMemories: (memoryIds: string[], status: string) => ipcRenderer.invoke('bulk-review-memories', { memoryIds, status }),
  deleteMemory: (memoryId: string) => ipcRenderer.invoke('delete-memory', memoryId),

  // Memory-backend (browse/manage the active memory store — core default or plugin)
  memoryList: (params?: { pattern?: string; limit?: number; offset?: number }) => ipcRenderer.invoke('memory:list', params ?? {}),
  memorySearch: (params: { query: string; limit?: number; tags?: string[] }) => ipcRenderer.invoke('memory:search', params),
  memoryRetrieve: (key: string) => ipcRenderer.invoke('memory:retrieve', key),
  memoryStore: (params: { key: string; value: string; metadata?: Record<string, unknown> }) => ipcRenderer.invoke('memory:store', params),
  memoryDelete: (key: string) => ipcRenderer.invoke('memory:delete', key),
  memoryBlocksList: (agentId: string) => ipcRenderer.invoke('memory:blocks:list', agentId),
  memoryBlockSet: (params: { agentId: string; label: string; value: string }) => ipcRenderer.invoke('memory:block:set', params),

  // Backups (database snapshots)
  listBackups: (): Promise<{ success: boolean; snapshots?: BackupSnapshot[]; error?: string }> =>
    ipcRenderer.invoke('backup:list'),
  createBackup: (): Promise<{ success: boolean; snapshot?: BackupSnapshot; error?: string }> =>
    ipcRenderer.invoke('backup:create'),
  deleteBackup: (filename: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('backup:delete', filename),
  restoreBackup: (filename: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('backup:restore', filename),

  // LAN sync
  syncGetState: (): Promise<{ success: boolean; state?: unknown; error?: string }> =>
    ipcRenderer.invoke('sync:get-state'),
  syncSetEnabled: (enabled: boolean): Promise<{ success: boolean; state?: unknown; error?: string }> =>
    ipcRenderer.invoke('sync:set-enabled', enabled),
  syncSetDeviceName: (name: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('sync:set-device-name', name),
  syncSetPairingMode: (active: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('sync:set-pairing-mode', active),
  syncConfirmPair: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('sync:confirm-pair'),
  syncRejectPair: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('sync:reject-pair'),
  syncConnect: (host: string, port: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('sync:connect', { host, port }),
  syncUnpair: (deviceId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('sync:unpair', deviceId),

  // Auto-updater
  updaterGetState: (): Promise<{ status: string; info?: unknown; progress?: unknown; error?: string }> => ipcRenderer.invoke('updater:get-state'),
  updaterCheck: (): Promise<{ status: string; info?: unknown; progress?: unknown; error?: string }> => ipcRenderer.invoke('updater:check'),
  updaterDownload: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('updater:download'),
  updaterQuitAndInstall: (): Promise<{ success: boolean }> => ipcRenderer.invoke('updater:quit-and-install'),
  onUpdaterState: (callback: (state: { status: string; info?: unknown; progress?: unknown; error?: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { status: string; info?: unknown; progress?: unknown; error?: string }) => callback(data);
    ipcRenderer.on('updater:state', listener);
    return () => ipcRenderer.removeListener('updater:state', listener);
  },

  // Tray navigation events
  onTrayNavigate: (callback: (view: 'chats' | 'channels' | 'settings') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, view: 'chats' | 'channels' | 'settings') => callback(view);
    ipcRenderer.on('tray:navigate', listener);
    return () => ipcRenderer.removeListener('tray:navigate', listener);
  },

  // Generic event listeners for plugins and custom events. Gated by
  // `isGenericChannelAllowed` — disallowed channels log a clear error and
  // return a no-op cleanup so the renderer can't snoop on protected channels.
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (!isGenericChannelAllowed(channel)) {
      console.error(`[preload] Refused on('${channel}'): channel not in whitelist`);
      return () => {};
    }
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    if (!listenerMap.has(callback)) listenerMap.set(callback, new Map());
    listenerMap.get(callback)!.set(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
      listenerMap.get(callback)?.delete(channel);
    };
  },
  off: (channel: string, callback: (...args: unknown[]) => void): void => {
    // off() is safe even for non-whitelisted channels — removing a listener
    // that was never registered is a no-op. No need to gate.
    const channelMap = listenerMap.get(callback);
    const listener = channelMap?.get(channel);
    if (listener) {
      ipcRenderer.removeListener(channel, listener as any);
      channelMap!.delete(channel);
    } else {
      ipcRenderer.removeListener(channel, callback as any);
    }
  },
  once: (channel: string, callback: (...args: unknown[]) => void): void => {
    if (!isGenericChannelAllowed(channel)) {
      console.error(`[preload] Refused once('${channel}'): channel not in whitelist`);
      return;
    }
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.once(channel, listener);
  },
});

