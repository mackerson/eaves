import { Agent, AgentMemory, AgentMemoryStatus, User, Message, MCPServer, Project, Task, Note, NoteLabel, NoteAIMetadata, Settings, Channel, Chat, ChatMessage, MessageMetrics, ContentBlock, ScheduleEvent, Milestone, Deadline, Routine, Workflow, File as ProjectFile, PluginManifest, Activity, ThemeDefinition, BackupSnapshot, ConversationFolder, MemoryListResult, MemorySearchResponse, MemoryRetrieveResult, MemoryStoreResult, MemoryDeleteResult } from '../shared/types';
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

declare global {
  interface Window {
    electron: {
      // App State
      getMemory: () => Promise<AppState>;

      // Chat
      onChatStream: (callback: (event: ChatStreamEvent | string) => void) => (() => void);
      onMessageUpdated: (callback: (event: { messageId: string; contentBlocks: ContentBlock[]; content?: string; isDraft?: boolean; metrics?: MessageMetrics }) => void) => (() => void);
      onChannelMessageAdded: (callback: (event: { channelId: string; message: Message }) => void) => (() => void);
      onChannelsChanged: (callback: () => void) => (() => void);
      onAgentsChanged: (callback: () => void) => (() => void);
      onProjectDataChanged: (callback: () => void) => (() => void);

      // Agents
      createAgent: (agentData: CreateAgentRequest) => Promise<Agent>;
      updateAgent: (agentId: string, updates: UpdateAgentRequest) => Promise<Agent>;
      deleteAgent: (agentId: string) => Promise<{ success: boolean }>;
      switchAgent: (agentId: string) => Promise<{ success: boolean }>;
      getAgents: () => Promise<{ success: boolean; agents: Agent[]; error?: string }>;
      fetchModels: (provider: string, baseURL?: string) => Promise<{ success: boolean; models?: string[]; error?: string }>;
      listProviders: () => Promise<{
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
      }>;

      // Users
      getUsers: () => Promise<User[]>;
      getCurrentUser: () => Promise<User | null>;
      createUser: (userData: CreateUserRequest) => Promise<UserResponse>;
      updateUser: (userId: string, updates: UpdateUserRequest) => Promise<User>;
      deleteUser: (userId: string) => Promise<{ success: boolean }>;
      switchUser: (userId: string) => Promise<{ success: boolean }>;

      // MCP Servers
      addMCPServer: (agentId: string, serverData: MCPServerRequest) => Promise<MCPServer>;
      updateMCPServer: (agentId: string, serverId: string, updates: UpdateMCPServerRequest) => Promise<{ success: boolean }>;
      deleteMCPServer: (agentId: string, serverId: string) => Promise<{ success: boolean }>;

      // Projects
      createProject: (params: CreateProjectRequest) => Promise<Project>;
      updateProject: (projectId: string, updates: UpdateProjectRequest) => Promise<Project>;
      switchProject: (projectId: string) => Promise<{ success: boolean; error?: string; tasks?: Task[]; notes?: Note[]; events?: CalendarEvent[]; labels?: NoteLabel[] }>;
      deleteProject: (projectId: string) => Promise<{ success: boolean }>;

      // Tasks
      addTask: (taskData: CreateTaskRequest) => Promise<Task>;
      updateTask: (taskId: string, updates: UpdateTaskRequest) => Promise<Task>;
      toggleTask: (taskId: string) => Promise<Task>;
      deleteTask: (taskId: string) => Promise<{ success: boolean }>;
      reorderTasks: (orders: { id: string; sortOrder: number }[]) => Promise<{ success: boolean }>;

      // Notes
      addNote: (noteData: CreateNoteRequest) => Promise<Note>;
      updateNote: (noteId: string, updates: UpdateNoteRequest) => Promise<Note>;
      toggleNotePin: (noteId: string) => Promise<Note>;
      deleteNote: (noteId: string) => Promise<{ success: boolean }>;
      listNotes: (options?: ListNotesRequest) => Promise<Note[]>;
      getNoteLabels: (projectId?: string) => Promise<NoteLabel[]>;
      createNoteLabel: (labelData: CreateNoteLabelRequest) => Promise<NoteLabel>;
      deleteNoteLabel: (labelId: string) => Promise<{ success: boolean }>;
      generateNoteMetadata: (noteId: string) => Promise<{ success: boolean; metadata?: NoteAIMetadata; note?: Note; error?: string }>;
      reorderNotes: (orders: { id: string; sortOrder: number }[]) => Promise<{ success: boolean }>;

      // Settings
      updateSettings: (settings: UpdateSettingsRequest) => Promise<Settings>;

      // OOBE
      getOobeDefaults: () => Promise<{ userName: string | null; apiKeys: Partial<Record<'anthropic' | 'openai' | 'google' | 'ollama' | 'lmstudio', string | null>> }>;
      validateApiKey: (params: { provider: string; apiKey: string }) => Promise<{ valid: boolean; error?: string; models?: string[] }>;
      oobeGenerate: (params: { provider: string; model: string; apiKey: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; systemPrompt?: string }) => Promise<{ success: boolean; content?: string; error?: string }>;
      onOobeStream: (callback: (event: { type: 'text' | 'done' | 'error'; content?: string; error?: string }) => void) => (() => void);
      completeOobe: () => Promise<{ success: boolean }>;

      // Channels
      createChannel: (params: CreateChannelRequest) => Promise<{ success: boolean; channel?: Channel; error?: string }>;
      getChannels: (options?: { includeArchived?: boolean }) => Promise<{ success: boolean; channels?: Channel[]; error?: string }>;
      archiveChannel: (channelId: string) => Promise<{ success: boolean; channel?: Channel; error?: string }>;
      unarchiveChannel: (channelId: string) => Promise<{ success: boolean; channel?: Channel; error?: string }>;
      searchChannels: (params: SearchChannelsRequest) => Promise<{ success: boolean; channels?: Channel[]; error?: string }>;
      getChannelsByTags: (params: GetChannelsByTagsRequest) => Promise<{ success: boolean; channels?: Channel[]; error?: string }>;
      updateChannel: (channelId: string, updates: UpdateChannelRequest) => Promise<Channel>;
      deleteChannel: (channelId: string) => Promise<{ success: boolean }>;
      switchChannel: (channelId: string) => Promise<{ success: boolean; channel?: Channel }>;
      sendMessage: (params: SendMessageRequest) => Promise<MessageResponse>;
      /** @deprecated QA-harness-only: inserts an agent message directly. Real agent turns are persisted by the main process — app code must not call this. */
      addAgentMessage: (params: AddAgentMessageRequest) => Promise<MessageResponse>;
      addChannelParticipant: (params: AddChannelParticipantRequest) => Promise<{ success: boolean }>;
      updateMessage: (messageId: string, content: string) => Promise<{ success: boolean; contentBlocks?: ContentBlock[] | null; error?: string }>;
      startWorkSession: (params: { taskId: string; agentId: string; parentChannelId?: string }) => Promise<{ success: boolean; session?: Chat; error?: string }>;
      getWorkSession: (sessionId: string) => Promise<{ success: boolean; session?: Chat; error?: string }>;
      listWorkSessionsForTask: (taskId: string) => Promise<{ success: boolean; sessions?: Chat[]; error?: string }>;
      setConversationPinned: (conversationId: string, pinned: boolean) => Promise<{ success: boolean; error?: string }>;
      setConversationFolder: (conversationId: string, folderId: string | null) => Promise<{ success: boolean; error?: string }>;
      listConversationFolders: (projectId?: string) => Promise<{ success: boolean; folders?: ConversationFolder[]; error?: string }>;
      createConversationFolder: (name: string, projectId?: string) => Promise<{ success: boolean; folder?: ConversationFolder; error?: string }>;
      renameConversationFolder: (folderId: string, name: string) => Promise<{ success: boolean; error?: string }>;
      deleteConversationFolder: (folderId: string) => Promise<{ success: boolean; error?: string }>;
      deleteMessage: (messageId: string) => Promise<{ success: boolean }>;
      stopStream: (params?: StopStreamRequest) => Promise<{ success: boolean }>;

      // Tool approvals (HITL)
      listPendingApprovals: (filter?: { context: 'chat' | 'channel'; contextId: string }) => Promise<{
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
      }>;
      listApprovalGrants: (containerId: string) => Promise<{ success: boolean; grants?: Array<{ id: string; containerId: string; agentId: string; toolName: string; grantedAt: number }>; error?: string }>;
      grantToolApproval: (params: { containerId: string; agentId: string; toolName: string }) => Promise<{ success: boolean; error?: string }>;
      revokeToolApproval: (grantId: string) => Promise<{ success: boolean; error?: string }>;
      respondToApprovals: (params: {
        decisions: Array<{ approvalId: string; approved: boolean; reason?: string }>;
        context?: 'chat' | 'channel';
        contextId?: string;
        agentId?: string;
        messageId?: string;
      }) => Promise<{ success: boolean; error?: string }>;
      respondToApproval: (params: {
        approvalId: string;
        approved: boolean;
        reason?: string;
        context?: 'chat' | 'channel';
        contextId?: string;
        agentId?: string;
        messageId?: string;
      }) => Promise<{ success: boolean; error?: string }>;

      // Chats
      createChat: (params: CreateChatRequest) => Promise<{ success: boolean; chat?: Chat; error?: string }>;
      switchChat: (chatId: string) => Promise<{ success: boolean; error?: string }>;
      updateChat: (chatId: string, updates: UpdateChatRequest) => Promise<{ success: boolean; chat?: Chat; error?: string }>;
      duplicateChat: (chatId: string) => Promise<{ success: boolean; chat?: Chat; error?: string }>;
      exportChatMarkdown: (chatId: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      archiveChat: (chatId: string) => Promise<{ success: boolean; chat?: Chat; error?: string }>;
      unarchiveChat: (chatId: string) => Promise<{ success: boolean; chat?: Chat; error?: string }>;
      deleteChat: (chatId: string) => Promise<{ success: boolean }>;
      getChats: (options?: { includeArchived?: boolean }) => Promise<{ success: boolean; chats?: Chat[] }>;
      getChat: (chatId: string) => Promise<{ success: boolean; chat?: Chat; error?: string }>;
      getChatsByAgent: (agentId: string, options?: { includeArchived?: boolean }) => Promise<{ success: boolean; chats?: Chat[] }>;
      searchChats: (params: SearchChatsRequest) => Promise<{ success: boolean; chats?: Chat[] }>;
      getChatsByTags: (params: GetChatsByTagsRequest) => Promise<{ success: boolean; chats?: Chat[] }>;
      sendChatMessage: (params: SendChatMessageRequest) => Promise<{ success: boolean; message?: ChatMessage; error?: string }>;
      addChatAgentMessage: (params: AddChatAgentMessageRequest) => Promise<{ success: boolean; message?: ChatMessage; error?: string }>;
      addChatParticipant: (params: AddChatParticipantRequest) => Promise<{ success: boolean; error?: string }>;
      updateChatMessage: (messageId: string, content: string) => Promise<{ success: boolean; contentBlocks?: ContentBlock[] | null; error?: string }>;
      deleteChatMessage: (messageId: string) => Promise<{ success: boolean }>;
      chatWithAgent: (params: { chatId: string; agentId: string }) => Promise<{ success: boolean; response?: string; metrics?: MessageMetrics; aborted?: boolean; error?: string }>;
      regenerateChatMessage: (params: { messageId: string }) => Promise<{ success: boolean; response?: string; metrics?: MessageMetrics; aborted?: boolean; error?: string }>;
      switchActiveBranch: (params: { messageId: string }) => Promise<{ success: boolean; error?: string }>;
      swipeChatMessageBranch: (params: { messageId: string; direction: 'prev' | 'next' }) => Promise<{ success: boolean; switchedToMessageId?: string; error?: string }>;
      stopChatStream: (chatId: string) => Promise<{ success: boolean; error?: string }>;
      generateChatMetadata: (params: { chatId: string; messages: ChatMessage[] }) => Promise<{ success: boolean; title?: string; tags?: string; error?: string }>;
      getChatTools: (chatId: string) => Promise<{ success: boolean; tools?: Array<{ name: string; label: string; category: 'discovery' | 'builtin' | 'plugin' | 'mcp'; enabled: boolean }>; error?: string }>;
      toggleChatTool: (chatId: string, toolName: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
      replaceAttachmentFile: (params: { assetPointer: string; filePath: string; messageId?: string }) => Promise<{ success: boolean; newUrl?: string; error?: string }>;
      getPathForFile: (file: File) => string;

      // Dialog/File Pickers
      pickImages: () => Promise<{ canceled: boolean; files?: Array<{ path: string; filename: string; mimeType: string; previewDataUrl?: string }> }>;
      pickAvatar: () => Promise<{ canceled: boolean; filename?: string }>;
      pickBackgroundImage: () => Promise<{ canceled: boolean; path?: string }>;
      openFile: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ success: boolean; canceled: boolean; filePaths: string[] }>;
      openDirectory: (options?: { title?: string }) => Promise<{ success: boolean; canceled: boolean; filePaths: string[] }>;

      // Background image caching
      cacheBackgroundUrl: (url: string) => Promise<{ success: boolean; path?: string }>;
      getCachedBackground: (url: string) => Promise<{ cached: boolean; path?: string }>;
      clearBackgroundCache: () => Promise<{ success: boolean }>;

      // Logs
      getLogFiles: () => Promise<Array<{ path: string; name: string; size: number; modified: number }>>;
      getLogDir: () => Promise<string>;
      openLogDir: () => Promise<void>;
      // Only reads files the logger itself wrote, and only the last 1MB of one.
      readLogFile: (filePath: string) => Promise<{ success: boolean; content?: string; size?: number; truncated?: boolean; error?: string }>;
      clearLogs: () => Promise<void>;
      logError: (errorData: LogErrorRequest) => Promise<void>;

      // User Themes
      getUserThemes: () => Promise<ThemeDefinition[]>;
      getUserTheme: (themeId: string) => Promise<ThemeDefinition | null>;
      getUserThemeCSS: (themeId: string) => Promise<string | null>;
      isUserTheme: (themeId: string) => Promise<boolean>;
      reloadUserThemes: () => Promise<ThemeDefinition[]>;
      getThemesDirectory: () => Promise<string>;
      openThemesDirectory: () => Promise<{ success: boolean }>;

      // Plugins
      getPlugins: () => Promise<Array<PluginManifest & { enabled: boolean; hasView: boolean; viewId?: string }>>;
      getPluginViews: () => Promise<Array<{ id: string; title: string; icon?: string; component: string; showInSidebar?: boolean; pluginId: string; uiMetadata?: PluginManifest['ui']; folderName?: string; source?: string }>>;
      getImportPluginViews: () => Promise<Array<{ id: string; title: string; icon?: string; component: string; showInSidebar?: boolean; pluginId: string; uiMetadata?: PluginManifest['ui']; folderName?: string; source?: string; description: string }>>;
      getPluginTerminalViews: () => Promise<Array<{ id: string; title: string; icon?: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; showInSidebar?: boolean; pluginId: string }>>;
      reloadPlugin: (pluginId: string) => Promise<{ success: boolean; error?: string }>;
      enablePlugin: (pluginId: string) => Promise<{ success: boolean; error?: string }>;
      disablePlugin: (pluginId: string) => Promise<{ success: boolean; error?: string }>;
      togglePlugin: (pluginId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
      getPluginRegistry: () => Promise<{ plugins: Array<{ id: string; name: string; description: string; author: string; homepage: string; tier: string; latest: string; minAppVersion?: string; permissions: string[]; release: { tag: string; asset: string; url: string; sha256: string } | null }>; installed: Record<string, string> }>;
      installPlugin: (pluginId: string) => Promise<{ success: boolean; id?: string; folderName?: string; version?: string; error?: string }>;
      uninstallPlugin: (pluginId: string) => Promise<{ success: boolean; error?: string }>;
      executePluginTool: (pluginId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
      getPluginConfig: (pluginId: string) => Promise<{ schema: Record<string, { type: string; default?: unknown; description?: string }>; values: Record<string, unknown>; pluginId: string; pluginName: string }>;
      setPluginConfig: (pluginId: string, config: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
      emitPluginEvent: (event: string, data?: unknown) => Promise<{ success: boolean }>;
      getEventHistory: (filterType?: string) => Promise<Array<{ type: string; timestamp: number; source: string; data?: unknown }>>;
      subscribeToEvents: () => Promise<{ success: boolean }>;
      clearEventHistory: () => Promise<{ success: boolean }>;

      // Service Registry
      discoverServices: (serviceType: string) => Promise<Array<{ pluginId: string; capabilities: Record<string, unknown> }>>;
      getRegisteredServices: () => Promise<Array<{ serviceType: string; pluginId: string; capabilities: Record<string, unknown> }>>;
      getServiceTypes: () => Promise<string[]>;
      hasServiceProviders: (serviceType: string) => Promise<boolean>;
      callService: (serviceType: string, method: string, ...args: unknown[]) => Promise<{ success: boolean; result?: unknown; error?: string }>;

      // Scheduling - Events
      getEvents: (projectId?: string) => Promise<ScheduleEvent[]>;
      getEvent: (eventId: string) => Promise<ScheduleEvent | null>;
      createEvent: (eventData: Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>) => Promise<{ success: boolean; event?: ScheduleEvent; error?: string }>;
      updateEvent: (eventId: string, updates: Partial<Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<{ success: boolean; event?: ScheduleEvent; error?: string }>;
      deleteEvent: (eventId: string) => Promise<{ success: boolean; error?: string }>;
      getEventsByDateRange: (startTime: number, endTime: number, projectId?: string) => Promise<ScheduleEvent[]>;

      // Scheduling - Milestones
      getMilestones: (projectId?: string) => Promise<Milestone[]>;
      getMilestone: (milestoneId: string) => Promise<Milestone | null>;
      createMilestone: (milestoneData: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>) => Promise<{ success: boolean; milestone?: Milestone; error?: string }>;
      updateMilestone: (milestoneId: string, updates: Partial<Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<{ success: boolean; milestone?: Milestone; error?: string }>;
      deleteMilestone: (milestoneId: string) => Promise<{ success: boolean; error?: string }>;

      // Scheduling - Deadlines
      getDeadlines: (projectId?: string) => Promise<Deadline[]>;
      getDeadline: (deadlineId: string) => Promise<Deadline | null>;
      createDeadline: (deadlineData: Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>) => Promise<{ success: boolean; deadline?: Deadline; error?: string }>;
      updateDeadline: (deadlineId: string, updates: Partial<Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<{ success: boolean; deadline?: Deadline; error?: string }>;
      deleteDeadline: (deadlineId: string) => Promise<{ success: boolean; error?: string }>;

      // Scheduling - Routines
      getRoutines: (projectId?: string) => Promise<Routine[]>;
      getRoutine: (routineId: string) => Promise<Routine | null>;
      createRoutine: (routineData: Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'pinned' | 'lastStatus' | 'lastError' | 'consecutiveFailures'>) => Promise<{ success: boolean; routine?: Routine; error?: string }>;
      updateRoutine: (routineId: string, updates: Partial<Omit<Routine, 'id' | 'projectId' | 'createdAt'>>) => Promise<{ success: boolean; routine?: Routine; error?: string }>;
      deleteRoutine: (routineId: string) => Promise<{ success: boolean; error?: string }>;
      setRoutinesPaused: (paused: boolean) => Promise<{ success: boolean; paused?: boolean; rescheduled?: number; error?: string }>;
      executeRoutine: (routineId: string) => Promise<{ success: boolean; error?: string }>;
      getSchedulerStatus: () => Promise<{ running: boolean; paused?: boolean }>;
      calculateNextRun: (cronExpression: string, fromTime?: number) => Promise<number>;

      // Workflows
      getWorkflows: (projectId: string) => Promise<Workflow[]>;
      getWorkflow: (workflowId: string) => Promise<Workflow | null>;
      createWorkflow: (data: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt' | 'pinned'>) => Promise<Workflow>;
      updateWorkflow: (workflowId: string, data: Partial<Omit<Workflow, 'id' | 'projectId' | 'createdAt'>>) => Promise<Workflow | null>;
      deleteWorkflow: (workflowId: string) => Promise<boolean>;
      executeWorkflow: (workflowId: string, variables?: Record<string, unknown>) => Promise<{
        success: boolean;
        executionId: string;
        workflowId: string;
        startTime: number;
        endTime: number;
        duration: number;
        outputs: Record<string, unknown>;
        error?: string;
      }>;
      approveWorkflow: (workflowId: string) => Promise<{ success: boolean; workflow?: Workflow; error?: string }>;
      getPendingReviewCount: (projectId?: string) => Promise<{ success: boolean; count?: number; error?: string }>;

      // Terminal
      createTerminal: (id: string, options?: {
        command?: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        cols?: number;
        rows?: number;
      }) => Promise<{ success: boolean; cwd?: string; error?: string }>;
      writeToTerminal: (id: string, data: string) => Promise<{ success: boolean; error?: string }>;
      resizeTerminal: (id: string, cols: number, rows: number) => Promise<{ success: boolean; error?: string }>;
      destroyTerminal: (id: string) => Promise<{ success: boolean; error?: string }>;
      listTerminals: () => Promise<{ success: boolean; terminals?: Array<{ id: string; running: boolean }>; error?: string }>;

      // Files
      listFiles: (projectId: string) => Promise<ProjectFile[]>;
      addFile: (projectId: string, filePath: string) => Promise<ProjectFile>;
      addMultipleFiles: (projectId: string, filePaths: string[]) => Promise<Array<{ success: boolean; file?: ProjectFile; path?: string; error?: string }>>;
      removeFile: (fileId: string) => Promise<{ success: boolean }>;
      getFile: (fileId: string) => Promise<ProjectFile | null>;
      pickFiles: () => Promise<{ canceled: boolean; paths: string[] }>;
      pickFolder: () => Promise<{ canceled: boolean; paths: string[] }>;

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
      }) => Promise<{ success: boolean; activities?: Activity[]; error?: string }>;
      getActivityCategories: (audience?: 'user' | 'system') => Promise<{ success: boolean; categories?: string[]; error?: string }>;
      getActivityRecentCount: (since?: number) => Promise<{ success: boolean; count?: number; error?: string }>;
      clearActivities: () => Promise<{ success: boolean; error?: string }>;
      clearActivitiesBefore: (timestamp: number) => Promise<{ success: boolean; deleted?: number; error?: string }>;
      getActivityCount: () => Promise<{ success: boolean; count?: number; error?: string }>;
      onActivityNew: (callback: (activity: Activity) => void) => () => void;

      // Agent Memories
      getCandidateMemories: (agentId: string) => Promise<{ success: boolean; data?: AgentMemory[]; error?: string }>;
      getCandidateMemoryCount: (agentId: string) => Promise<{ success: boolean; data?: number; error?: string }>;
      getApprovedMemories: (agentId: string) => Promise<{ success: boolean; data?: AgentMemory[]; error?: string }>;
      reviewMemory: (memoryId: string, status: AgentMemoryStatus) => Promise<{ success: boolean; data?: AgentMemory; error?: string }>;
      bulkReviewMemories: (memoryIds: string[], status: AgentMemoryStatus) => Promise<{ success: boolean; data?: { updated: number }; error?: string }>;
      deleteMemory: (memoryId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;

      // Memory-backend browse/manage (active store: core default or plugin override).
      // Handlers return the backend result directly (it carries its own `success`),
      // or an { success:false, error } envelope if the call throws.
      memoryList: (params?: { pattern?: string; limit?: number; offset?: number }) => Promise<MemoryListResult | { success: false; error: string }>;
      memorySearch: (params: { query: string; limit?: number; tags?: string[] }) => Promise<MemorySearchResponse | { success: false; error: string }>;
      memoryRetrieve: (key: string) => Promise<MemoryRetrieveResult | { success: false; error: string }>;
      memoryStore: (params: { key: string; value: string; metadata?: Record<string, unknown> }) => Promise<MemoryStoreResult | { success: false; error: string }>;
      memoryDelete: (key: string) => Promise<MemoryDeleteResult | { success: false; error: string }>;
      memoryBlocksList: (agentId: string) => Promise<{ success: boolean; blocks?: Array<{ id: string; label: string; value: string; description: string | null; char_limit: number; read_only: number }>; error?: string }>;
      memoryBlockSet: (params: { agentId: string; label: string; value: string }) => Promise<{ success: boolean; block?: { label: string; value: string; char_limit: number }; error?: string }>;

      // Backups
      listBackups: () => Promise<{ success: boolean; snapshots?: BackupSnapshot[]; error?: string }>;
      createBackup: () => Promise<{ success: boolean; snapshot?: BackupSnapshot; error?: string }>;
      deleteBackup: (filename: string) => Promise<{ success: boolean; error?: string }>;
      restoreBackup: (filename: string) => Promise<{ success: boolean; error?: string }>;

      // App
      listActiveWork: () => Promise<{ success: boolean; work?: Array<{ id: string; kind: string; agentId?: string; agentName?: string; containerId?: string; label?: string; startedAt: number; cancellable: boolean }>; error?: string }>;
      cancelActiveWork: (id: string) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
      platform: NodeJS.Platform;
      setTitleBarOverlay: (colors: { color: string; symbolColor: string }) => Promise<{ applied: boolean }>;

      // Window view controls (View menu). Zoom returns the resulting state so the
      // menu can render the current percentage and disable at the clamp.
      zoomIn: () => Promise<ZoomLevelState>;
      zoomOut: () => Promise<ZoomLevelState>;
      resetZoom: () => Promise<ZoomLevelState>;
      getZoom: () => Promise<ZoomLevelState>;
      toggleFullscreen: () => Promise<{ fullscreen: boolean }>;
      isFullscreen: () => Promise<{ fullscreen: boolean }>;
      toggleDevTools: () => Promise<{ open: boolean }>;
      /** Caption buttons — Linux runs frameless and draws its own. */
      minimizeWindow: () => Promise<{ success: boolean }>;
      /** Resulting state arrives via onMaximizeChanged — the WM applies it asynchronously. */
      toggleMaximizeWindow: () => Promise<{ success: boolean }>;
      isWindowMaximized: () => Promise<{ maximized: boolean }>;
      closeWindow: () => Promise<{ success: boolean }>;
      onMaximizeChanged: (callback: (state: { maximized: boolean }) => void) => (() => void);
      /** Commands chosen from the native macOS menu. Returns an unsubscribe fn. */
      onMenuCommand: (
        callback: (payload: { commandId: string; dynamicId?: string; checked?: boolean }) => void,
      ) => (() => void);
      /** Pushes checkbox / dynamic-submenu state so the native menu can redraw. */
      syncMenuState: (state: {
        checkboxes?: Record<string, boolean>;
        dynamic?: Record<string, Array<{ id: string; label: string; checked?: boolean }>>;
      }) => Promise<{ success: boolean }>;
      getAppVersion: () => Promise<{ version: string }>;
      openExternal: (url: string) => Promise<{ success: boolean }>;
      getDataDir: () => Promise<{ path: string; appDataPath: string }>;
      openDataDir: () => Promise<{ success: boolean }>;
      quitApp: () => Promise<{ success: boolean }>;
      getModelCapabilities: (params: { provider: string; modelId: string }) => Promise<{
        temperature: boolean; topP: boolean; stopSequences: boolean;
        rawPrompt: boolean; maxOutputTokens: boolean; toolUse: boolean;
      }>;
      detectModelContext: (params: { provider: string; modelId: string }) => Promise<{
        contextWindow: number; maxContextLength?: number; loadedContextLength?: number;
        source: 'lmstudio-api' | 'ollama-api';
      } | null>;
      getToolInventory: () => Promise<import('../shared/toolCatalog').ToolInventoryEntry[]>;

      // Messaging Bridges
      getMessagingBridges: () => Promise<{ success: boolean; bridges?: Array<{ platform: string; running: boolean; sessionCount: number; botUsername?: string; connectedAt?: number; lastInboundAt?: number; lastError?: { message: string; at: number } }> }>;
      startMessagingBridge: (platform: string) => Promise<{ success: boolean; error?: string }>;
      stopMessagingBridge: (platform: string) => Promise<{ success: boolean; error?: string }>;
      getMessagingBridgeConfig: (platform: string) => Promise<{ success: boolean; hasConfig?: boolean; allowedUserIds?: string[]; autoStart?: boolean }>;
      setMessagingBridgeConfig: (params: { platform: string; token: string; allowedUserIds: string[]; autoStart?: boolean; keepExistingToken?: boolean }) => Promise<{ success: boolean; error?: string }>;
      testMessagingBridgeConnection: (platform: string) => Promise<{ success: boolean; ok?: boolean; botUsername?: string; error?: string }>;
      deleteMessagingBridgeConfig: (platform: string) => Promise<{ success: boolean; error?: string }>;
      getMessagingBridgeSessions: (platform: string) => Promise<{ success: boolean; sessions?: Array<{ platform: string; externalUserId: string; currentChatId: string | null; currentAgentId: string | null; lastActiveAt: number }> }>;

      // LAN sync
      syncGetState: () => Promise<{ success: boolean; state?: import('../shared/ipc-types').SyncStateSnapshot; error?: string }>;
      syncSetEnabled: (enabled: boolean) => Promise<{ success: boolean; state?: import('../shared/ipc-types').SyncStateSnapshot; error?: string }>;
      syncSetDeviceName: (name: string) => Promise<{ success: boolean; error?: string }>;
      syncSetPairingMode: (active: boolean) => Promise<{ success: boolean; error?: string }>;
      syncConfirmPair: () => Promise<{ success: boolean; error?: string }>;
      syncRejectPair: () => Promise<{ success: boolean; error?: string }>;
      syncConnect: (host: string, port: number) => Promise<{ success: boolean; error?: string }>;
      syncUnpair: (deviceId: string) => Promise<{ success: boolean; error?: string }>;

      // Auto-updater
      updaterGetState: () => Promise<{ status: string; info?: { version?: string }; progress?: { percent?: number }; error?: string }>;
      updaterCheck: () => Promise<{ status: string; info?: { version?: string }; progress?: { percent?: number }; error?: string }>;
      updaterDownload: () => Promise<{ success: boolean; error?: string }>;
      updaterQuitAndInstall: () => Promise<{ success: boolean }>;
      onUpdaterState: (callback: (state: { status: string; info?: { version?: string }; progress?: { percent?: number }; error?: string }) => void) => (() => void);

      // Tray navigation
      onTrayNavigate: (callback: (view: 'chats' | 'channels' | 'settings') => void) => (() => void);

      // Generic event listeners for plugins and custom events.
      // The handler's argument tuple is inferred from the callback, so typed
      // call sites (e.g. `({ pluginId }) => ...`) check without a cast. The
      // preload forwards the IPC payload args verbatim to the callback.
      on: <Args extends unknown[] = unknown[]>(channel: string, callback: (...args: Args) => void) => (() => void);
      off: <Args extends unknown[] = unknown[]>(channel: string, callback: (...args: Args) => void) => void;
      once: <Args extends unknown[] = unknown[]>(channel: string, callback: (...args: Args) => void) => void;
    };
  }
}

export {};
