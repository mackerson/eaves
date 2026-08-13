import { z } from 'zod/v3';
import type { MessageMetrics, RequestInfo } from './types';

/**
 * Validation schemas for user inputs
 * Using Zod for runtime type checking and validation
 */

// Agent validation schemas
export const AgentNameSchema = z.string()
  .trim()
  .min(1, 'Agent name is required')
  .max(100, 'Agent name must be less than 100 characters');

export const AgentDescriptionSchema = z.string()
  .trim()
  .min(1, 'Agent description is required')
  .max(500, 'Agent description must be less than 500 characters');

export const AgentProviderSchema = z.enum(['anthropic', 'openai', 'google', 'openrouter', 'ollama', 'lmstudio']);

export const AgentModelSchema = z.string()
  .trim()
  .min(1, 'Model is required');

export const AgentTemperatureSchema = z.number()
  .min(0, 'Temperature must be between 0 and 2')
  .max(2, 'Temperature must be between 0 and 2');

export const AgentColorSchema = z.string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid color format (must be hex color)');

export const TopPSchema = z.number()
  .min(0, 'top_p must be between 0 and 1')
  .max(1, 'top_p must be between 0 and 1');

// Project validation schemas
export const ProjectNameSchema = z.string()
  .trim()
  .min(1, 'Project name is required')
  .max(100, 'Project name must be less than 100 characters');

export const ProjectDescriptionSchema = z.string()
  .trim()
  .max(500, 'Project description must be less than 500 characters')
  .optional()
  .default('');

export const CreateProjectSchema = z.object({
  name: ProjectNameSchema,
  description: ProjectDescriptionSchema,
});

export const UpdateProjectSchema = z.object({
  name: ProjectNameSchema.optional(),
  description: ProjectDescriptionSchema.optional(),
});

// Channel validation schemas
export const ChannelNameSchema = z.string()
  .trim()
  .min(1, 'Channel name is required')
  .max(100, 'Channel name must be less than 100 characters');

export const ChannelTypeSchema = z.enum(['public', 'project', 'direct', 'work']);

/**
 * What a caller may ask to be created. 'work' is deliberately absent: a work
 * session is only valid with a task bound to it, so it is minted by the
 * service that knows about tasks, never by the generic create-channel IPC.
 */
export const CreatableChannelTypeSchema = z.enum(['public', 'project', 'direct']);

/** A single channel tag. Every channel type can carry tags, direct ones included. */
export const ChannelTagSchema = z.string().trim().min(1).max(50);

export const CreateChannelSchema = z.object({
  name: ChannelNameSchema,
  type: CreatableChannelTypeSchema.optional().default('public'),
});

export const UpdateChannelSchema = z.object({
  name: ChannelNameSchema.optional(),
  pinned: z.boolean().optional(),
  // Full replacement of the channel's tag list; null (or []) clears it.
  tags: z.array(ChannelTagSchema).max(50).nullable().optional(),
});

// Message validation schemas
export const MessageContentSchema = z.string()
  .trim()
  .min(1, 'Message cannot be empty')
  .max(50000, 'Message is too long (max 50000 characters)');

// Settings validation schemas
export const UserNameSchema = z.string()
  .trim()
  .min(1, 'User name is required')
  .max(50, 'User name must be less than 50 characters');

// A single provider's API key in an apiKeys patch. An empty string is a
// deliberate "clear this key" — SettingsRepository treats ''/undefined as a
// delete. Do NOT add .min(1) here: because apiKeys is a z.record, one invalid
// value fails the whole record, which would block saving every other provider
// whenever any key field is left blank.
export const ApiKeySchema = z.string()
  .trim()
  .optional();

export const BackgroundSettingsSchema = z.object({
  type: z.enum(['none', 'local', 'url', 'gradient']),
  value: z.string().max(2000),
  opacity: z.number().min(0).max(1),
  blur: z.number().min(0).max(20),
  fromTheme: z.boolean().optional(),
});

export const UpdateSettingsSchema = z.object({
  userName: UserNameSchema.optional(),
  // Bare avatar filename; empty string clears it.
  userAvatar: z.string().max(500).optional(),
  // Keyed by provider id (see src/shared/providers.ts). A record so adding a
  // new provider doesn't silently lose its key to Zod's object-stripping —
  // SettingsRepository filters to known ids at write time.
  apiKeys: z.record(z.string(), ApiKeySchema).optional(),
  theme: z.string().max(100).optional(),
  lightTheme: z.string().max(100).optional(),
  darkTheme: z.string().max(100).optional(),
  background: BackgroundSettingsSchema.optional(),
  currentChatId: z.string().max(100).optional(),
  defaultAgentId: z.string().max(100).optional(),
  systemAgentId: z.string().max(100).optional(),
  oobeCompleted: z.boolean().optional(),
  workflowReviewRequired: z.boolean().optional(),
  routinesPaused: z.boolean().optional(),
  updateMode: z.enum(['auto', 'manual', 'external']).optional(),
  openrouterStickyProvider: z.boolean().optional(),
  memoryEmbedding: z.object({
    enabled: z.boolean(),
    provider: z.string().max(50),
    model: z.string().max(200),
  }).optional(),
  fontFamily: z.enum(['default', 'open-dyslexic', 'custom']).optional(),
  // Interpolated into a CSS font-family value — restrict to characters a
  // family name can actually contain so it can't smuggle CSS syntax.
  customFontFamily: z.string().trim().max(100)
    .regex(/^[A-Za-z0-9 _-]*$/, 'Font name may only contain letters, numbers, spaces, hyphens, and underscores')
    .optional(),
  fontScale: z.number().min(0.8).max(1.5).optional(),
  lineSpacing: z.number().min(1).max(1.5).optional(),
});

// MCP Server validation schemas
export const MCPServerNameSchema = z.string()
  .trim()
  .min(1, 'Server name is required')
  .max(100, 'Server name must be less than 100 characters');

export const MCPServerTransportSchema = z.enum(['stdio', 'sse', 'http']);

export const MCPServerCommandSchema = z.string()
  .trim()
  .min(1, 'Command is required for stdio transport');

export const MCPServerUrlSchema = z.string()
  .trim()
  .url('Must be a valid URL')
  .min(1, 'URL is required for SSE/HTTP transport');

export const CreateMCPServerSchema = z.object({
  name: MCPServerNameSchema,
  transport: MCPServerTransportSchema,
  enabled: z.boolean().default(true),
  command: z.string().optional(),
  args: z.string().optional(),
  url: z.string().optional(),
}).refine((data) => {
  // Validate that stdio servers have command
  if (data.transport === 'stdio') {
    return !!data.command && data.command.trim().length > 0;
  }
  // Validate that SSE/HTTP servers have URL
  if (data.transport === 'sse' || data.transport === 'http') {
    return !!data.url && z.string().url().safeParse(data.url).success;
  }
  return true;
}, {
  message: 'Invalid configuration for selected transport type',
});

// Task validation schemas
export const TaskContentSchema = z.string()
  .trim()
  .min(1, 'Task cannot be empty')
  .max(500, 'Task must be less than 500 characters');

// Note validation schemas
export const NoteContentSchema = z.string()
  .trim()
  .min(1, 'Note cannot be empty')
  .max(10000, 'Note must be less than 10000 characters');

export const NoteTitleSchema = z.string()
  .trim()
  .max(200, 'Title must be less than 200 characters')
  .optional();

export const NoteColorSchema = z.enum([
  'default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'
]);

export const NoteLabelSchema = z.string()
  .trim()
  .min(1, 'Label cannot be empty')
  .max(50, 'Label must be less than 50 characters');

export const CreateNoteSchema = z.object({
  content: NoteContentSchema,
  title: NoteTitleSchema,
  color: NoteColorSchema.optional().default('default'),
  pinned: z.boolean().optional().default(false),
  labels: z.array(NoteLabelSchema).optional().default([]),
});

export const UpdateNoteSchema = z.object({
  content: NoteContentSchema.optional(),
  title: NoteTitleSchema,
  color: NoteColorSchema.optional(),
  pinned: z.boolean().optional(),
  labels: z.array(NoteLabelSchema).optional(),
});

// User validation schemas
export const CreateUserSchema = z.object({
  name: UserNameSchema,
  color: AgentColorSchema.optional().default('#667eea'),
});

// Event validation schemas
export const EventTitleSchema = z.string()
  .trim()
  .min(1, 'Event title is required')
  .max(200, 'Event title must be less than 200 characters');

export const EventDescriptionSchema = z.string()
  .trim()
  .max(1000, 'Event description must be less than 1000 characters')
  .optional();

export const EventLocationSchema = z.string()
  .trim()
  .max(200, 'Location must be less than 200 characters')
  .optional();

export const EventTimestampSchema = z.number()
  .int('Timestamp must be an integer')
  .positive('Timestamp must be positive');

export const CreateEventSchema = z.object({
  projectId: z.string().min(1, 'Project ID is required'),
  title: EventTitleSchema,
  description: EventDescriptionSchema,
  startTime: EventTimestampSchema,
  endTime: EventTimestampSchema.optional(),
  location: EventLocationSchema,
  isAllDay: z.boolean().default(false),
}).refine((data) => {
  // Validate that if endTime is provided, it's after startTime
  if (data.endTime !== undefined) {
    return data.endTime > data.startTime;
  }
  return true;
}, {
  message: 'End time must be after start time',
  path: ['endTime'],
});

export const UpdateEventSchema = z.object({
  title: EventTitleSchema.optional(),
  description: EventDescriptionSchema,
  startTime: EventTimestampSchema.optional(),
  endTime: EventTimestampSchema.optional(),
  location: EventLocationSchema,
  isAllDay: z.boolean().optional(),
}).refine((data) => {
  // Validate that if both times are provided, endTime is after startTime
  if (data.startTime !== undefined && data.endTime !== undefined) {
    return data.endTime > data.startTime;
  }
  return true;
}, {
  message: 'End time must be after start time',
  path: ['endTime'],
});

// Milestone validation schemas
export const MilestoneTitleSchema = z.string()
  .trim()
  .min(1, 'Milestone title is required')
  .max(200, 'Milestone title must be less than 200 characters');

export const MilestoneDescriptionSchema = z.string()
  .trim()
  .max(1000, 'Milestone description must be less than 1000 characters')
  .optional();

export const MilestoneStatusSchema = z.enum(['upcoming', 'achieved', 'missed']);

export const CreateMilestoneSchema = z.object({
  projectId: z.string().min(1, 'Project ID is required'),
  title: MilestoneTitleSchema,
  description: MilestoneDescriptionSchema,
  targetDate: EventTimestampSchema,
  status: MilestoneStatusSchema.default('upcoming'),
});

export const UpdateMilestoneSchema = z.object({
  title: MilestoneTitleSchema.optional(),
  description: MilestoneDescriptionSchema,
  targetDate: EventTimestampSchema.optional(),
  status: MilestoneStatusSchema.optional(),
});

// Deadline validation schemas
export const DeadlineTitleSchema = z.string()
  .trim()
  .min(1, 'Deadline title is required')
  .max(200, 'Deadline title must be less than 200 characters');

export const DeadlineDescriptionSchema = z.string()
  .trim()
  .max(1000, 'Deadline description must be less than 1000 characters')
  .optional();

export const DeadlinePrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const CreateDeadlineSchema = z.object({
  projectId: z.string().min(1, 'Project ID is required'),
  title: DeadlineTitleSchema,
  description: DeadlineDescriptionSchema,
  dueDate: EventTimestampSchema,
  priority: DeadlinePrioritySchema.default('medium'),
  isHard: z.boolean().default(true),
});

export const UpdateDeadlineSchema = z.object({
  title: DeadlineTitleSchema.optional(),
  description: DeadlineDescriptionSchema,
  dueDate: EventTimestampSchema.optional(),
  priority: DeadlinePrioritySchema.optional(),
  isHard: z.boolean().optional(),
});

// Plugin manifest validation schemas
export const PluginIdSchema = z.string()
  .trim()
  .min(1, 'Plugin ID is required')
  .max(100, 'Plugin ID must be less than 100 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Plugin ID must contain only letters, numbers, dots, underscores, and hyphens');

export const PluginNameSchema = z.string()
  .trim()
  .min(1, 'Plugin name is required')
  .max(100, 'Plugin name must be less than 100 characters');

export const PluginVersionSchema = z.string()
  .trim()
  .min(1, 'Plugin version is required')
  .regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'Plugin version must be in semver format (e.g., 1.0.0)');

export const PluginTypeSchema = z.enum(['ui', 'mcp', 'hybrid', 'tool', 'import', 'terminal']);

/**
 * Granular plugin permissions for sandboxed plugins
 * These provide fine-grained control over what plugins can access
 */
export const PluginPermissionSchema = z.enum([
  // Data read access (granular)
  'data:agents:read',
  'data:projects:read',
  'data:channels:read',
  'data:chats:read',
  'data:settings:read',
  // Data write access (granular)
  'data:tasks:write',
  'data:notes:write',
  'data:messages:write',
  'data:chats:write',
  'data:agents:write',
  // UI capabilities
  'ui:views:register',
  'ui:notifications:show',
  // Event system
  'events:listen',
  'events:emit',
  // Tools & Services
  'tools:register',
  'services:register',
  'services:call',
  // Storage
  'storage:read',
  'storage:write',
  // Dangerous (require explicit grant)
  'network:http',
  'system:filesystem',
  // Coarse-grained aliases. Accepted so manifests that declare them still
  // validate and load; no grant check keys off them — only the granular ids
  // above are matched, so requesting these grants nothing.
  'data:read',
  'data:write',
  'ui:register',
  'storage:access',
  'network:access'
]);

export const PluginEntrySchema = z.string()
  .trim()
  .min(1, 'Entry point is required')
  // Prevent path traversal in entry point
  .refine((val) => !val.includes('..'), 'Entry point cannot contain path traversal (..)');

export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: PluginNameSchema,
  version: PluginVersionSchema,
  description: z.string().max(500).optional(),
  author: z.string().max(100).optional(),
  type: PluginTypeSchema,
  entry: PluginEntrySchema.optional(),
  icon: z.string().max(50).optional(),
  permissions: z.array(PluginPermissionSchema).optional(),
  dependencies: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
  ui: z.object({
    entry: z.string().min(1),
    components: z.record(z.enum(['default', 'named']))
  }).optional(),
  capabilities: z.array(z.string()).optional(),
  provides: z.record(z.unknown()).optional(),
  requires: z.array(z.union([
    z.string(),
    z.object({
      serviceType: z.string(),
      optional: z.boolean().optional(),
      minVersion: z.string().optional(),
    }),
  ])).optional(),
  // Sandbox configuration
  sandboxVersion: z.number().int().min(1).max(1).optional(), // Bounded to the protocol versions this build implements — a plugin targeting an unimplemented one must fail to load, not load half-wired
  sandbox: z.boolean().optional(), // Whether to run in sandbox (default: true for sandboxVersion >= 1)
});

// ============================================================================
// IPC Validation Schemas
// Runtime validation for IPC handlers in main process
// ============================================================================

// Common ID/Entity schemas
export const EntityIdSchema = z.string()
  .min(1, 'ID is required')
  .max(100, 'ID is too long');

// Snapshot filenames are emitted by BackupService and round-tripped through
// the renderer. This is defense in depth — the service re-validates against
// the same pattern when acting on the filename, so an IPC bypass still can't
// reach `../../etc/passwd` style paths.
export const BackupFilenameSchema = z.string()
  .regex(
    /^enclave-\d{8}T\d{9}Z-(startup|periodic|manual|pre-restore)(?:-\d+)?\.db$/,
    'Invalid backup filename',
  );

// ── LAN sync ────────────────────────────────────────────────────────────
export const SyncDeviceNameSchema = z.string()
  .trim()
  .min(1, 'Device name is required')
  .max(64, 'Device name is too long');

export const SyncDeviceIdSchema = z.string()
  .regex(/^[0-9a-f]{32}$/, 'Invalid device id');

export const SyncConnectSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
});

// Agent archetype schema
export const AgentArchetypeSchema = z.object({
  type: z.enum(['task-oriented', 'exploratory', 'autonomous', 'shadow', 'custom', 'roleplay']),
  leadAgentId: z.string().max(100).optional(),
  allowScheduling: z.boolean().optional(),
  allowSelfModification: z.boolean().optional(),
  allowGoalSetting: z.boolean().optional(),
  enableReflection: z.boolean().optional(),
  autonomyLevel: z.enum(['low', 'medium', 'high']).optional(),
});

// Channel behavior schema — how an agent acts in multi-participant channels.
export const ChannelBehaviorSchema = z.object({
  respondTo: z.enum(['mentions-only', 'all']),
  verbosity: z.enum(['brief', 'normal', 'verbose']),
});

// Memory review schemas
export const MemoryStatusSchema = z.enum(['approved', 'rejected', 'expired']);

export const ReviewMemorySchema = z.object({
  memoryId: EntityIdSchema,
  status: MemoryStatusSchema,
});

export const BulkReviewMemoriesSchema = z.object({
  memoryIds: z.array(EntityIdSchema).min(1).max(100),
  status: MemoryStatusSchema,
});

// Memory-backend browse/manage IPC (renderer → active memory-backend service).
export const MemoryBackendKeySchema = z.string().min(1, 'key is required').max(1024, 'key too long');
export const MemoryBackendListSchema = z.object({
  pattern: z.string().max(1024).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
export const MemoryBackendSearchSchema = z.object({
  query: z.string().min(1, 'query is required').max(2048),
  limit: z.number().int().positive().max(200).optional(),
  tags: z.array(z.string().max(128)).max(50).optional(),
});
export const MemoryBackendStoreSchema = z.object({
  key: MemoryBackendKeySchema,
  value: z.string().max(1_000_000, 'value too large'),
  metadata: z.record(z.any()).optional(),
});

// Core-memory blocks (agent-scoped, always-in-context editable summaries).
export const MemoryBlockSetSchema = z.object({
  agentId: EntityIdSchema,
  label: z.string().trim().min(1, 'label is required').max(64, 'label too long'),
  value: z.string().max(20000, 'value too large'),
});

// Extended Agent IPC schemas (for full create/update with all fields)
export const CreateAgentIPCSchema = z.object({
  name: AgentNameSchema,
  // The agent editor labels this as a "Short Description" with no required
  // marker — letting validation reject empty values caused saves to silently
  // fail (the renderer swallowed the {success:false} envelope and showed a
  // misleading success toast). Treat blank as empty string; the repo stores
  // it as ''. The 500-char cap is still enforced for non-empty input.
  description: z.string().trim().max(500, 'Agent description must be less than 500 characters').optional().default(''),
  systemPrompt: z.string().max(50000, 'System prompt is too long').optional(),
  // `.nullable()`: the editor sends explicit null when the user clears the
  // textarea, so the column is actually cleared instead of being skipped.
  promptTemplate: z.string().max(20000, 'Prompt template is too long').nullable().optional(),
  greeting: z.string().max(20000, 'Greeting is too long').optional(),
  provider: AgentProviderSchema,
  model: AgentModelSchema,
  temperature: AgentTemperatureSchema.optional().default(0.7),
  topP: z.number().min(0, 'top_p must be between 0 and 1').max(1, 'top_p must be between 0 and 1').optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().max(50, 'Max steps cannot exceed 50').optional(),
  // Nullable so clearing the input wipes the override (rather than being a
  // no-op skip in buildUpdateFields). `.positive()` still rejects 0 with a
  // clear error if the user types it.
  contextWindow: z.number().int().positive().nullable().optional(),
  toolSendMode: z.enum(['all', 'enabled']).nullable().optional(),
  compactionMode: z.enum(['auto', 'manual', 'off']).nullable().optional(),
  debugLogging: z.boolean().optional(),
  color: AgentColorSchema.optional().default('#667eea'),
  avatar: z.string().max(500).optional(),
  defaultTools: z.array(z.string()).optional(),
  // Advanced formatting for instruction-tuned / local models
  instructTemplate: z.object({
    name: z.string().max(100),
    activationRegex: z.string().max(200).optional(),
    wrapSequencesWithNewline: z.boolean().optional(),
    replaceMacroInSequences: z.boolean().optional(),
    includeNames: z.enum(['always', 'never', 'auto']).optional(),
    userMessageSequence: z.object({ prefix: z.string(), suffix: z.string() }).optional(),
    assistantMessageSequence: z.object({ prefix: z.string(), suffix: z.string() }).optional(),
    systemMessageSequence: z.object({ prefix: z.string(), suffix: z.string() }).optional(),
    systemPromptSequence: z.object({ prefix: z.string(), suffix: z.string() }).optional(),
    stopSequence: z.object({ prefix: z.string(), suffix: z.string() }).optional(),
    separatorSequence: z.string().optional(),
    exampleSeparator: z.string().optional(),
  }).optional(),
  stoppingStrings: z.array(z.string().max(200)).max(20).optional(),
  contextVariables: z.record(z.string().max(100), z.string().max(5000)).optional(),
  contextFormatting: z.object({
    storyString: z.string().max(10000).optional(),
    alwaysAddCharacterName: z.boolean().optional(),
    generateOneLinePerRequest: z.boolean().optional(),
    collapseConsecutiveNewlines: z.boolean().optional(),
    trimSpaces: z.boolean().optional(),
    trimIncompleteSentences: z.boolean().optional(),
    separatorsAsStopStrings: z.boolean().optional(),
    namesAsStopStrings: z.boolean().optional(),
    allowPostHistoryInstructions: z.boolean().optional(),
  }).optional(),
  // Cost tracking
  promptCostPer1M: z.number().min(0).optional(),
  completionCostPer1M: z.number().min(0).optional(),
  archetype: AgentArchetypeSchema.optional().nullable(),
  channelBehavior: ChannelBehaviorSchema.optional(),
});

export const UpdateAgentIPCSchema = CreateAgentIPCSchema.partial();

// MCP Server IPC schemas
export const MCPServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url('Must be a valid URL').optional(),
});

export const AddMCPServerSchema = z.object({
  name: MCPServerNameSchema,
  transport: MCPServerTransportSchema,
  enabled: z.boolean().default(true),
  config: MCPServerConfigSchema,
}).refine((data) => {
  if (data.transport === 'stdio') {
    return !!data.config.command && data.config.command.trim().length > 0;
  }
  if (data.transport === 'sse' || data.transport === 'http') {
    return !!data.config.url;
  }
  return true;
}, {
  message: 'Invalid configuration for selected transport type',
});

export const UpdateMCPServerSchema = z.object({
  name: MCPServerNameSchema.optional(),
  enabled: z.boolean().optional(),
  config: MCPServerConfigSchema.partial().optional(),
});

// Workflow IPC schemas
export const WorkflowNodeSchema = z.object({
  id: EntityIdSchema,
  type: z.string().min(1, 'Node type is required'),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
  data: z.record(z.unknown()),
});

export const WorkflowEdgeSchema = z.object({
  id: EntityIdSchema,
  source: EntityIdSchema,
  target: EntityIdSchema,
  sourceHandle: z.string().optional().nullable(),
  targetHandle: z.string().optional().nullable(),
});

export const DAGDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
});

export const CreateWorkflowSchema = z.object({
  projectId: EntityIdSchema,
  name: z.string().min(1, 'Workflow name is required').max(100, 'Workflow name is too long'),
  description: z.string().max(500).optional(),
  dagDefinition: DAGDefinitionSchema,
  enabled: z.boolean().default(true),
  // Passed through from the trusted UI, which approves user-authored workflows
  // inline. Without these the fields are stripped and the caller silently falls
  // back to the repository default (fail-closed 'pending'), which would make
  // every user-created workflow non-running until manually approved.
  reviewStatus: z.enum(['pending', 'approved']).optional(),
  createdBy: z.enum(['user', 'agent']).optional(),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  dagDefinition: DAGDefinitionSchema.optional(),
  enabled: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

export const HttpRequestSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
});

export const ExecuteWorkflowSchema = z.object({
  workflowId: EntityIdSchema,
  variables: z.record(z.unknown()).optional(),
});

// Channel/Message IPC schemas
export const ToolCallSchema = z.object({
  toolName: z.string(),
  args: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  status: z.enum(['running', 'completed', 'error']),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), content: z.string(), timestamp: z.number().optional() }),
  z.object({ type: z.literal('tool-call'), toolCall: ToolCallSchema, timestamp: z.number().optional() }),
  z.object({ type: z.literal('code'), language: z.string(), code: z.string(), filename: z.string().optional(), timestamp: z.number().optional() }),
  z.object({ type: z.literal('image'), url: z.string(), alt: z.string().optional(), width: z.number().optional(), height: z.number().optional(), metadata: z.record(z.unknown()).optional(), timestamp: z.number().optional() }),
  z.object({ type: z.literal('file'), filename: z.string(), mimeType: z.string(), size: z.number(), url: z.string().optional(), fileId: z.string().optional(), timestamp: z.number().optional() }),
  z.object({ type: z.literal('thinking'), content: z.string(), timestamp: z.number().optional() }),
  z.object({ type: z.literal('system'), content: z.string(), timestamp: z.number().optional() }),
]);

export const RequestInfoSchema = z.object({
  contextWindow: z.number().int().nonnegative(),
  sizeClass: z.enum(['tiny', 'small', 'medium', 'large']),
  systemPromptTokens: z.number().int().nonnegative(),
  messageBudget: z.number().int().nonnegative(),
  messagesTotal: z.number().int().nonnegative(),
  messagesSent: z.number().int().nonnegative(),
  toolsIncluded: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  systemPrompt: z.string().optional(),
});

/**
 * The persistable metrics shape.
 *
 * Zod strips unknown keys, so anything missing here is silently dropped from a
 * renderer-originated save (addAgentMessage / addChatAgentMessage /
 * updateMessageContentBlocks) while surviving on the main-process turn path —
 * a split that is invisible until someone compares two rows. `MessageMetrics`
 * in types.ts is pinned to this shape by a compile-time check at the bottom of
 * this file, and `StreamMetrics` extends `MessageMetrics`, so the three cannot
 * drift apart again without failing the build.
 */
export const MessageMetricsObjectSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  timeToComplete: z.number().nonnegative().optional(),
  finishReason: z.string().optional(),
  model: z.string().optional(),
  cost: z.number().optional(),
  // Context budget and request composition — what the UI shows as "what this
  // request cost". Omitting it here is what made a resumed or renderer-saved
  // turn lose its telemetry.
  requestInfo: RequestInfoSchema.optional(),
  // OpenRouter sticky-provider signals — preserved through the renderer save
  // path so the pin + warm/cold indicator survive round-trips.
  servedProvider: z.string().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  // Billed at a premium once, then read back cheaply. Needed to tell a cache
  // that paid for itself from one that only ever paid the write.
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});

export const MessageMetricsSchema = MessageMetricsObjectSchema.optional();

/**
 * Deciding several approvals from one turn together. The whole batch resumes
 * once, so the decisions must belong to the same conversation — enforced in
 * the service, which is the only place that can see the entries.
 */
export const RespondToApprovalsSchema = z.object({
  decisions: z.array(z.object({
    approvalId: z.string().min(1),
    approved: z.boolean(),
    reason: z.string().max(1000).optional(),
  })).min(1).max(50),
  context: z.enum(['chat', 'channel']).optional(),
  contextId: EntityIdSchema.optional(),
  agentId: EntityIdSchema.optional(),
  messageId: EntityIdSchema.optional(),
});

/** Per-conversation approval waivers. */
export const GrantToolApprovalSchema = z.object({
  containerId: EntityIdSchema,
  agentId: EntityIdSchema,
  toolName: z.string().min(1).max(100),
});

/** Work sessions (docs/architecture/work-sessions.md). */
export const StartWorkSessionSchema = z.object({
  taskId: EntityIdSchema,
  agentId: EntityIdSchema,
  parentChannelId: EntityIdSchema.optional(),
});

export const CreateChannelIPCSchema = z.object({
  name: ChannelNameSchema,
  type: CreatableChannelTypeSchema.optional().default('public'),
  projectId: EntityIdSchema.optional(),
});

export const SendMessageSchema = z.object({
  channelId: EntityIdSchema,
  content: MessageContentSchema,
  // Directs the send at one agent: its turn runs server-side and the
  // respondTo:'all' broadcast is suppressed for this message, so a 1:1 send
  // doesn't wake every other participant in the channel.
  agentId: EntityIdSchema.optional(),
  // File paths to attach — same shape as SendChatMessageSchema.attachments, so
  // both send surfaces accept attachments identically. Extension/size limits
  // are enforced in the handler via the shared ingest helper.
  attachments: z.array(z.string().min(1)).optional(),
});

// Channel listing/search options — archived channels are excluded unless
// asked for. Identical to the chat surface (get-chats / search-chats /
// get-chats-by-tags) because both project over the same channels table; keeping
// the option shapes aligned lets the chat handlers delegate straight through.
export const ListChannelsSchema = z.object({
  includeArchived: z.boolean().optional(),
}).optional();

export const SearchChannelsSchema = z.object({
  query: z.string().max(500),
  includeArchived: z.boolean().optional(),
});

export const GetChannelsByTagsSchema = z.object({
  tags: z.array(ChannelTagSchema),
  includeArchived: z.boolean().optional(),
});

/** User edit of an existing chat/channel message. */
export const EditMessageSchema = z.object({
  messageId: EntityIdSchema,
  content: MessageContentSchema,
});

/** Conversation pin/folder operations (chats and channels share the table). */
export const SetConversationPinnedSchema = z.object({
  conversationId: EntityIdSchema,
  pinned: z.boolean(),
});

export const ConversationFolderNameSchema = z.string().trim()
  .min(1, 'Folder name cannot be empty')
  .max(60, 'Folder name is too long (max 60 characters)');

export const SetConversationFolderSchema = z.object({
  conversationId: EntityIdSchema,
  folderId: EntityIdSchema.nullable(),
});

export const CreateConversationFolderSchema = z.object({
  name: ConversationFolderNameSchema,
  projectId: EntityIdSchema.optional(),
});

export const RenameConversationFolderSchema = z.object({
  folderId: EntityIdSchema,
  name: ConversationFolderNameSchema,
});

export const AddAgentMessageSchema = z.object({
  channelId: EntityIdSchema,
  agentId: EntityIdSchema,
  content: z.string().max(100000, 'Message content is too long'),
  toolCalls: z.array(ToolCallSchema).optional(),
  contentBlocks: z.array(ContentBlockSchema).optional(),
  metrics: MessageMetricsSchema,
  isDraft: z.boolean().optional(),
});

export const UpdateMessageContentBlocksSchema = z.object({
  messageId: EntityIdSchema,
  contentBlocks: z.array(ContentBlockSchema),
  content: z.string().optional(),
  isDraft: z.boolean().optional(),
  metrics: MessageMetricsSchema,
});

// Chat IPC schemas
export const ChatTagSchema = z.string().min(1).max(50);

export const CreateChatSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  agentId: EntityIdSchema,
  tags: z.string().max(500).optional(), // comma-separated tags string
});

export const UpdateChatSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  tags: z.string().max(500).optional(), // comma-separated tags string
  // Per-chat roleplay persona. Empty string clears the persona; absent
  // leaves it untouched. Bounded so a runaway paste doesn't blow up the
  // system prompt.
  userPersona: z.string().max(2000).optional(),
});

export const SearchChatsSchema = z.object({
  query: z.string().max(500),
  includeArchived: z.boolean().optional(),
});

export const GetChatsByTagsSchema = z.object({
  tags: z.array(ChatTagSchema),
  includeArchived: z.boolean().optional(),
});

export const SendChatMessageSchema = z.object({
  chatId: EntityIdSchema,
  content: z.string().max(50000, 'Message is too long (max 50000 characters)'),
  attachments: z.array(z.string().min(1)).optional(),
});

export const AddChatAgentMessageSchema = z.object({
  chatId: EntityIdSchema,
  agentId: EntityIdSchema,
  content: z.string().max(100000),
  toolCalls: z.array(ToolCallSchema).optional(),
  contentBlocks: z.array(ContentBlockSchema).optional(),
  metrics: MessageMetricsSchema,
});

export const ChatWithAgentSchema = z.object({
  chatId: EntityIdSchema,
  agentId: EntityIdSchema,
});

export const RegenerateChatMessageSchema = z.object({
  messageId: EntityIdSchema,
});

export const SwitchActiveBranchSchema = z.object({
  messageId: EntityIdSchema,
});

export const SwipeChatMessageBranchSchema = z.object({
  messageId: EntityIdSchema,
  direction: z.enum(['prev', 'next']),
});

export const GenerateChatMetadataSchema = z.object({
  chatId: EntityIdSchema,
  messages: z.array(z.object({
    senderType: z.enum(['human', 'agent']),
    content: z.string(),
  }).passthrough()),
});

export const ToggleChatToolSchema = z.object({
  chatId: EntityIdSchema,
  toolName: z.string().min(1).max(100),
  enabled: z.boolean(),
});

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];

export const ReplaceAttachmentFileSchema = z.object({
  assetPointer: z.string().min(1),
  filePath: z.string().min(1).refine(
    (p) => IMAGE_EXTENSIONS.includes(p.slice(p.lastIndexOf('.')).toLowerCase()),
    { message: 'File must have an image extension (.png, .jpg, .jpeg, .gif, .webp, .bmp, .svg, .ico)' }
  ),
  messageId: EntityIdSchema.optional(),
});

// Plugin IPC schemas
export const PluginEventSchema = z.object({
  event: z.string().min(1).max(100),
  data: z.unknown().optional(),
});

export const ExecutePluginToolSchema = z.object({
  pluginId: PluginIdSchema,
  toolName: z.string().min(1).max(100),
  args: z.record(z.unknown()),
});

export const SetPluginConfigSchema = z.object({
  pluginId: PluginIdSchema,
  config: z.record(z.unknown()),
});

// Service schemas
export const ServiceTypeSchema = z.string().min(1, 'Service type is required').max(100, 'Service type is too long');

export const CallServiceSchema = z.object({
  serviceType: ServiceTypeSchema,
  method: z.string().min(1).max(100),
  args: z.array(z.unknown()),
});

// Plugin toggle schema
export const TogglePluginSchema = z.object({
  pluginId: PluginIdSchema,
  enabled: z.boolean(),
});

// Event filter schema
export const EventFilterSchema = z.string().min(1).max(100);

// Routine IPC schemas
export const CreateRoutineSchema = z.object({
  projectId: EntityIdSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  workflowId: EntityIdSchema.optional(),
  cronSchedule: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
});

export const UpdateRoutineSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  pinned: z.boolean().optional(),
  description: z.string().max(500).optional(),
  workflowId: EntityIdSchema.optional(),
  cronSchedule: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
});

// Task IPC schemas (extended)
export const TaskPrioritySchema = z.enum(['low', 'medium', 'high']);

export const CreateTaskSchema = z.object({
  content: TaskContentSchema,
  color: NoteColorSchema.optional().default('default'),
  priority: TaskPrioritySchema.optional().default('medium'),
  labels: z.array(NoteLabelSchema).optional(),
  dueDate: z.number().int().positive().optional(),
  startDate: z.number().int().positive().optional(),
  estimatedDuration: z.number().int().positive().optional(),
  eventId: EntityIdSchema.optional(),
});

export const UpdateTaskSchema = z.object({
  content: TaskContentSchema.optional(),
  completed: z.boolean().optional(),
  color: NoteColorSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  labels: z.array(NoteLabelSchema).optional(),
  dueDate: z.number().int().positive().nullable().optional(),
  startDate: z.number().int().positive().nullable().optional(),
  estimatedDuration: z.number().int().positive().nullable().optional(),
  eventId: EntityIdSchema.nullable().optional(),
});

export const ReorderItemsSchema = z.array(z.object({
  id: EntityIdSchema,
  sortOrder: z.number().int(),
}));

// Terminal IPC schemas
export const CreateTerminalSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

export const ResizeTerminalSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

// File IPC schemas
export const AddFileSchema = z.object({
  projectId: EntityIdSchema,
  filePath: z.string().min(1),
});

export const AddMultipleFilesSchema = z.object({
  projectId: EntityIdSchema,
  filePaths: z.array(z.string().min(1)),
});

// Fetch models schema
export const FetchModelsSchema = z.object({
  provider: AgentProviderSchema,
  baseURL: z.string().url().optional(),
});

// OOBE validation schemas
export const ValidateApiKeySchema = z.object({
  provider: AgentProviderSchema,
  apiKey: z.string().trim().min(1, 'API key or endpoint is required'),
});

export const OOBEGenerateSchema = z.object({
  provider: AgentProviderSchema,
  model: AgentModelSchema,
  apiKey: z.string().trim().min(1, 'API key or endpoint is required'),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  systemPrompt: z.string().max(10000).optional(),
});

// Log IPC schemas
export const LogErrorSchema = z.object({
  message: z.string().min(1).max(10000),
  stack: z.string().max(50000).optional(),
  componentStack: z.string().max(50000).optional(),
  timestamp: z.number().int().positive().optional(),
});

// User update schema
export const UpdateUserSchema = z.object({
  name: UserNameSchema.optional(),
  color: AgentColorSchema.optional(),
});

// Calendar event schema (for events.ts - different from scheduling)
export const AddCalendarEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  type: z.enum(['event', 'milestone', 'deadline']),
});

export const UpdateCalendarEventSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
  type: z.enum(['event', 'milestone', 'deadline']).optional(),
});

// List options schemas
export const ListNotesOptionsSchema = z.object({
  projectId: EntityIdSchema.optional(),
  searchQuery: z.string().max(500).optional(),
  labelFilter: z.string().max(50).optional(),
  colorFilter: NoteColorSchema.optional(),
});

// Label schemas
export const CreateLabelSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().optional(),
});

// Background URL schema
export const BackgroundUrlSchema = z.string().url().max(2000);

// Cron expression schema
export const CronExpressionSchema = z.string().min(1).max(100);

// Update routine run times schema
export const UpdateRoutineRunTimesSchema = z.object({
  routineId: EntityIdSchema,
  lastRun: z.number().int().positive(),
  nextRun: z.number().int().positive(),
});

// Date range schema
export const DateRangeSchema = z.object({
  startTime: z.number().int().positive(),
  endTime: z.number().int().positive(),
  projectId: EntityIdSchema.optional(),
});

// Activity filter schema
export const ActivityAudienceSchema = z.enum(['user', 'system']);

export const ActivityFilterSchema = z.object({
  types: z.array(z.string().min(1).max(100)).optional(),
  categories: z.array(z.string().min(1).max(50)).optional(),
  sources: z.array(z.string().min(1).max(100)).optional(),
  audience: ActivityAudienceSchema.optional(),
  projectId: EntityIdSchema.optional(),
  startTime: z.number().int().positive().optional(),
  endTime: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});

// Timestamp schema for IPC handlers that accept a timestamp parameter
export const TimestampSchema = z.number().int().positive('Timestamp must be a positive integer');

// Dialog options schemas for file/directory picker IPC handlers
export const DialogFileOptionsSchema = z.object({
  title: z.string().max(200).optional(),
  filters: z.array(z.object({
    name: z.string(),
    extensions: z.array(z.string()),
  })).optional(),
}).optional();

export const DialogDirectoryOptionsSchema = z.object({
  title: z.string().max(200).optional(),
}).optional();

/**
 * Validation result types for better TypeScript narrowing
 */
export type ValidationSuccess<T> = { success: true; data: T };
export type ValidationFailure = { success: false; error: string };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/**
 * Type guard to check if validation failed
 */
export function isValidationFailure<T>(
  result: ValidationResult<T>
): result is ValidationFailure {
  return !result.success;
}

/**
 * Helper function to validate data and return user-friendly error messages
 */
export function validateWithSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): ValidationResult<T> {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  // Extract first error message for user-friendly feedback, prefixed with the
  // field path so a multi-field payload says *which* field failed ("maxSteps:
  // ..." instead of a bare "Number must be greater than 0").
  const firstError = result.error.errors[0];
  const path = firstError?.path?.join('.') ?? '';
  const message = firstError?.message || 'Validation failed';
  return {
    success: false,
    error: path ? `${path}: ${message}` : message,
  };
}

// ─── Metrics shape guard ─────────────────────────────────────────
//
// MessageMetrics (types.ts), MessageMetricsObjectSchema (here) and
// StreamMetrics (streamEventRouter.ts) describe one shape in three places.
// They drifted once: `requestInfo` was declared on the type but absent from
// the schema, so renderer-originated saves silently dropped it, while the
// main-process turn path kept it. `cacheWriteTokens` drifted the other way —
// collected and persisted in practice, declared on neither.
//
// These assertions make that a build failure. Add a field to one and the
// build tells you which of the others you forgot. StreamMetrics is pinned by
// extending MessageMetrics at its declaration.

type MetricsFromSchema = z.infer<typeof MessageMetricsObjectSchema>;

/** Compile error unless A and B have exactly the same keys. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? ([keyof B] extends [keyof A] ? true : { missingFromA: Exclude<keyof B, keyof A> })
  : { missingFromB: Exclude<keyof A, keyof B> };

const _metricsKeysAgree: SameKeys<MetricsFromSchema, MessageMetrics> = true;
const _requestInfoKeysAgree: SameKeys<z.infer<typeof RequestInfoSchema>, RequestInfo> = true;
void _metricsKeysAgree;
void _requestInfoKeysAgree;
