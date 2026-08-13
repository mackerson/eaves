/**
 * Shared type definitions used across main and renderer processes
 */

import type { ProviderId } from './providers';

export interface ToolCall {
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  status: 'running' | 'completed' | 'error';
}

export interface ImageMetadata {
  alt?: string;
  width?: number;
  height?: number;
  caption?: string;
}

export interface ToolApprovalState {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decisionAt?: number;
  decidedBy?: string;
  reason?: string;
}

export type ContentBlock =
  | { type: 'text'; content: string; timestamp?: number }
  | { type: 'tool-call'; toolCall: ToolCall; timestamp?: number }
  | { type: 'tool-approval'; approval: ToolApprovalState; timestamp?: number }
  | { type: 'code'; language: string; code: string; filename?: string; metadata?: { execution?: boolean; execution_output?: boolean }; timestamp?: number }
  | { type: 'image'; url: string; alt?: string; width?: number; height?: number; metadata?: ImageMetadata; timestamp?: number }
  | { type: 'file'; filename: string; mimeType: string; size: number; url?: string; fileId?: string; timestamp?: number }
  | { type: 'thinking'; content: string; timestamp?: number }
  | { type: 'system'; content: string; metadata?: { browsing?: boolean; error?: boolean; reasoningText?: boolean; reasoning_summary?: boolean; custom_instructions?: boolean; label?: string; result?: unknown }; timestamp?: number };

export interface RequestInfo {
  contextWindow: number;
  sizeClass: 'tiny' | 'small' | 'medium' | 'large';
  systemPromptTokens: number;
  messageBudget: number;
  messagesTotal: number;     // total messages before windowing
  messagesSent: number;      // messages after windowing
  toolsIncluded: boolean;
  toolCount: number;         // number of tools sent (0 if stripped)
  systemPrompt?: string;     // full system prompt text (only when agent.debugLogging is enabled)
}

export interface MessageMetrics {
  // Per-turn token accounting: input = prompt/context sent to the model,
  // output = generated.
  //
  // This is the *persistable* shape, and it no longer relies on anyone
  // remembering to keep three files in step: `MessageMetricsObjectSchema` in
  // validation.ts is pinned to it by a compile-time equality check there, and
  // `StreamMetrics` extends it. Adding a field here and nowhere else is a
  // build error, not a silent strip on the renderer save path.
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  timeToComplete?: number;  // milliseconds
  finishReason?: string;  // 'stop' | 'length' | 'error' | 'tool_use' etc
  model?: string;
  cost?: number;  // USD cost for this message (null for local models)
  requestInfo?: RequestInfo;  // context budget and request composition details
  // OpenRouter only: the upstream backend that actually served this turn
  // (e.g. 'GMICloud'), read from providerMetadata.openrouter. Drives
  // sticky-provider pinning (next turn prefers this backend for cache reuse)
  // and the warm/cold indicator. cachedTokens > 0 means the pin kept the
  // prompt cache warm.
  servedProvider?: string;
  cachedTokens?: number;
  /**
   * Tokens written to the prompt cache this turn, billed at a premium once and
   * read back cheaply after. Without it a row cannot distinguish a cache that
   * paid for itself from one that only ever paid the write — the exact
   * question a short unattended routine raises.
   */
  cacheWriteTokens?: number;
}

export interface BaseMessage {
  id: string;
  senderId: string;
  senderDisplayName: string;
  senderColor?: string;
  metadata?: Record<string, any>;
  metrics?: MessageMetrics;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  contentBlocks?: ContentBlock[];
  /**
   * The AI SDK's `result.response.messages` — the model-shaped record of this
   * turn's assistant + tool messages, and the source of truth for next-turn
   * history. ContentBlocks remain the source of truth for the renderer; these
   * two shapes are intentionally not isomorphic. Optional because persisted
   * rows may not carry it, so replay must tolerate its absence.
   */
  responseMessages?: unknown[];
  parentMessageId?: string;
  branchIndex?: number;
  status?: 'active' | 'archived' | 'regenerated';
  /**
   * Total siblings (including this row, including archived ones) under the
   * same parent_message_id. Hydrated by the repository when loading messages
   * for the renderer; >1 means a regenerate carousel should appear.
   */
  branchCount?: number;
}

export interface Message extends BaseMessage {
  channelId: string;
  senderType: 'human' | 'agent' | 'system';
  isDraft?: boolean;
}

export interface MessageAttachment {
  id: string;
  messageId: string;
  filename: string;
  originalPath?: string;  // Original path from import/upload
  storedPath: string;  // Path in Enclave storage
  mimeType: string;
  size: number;
  attachmentType: 'file' | 'image' | 'audio' | 'video';
  metadata?: Record<string, any>;
  createdAt: number;
}

export interface Participant {
  id: string;
  type: 'human' | 'agent';
  displayName: string;
  color?: string;
  joinedAt: number;
}

export interface Channel {
  id: string;
  name: string;
  /** 'work' is a delegated work session — one agent, one task (docs/architecture/work-sessions.md). */
  type: 'public' | 'project' | 'direct' | 'work';
  projectId?: string;
  participants: Participant[];
  messages: Message[];
  createdAt: number;
  pinned?: boolean;
  /** Flat conversation-folder membership; null/undefined = ungrouped. */
  folderId?: string;
  /** Free-form labels, available on every channel type; undefined = no tags. */
  tags?: string[];
  /** Epoch ms when the channel was archived; undefined = active. */
  archivedAt?: number;
}

/** Flat grouping for conversations (chats + channels) in the list panel. */
export interface ConversationFolder {
  id: string;
  projectId?: string;
  name: string;
  position: number;
  createdAt: number;
}

export interface Chat {
  id: string;
  name: string;
  agentId: string;
  participants: Participant[];
  messages: ChatMessage[];
  createdAt: number;
  archivedAt?: number;
  tags?: string;
  lastMessageAt?: number;
  pinned?: boolean;
  /** Flat conversation-folder membership; null/undefined = ungrouped. */
  folderId?: string;
  /**
   * Per-chat user persona for roleplay agents. Only meaningful when the
   * chat's agent has `archetype.type === 'roleplay'`. Surfaced via a gear
   * icon in the chat header and injected into the system prompt by
   * buildRoleplayNote so the agent knows who the user is playing.
   */
  userPersona?: string;
}

export interface ChatMessage extends BaseMessage {
  chatId: string;
  senderType: 'human' | 'agent';
}

export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  /** Owning project. Optional only because older callers build Task literals without it. */
  projectId?: string;
  content: string;
  completed: boolean;
  color: NoteColor;           // Background color (reuses note colors)
  priority: TaskPriority;     // Priority level
  labels: string[];           // User-assigned labels
  sortOrder: number;          // Position for drag-drop ordering
  dueDate?: number;           // Unix timestamp
  startDate?: number;         // Unix timestamp
  estimatedDuration?: number; // Minutes
  eventId?: string;           // Optional link to ScheduleEvent
  createdAt: number;
  updatedAt: number;
}

// Note color palette (Google Keep style)
export type NoteColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple';

// AI-generated metadata for notes
export interface NoteAIMetadata {
  summary?: string;           // 1-2 sentence summary
  topics?: string[];          // Extracted topics (3-5)
  type?: 'idea' | 'todo' | 'reference' | 'meeting-notes' | 'journal';
  generatedAt?: number;       // Timestamp of generation
}

// Project-level label for organizing notes
export interface NoteLabel {
  id: string;
  name: string;
  color: string;
}

export interface Note {
  id: string;
  content: string;
  title?: string;             // Optional explicit title
  color: NoteColor;           // Background color
  pinned: boolean;            // Pin to top
  labels: string[];           // User-assigned labels
  sortOrder: number;          // Position for drag-drop ordering
  eventId?: string;           // Optional link to ScheduleEvent (for meeting notes, etc.)
  aiMetadata?: NoteAIMetadata; // AI-generated metadata
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEvent {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  start: number;  // Unix timestamp
  end: number;    // Unix timestamp
  type: 'event' | 'milestone' | 'deadline';
  createdAt: number;
}

// Schedule event interface
export interface ScheduleEvent {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  startTime: number;  // Unix timestamp
  endTime?: number;   // Unix timestamp (optional for all-day events)
  location?: string;
  isAllDay: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  targetDate: number;  // Unix timestamp
  status: 'upcoming' | 'achieved' | 'missed';
  createdAt: number;
  updatedAt: number;
}

export type DeadlinePriority = 'low' | 'medium' | 'high' | 'critical';

export interface Deadline {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  dueDate: number;  // Unix timestamp
  priority: DeadlinePriority;
  isHard: boolean;  // true = hard deadline, false = soft deadline
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface DAGDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  dagDefinition: DAGDefinition;
  enabled: boolean;
  /** Surfaced in the sidebar's Workflows section, like pinned conversations. */
  pinned: boolean;
  /**
   * Gate that blocks execution of AI-authored workflows until a human approves.
   * Defaults to `approved` for user-authored workflows, `pending` for agent-authored.
   */
  reviewStatus: 'pending' | 'approved';
  createdBy: 'user' | 'agent';
  safetyConfig?: WorkflowSafetyConfig;  // Safety limits for workflow execution
  createdAt: number;
  updatedAt: number;
}

/**
 * Safety configuration for workflow execution
 * Prevents infinite loops and runaway execution
 */
export interface WorkflowSafetyConfig {
  maxExecutionTime?: number;     // Total workflow timeout in milliseconds (default: 120000 / 2 min)
  maxNodesExecuted?: number;      // Max total nodes that can be executed (default: 1000)
  maxLoopIterations?: number;     // Default max iterations per loop (default: 10)
  maxLoopDepth?: number;          // Max nesting level for loops (default: 3)
}

/**
 * HTTP request node configuration
 */
export interface HttpNodeData {
  label: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Code execution node configuration.
 * Supports JS/Python/Shell via the subprocess CodeExecutor.
 */
export interface CodeNodeData {
  label?: string;
  language?: 'javascript' | 'python' | 'shell';
  code: string;
  timeout?: number; // milliseconds (default 30000, floored at 1000)
}

/**
 * Conditional branching node configuration
 */
export interface ConditionalNodeData {
  label: string;
  condition: string;
  operator?: 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan';
  value?: string;
}

/**
 * Delay/timer node configuration
 */
export interface DelayNodeData {
  label: string;
  duration?: number;
  unit?: 'seconds' | 'minutes' | 'hours';
}

/**
 * Loop node configuration
 */
export interface LoopNodeData {
  label: string;
  collection: string;             // Path to array in context (e.g., "$searchResults")
  variable: string;               // Variable name for current item (e.g., "item")
  maxIterations?: number;         // Override default max iterations for this loop
  breakCondition?: string;        // Optional condition to exit early (accepted by the schema, not implemented)
  collectResults?: boolean;       // Whether to collect iteration results (default: true)
}

/**
 * Break node configuration (for early loop exit)
 */
export interface BreakNodeData {
  label: string;
  condition: string;              // Condition expression (e.g., "score > 0.8")
}

/**
 * Web scraper node configuration
 */
export interface WebScraperNodeData {
  label: string;
  url: string;                    // URL to scrape (supports variables)
  selector?: string;              // Optional CSS selector for content
  timeout?: number;               // Request timeout in ms (default: 10000)
}

/**
 * Agent/LLM prompt node configuration
 */
export interface AgentNodeData {
  label?: string;                 // Display name; absent on agent-authored nodes
  agentId?: string;               // Target agent ID (empty = system default model)
  prompt: string;                 // User prompt (supports ${variable} interpolation)
  systemPromptOverride?: string;  // Override agent's system prompt (optional)
  temperature?: number;           // Override temperature (optional)
  /**
   * Output cap for this node, under either of two spellings. `maxTokens` is
   * the name the create_workflow tool documents and the only one agent-authored
   * graphs carry; `maxOutputTokens` is the alternate spelling stored graphs may
   * carry. Both are read — see WorkflowExecutor.executeAgentNode — so a graph
   * written with either spelling keeps its cap.
   */
  maxTokens?: number;
  maxOutputTokens?: number;
}

export interface Routine {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  workflowId?: string;  // Optional workflow to execute
  cronSchedule: string;  // Cron expression (e.g., "0 9 * * *")
  enabled: boolean;
  pinned: boolean;
  lastRun?: number;  // Unix timestamp
  nextRun?: number;  // Unix timestamp
  /** Outcome of the last run. Undefined until the routine has run once. */
  /** Only set when the routine actually ran; a skipped run leaves it untouched. */
  lastStatus?: 'success' | 'failure';
  lastError?: string;
  /** Reset to 0 on any success. Drives the "failing" badge. */
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface File {
  id: string;
  projectId: string;
  name: string;
  path: string;  // Absolute filesystem path
  type: 'file' | 'directory' | 'repository';
  size?: number;  // Bytes
  mimeType?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MCPServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  enabled: boolean;
  config: {
    // For stdio
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    // For sse/http
    url?: string;
  };
}

// Advanced message formatting for instruction-tuned models
export interface MessageSequence {
  prefix: string;  // e.g., "<|start_header_id|>{{name}}<|end_header_id|>"
  suffix: string;  // e.g., "<|eot_id|>"
}

export interface InstructTemplate {
  name: string; // Template name (e.g., "Llama-3-Instruct")
  activationRegex?: string; // Auto-detect model (e.g., "/llama(-)?(3|3.1)/i")
  wrapSequencesWithNewline?: boolean;
  replaceMacroInSequences?: boolean;
  includeNames?: 'always' | 'never' | 'auto';
  userMessageSequence?: MessageSequence;
  assistantMessageSequence?: MessageSequence;
  systemMessageSequence?: MessageSequence;
  systemPromptSequence?: MessageSequence; // For initial system prompt
  stopSequence?: MessageSequence;
  separatorSequence?: string; // Between messages
  exampleSeparator?: string; // Between few-shot examples
}

export interface ContextFormatting {
  storyString?: string; // Custom context template with variables
  alwaysAddCharacterName?: boolean;
  generateOneLinePerRequest?: boolean;
  collapseConsecutiveNewlines?: boolean;
  trimSpaces?: boolean;
  trimIncompleteSentences?: boolean;
  separatorsAsStopStrings?: boolean;
  namesAsStopStrings?: boolean;
  allowPostHistoryInstructions?: boolean;
}

export type AgentMemoryType = 'conversation' | 'external' | 'reflection';
export type AgentMemoryStatus = 'candidate' | 'approved' | 'rejected' | 'expired';

export interface AgentMemory {
  id: string;
  agentId: string;
  content: string;
  memoryType: AgentMemoryType;
  status: AgentMemoryStatus;
  sourceContext?: string;
  confidence?: number;
  reviewedAt?: number;
  expiresAt?: number;
  createdAt: number;
}

export interface ChannelBehavior {
  respondTo: 'mentions-only' | 'all';       // When to respond in channels (default: mentions-only)
  verbosity: 'brief' | 'normal' | 'verbose'; // How verbose in channels (default: brief)
}

/** The default when an agent has no channelBehavior set. */
export const DEFAULT_CHANNEL_BEHAVIOR: ChannelBehavior = {
  respondTo: 'mentions-only',
  verbosity: 'brief',
};

/**
 * Stored archetype id. Behavior/metadata for each id — labels, icons,
 * conditional fields, grant presets — lives in the archetype registry
 * (`src/shared/archetypes.ts`), which is the single source the editor renders.
 * The ids here match the string literals the behavior seams key off
 * (`ShadowService`, `buildRoleplayNote`), so the registry is additive.
 */
export type ArchetypeType =
  | 'task-oriented'
  | 'exploratory'
  | 'autonomous'
  | 'shadow'
  | 'custom'
  | 'roleplay';

export interface AgentArchetype {
  type: ArchetypeType;
  leadAgentId?: string; // For shadow agents: the agent this shadow monitors
  allowScheduling?: boolean; // Can schedule actions across time
  allowSelfModification?: boolean; // Can request changes to own config
  allowGoalSetting?: boolean; // Can set long-term goals
  enableReflection?: boolean; // Periodic self-reflection
  autonomyLevel?: 'low' | 'medium' | 'high'; // Level of autonomous action
}

export interface Agent {
  id: string;
  name: string;
  description: string; // Short description for UI
  systemPrompt?: string; // Full system prompt / personality / instructions (defaults to description if not set)
  /**
   * Optional template that wraps the systemPrompt with structural context
   * (project, participants, tools, etc.) via {{variable}} substitution.
   * When unset, buildSystemPrompt falls back to the hardcoded tier scaffolding.
   * See DEFAULT_PROMPT_TEMPLATE + PROMPT_TEMPLATE_VARIABLES in shared/promptTemplate.
   */
  promptTemplate?: string;
  greeting?: string; // Optional opening message — when a new 1:1 chat is created with this agent, the greeting is posted as the agent's first message. Mirrors the character-card "first message" / first_mes field.
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama' | 'lmstudio';
  model: string;
  temperature: number;
  topP?: number; // Nucleus sampling. Capability-gated — only sent to the SDK when ModelCapabilities.topP is true.
  maxOutputTokens?: number; // Maximum output tokens (optional, defaults per provider)
  maxSteps?: number; // Maximum tool call rounds (optional, defaults to 10)
  contextWindow?: number; // Override context window size (tokens) — useful for local models with non-standard sizes
  mcpServers: MCPServer[];
  color: string; // Visual identifier in UI
  avatar?: string; // Path to avatar image file
  createdAt: number;

  // Tool management
  defaultTools?: string[]; // Tools enabled by default for this agent (in addition to discovery API)
  /**
   * Which tools' schemas are registered with the model each request:
   * - 'all': every available tool. Lets the model enable a tool and call it
   *   within the same turn, but pays the full schema token bill (~hundreds–
   *   thousands of tokens) on every request.
   * - 'enabled': only the session-enabled subset + the discovery tools. Cheap;
   *   a newly enabled tool becomes callable on the next turn rather than the
   *   same one.
   * Undefined defaults by provider (see resolveToolSendMode): 'enabled' for
   * local endpoints with tight context budgets, 'all' for cloud models.
   */
  toolSendMode?: 'all' | 'enabled';
  /**
   * History compaction behavior. 'auto' (default/undefined) summarizes aged
   * turns when the conversation exceeds the message budget; 'off' disables it
   * (falls back to plain windowing); 'manual' compacts only when the user
   * explicitly triggers it. Long-running, memory-heavy agents want 'auto';
   * users who want oversight of what gets summarized set 'off' or 'manual'.
   */
  compactionMode?: 'auto' | 'manual' | 'off';

  // Advanced formatting for instruction-tuned models (primarily for local/Ollama models)
  instructTemplate?: InstructTemplate;
  stoppingStrings?: string[]; // Custom stop sequences (JSON array)
  contextVariables?: Record<string, string>; // Mustache-style variables: {{var}}
  contextFormatting?: ContextFormatting;

  // Cost tracking (optional overrides for custom/local endpoints)
  promptCostPer1M?: number;      // USD per 1M prompt tokens (overrides built-in pricing table)
  completionCostPer1M?: number;  // USD per 1M completion tokens

  // Debug
  debugLogging?: boolean; // When true, stores the full system prompt with each message for inspection

  // Channel behavior
  channelBehavior?: ChannelBehavior;

  // Agent archetype (shadow, autonomous, etc.)
  archetype?: AgentArchetype;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  directory?: string; // Filesystem path for project files; may be unset, so file-backed features must handle its absence
  tasks: Task[];
  notes: Note[];
  events: CalendarEvent[];
  files: string[];
  createdAt: number;
}

export interface User {
  id: string;
  name: string;
  color: string;
  isCurrent: boolean;
  createdAt: number;
}

export type BackgroundType = 'none' | 'local' | 'url' | 'gradient';

export interface BackgroundSettings {
  type: BackgroundType;
  value: string; // file path, URL, or CSS gradient
  opacity: number; // 0.0 - 1.0
  blur: number; // 0 - 20 pixels
  fromTheme?: boolean; // true if background was set by theme (not user override)
}

export interface Settings {
  userName: string;
  // Bare filename resolved against userData/avatars by the avatar:// protocol,
  // same convention as Agent.avatar.
  userAvatar?: string;
  // Keyed by provider id from src/shared/providers.ts — the registry is the
  // source of truth for which providers exist.
  //
  // Credential values are main-process-only. Everything crossing to the
  // renderer goes through redactSettingsForRenderer, which drops them and
  // leaves `configuredProviders` in their place; endpoint URLs for local
  // providers (isLocalEndpoint) survive, since those aren't secrets and the
  // user has to be able to edit them.
  apiKeys: Partial<Record<ProviderId, string>>;
  /**
   * Providers with a credential or endpoint on file, as seen by the renderer.
   * Present only on the redacted projection — the main process reads apiKeys
   * directly and never populates this.
   */
  configuredProviders?: ProviderId[];
  currentUserId?: string;
  currentChatId?: string;
  defaultAgentId?: string; // Default agent for new chats
  /**
   * Agent used for background/utility work — chat title generation, note
   * metadata, workflow agent-node fallback, and other non-interactive tasks.
   * Lets the user pin a cheap fast model (Haiku, a local model) for housekeeping
   * without affecting their chat-facing agents. Falls back to `defaultAgentId`
   * then first-available when unset.
   */
  systemAgentId?: string;
  theme?: string; // Current theme ID (e.g., 'dark', 'dracula', 'nord')
  lightTheme?: string; // User's preferred light theme for quick toggle (default: 'light')
  darkTheme?: string; // User's preferred dark theme for quick toggle (default: 'dark')
  background?: BackgroundSettings; // Background image/gradient settings
  oobeCompleted?: boolean; // Whether the out-of-box experience wizard has been completed
  /**
   * When true (default), OpenRouter conversations prefer the upstream backend
   * that served the previous turn, keeping the prompt cache warm across the
   * conversation. Off restores OpenRouter's default per-turn (cost-optimal)
   * routing. No effect on non-OpenRouter agents.
   */
  openrouterStickyProvider?: boolean;
  /** Semantic memory search config — which embedder feeds the core backend's
   *  hybrid (FTS + vector) search. Off ⇒ FTS-only. See `services/embeddings.ts`. */
  memoryEmbedding?: { enabled: boolean; provider: string; model: string };
  /**
   * When true (default), agent-authored workflows are created in `pending` review state
   * and require explicit human approval before they can execute. Turning this off lets
   * agents run their own generated code with no prompt — use with extreme caution.
   */
  workflowReviewRequired?: boolean;
  /**
   * Global scheduler pause. Persisted so a restart cannot silently resume every
   * routine while the user still believes they are paused.
   */
  routinesPaused?: boolean;
  /**
   * Controls how in-app updates are handled:
   * - 'auto' (default): periodic checks + banner + manual check.
   * - 'manual': no periodic check; manual "Check for Updates" still works.
   * - 'external': updater fully disabled. For users whose system package
   *   manager owns the binary (AUR, Homebrew, apt, etc.).
   */
  updateMode?: UpdateMode;
  /**
   * Reading/accessibility font preference. Resolution order is user preference
   * > theme fonts > system stack: 'default' clears the override so a theme's
   * optional fonts (ThemeDefinition.fonts) show through; 'open-dyslexic' uses
   * the bundled OpenDyslexic faces; 'custom' uses customFontFamily, which must
   * name a locally installed font (e.g. a licensed Dyslexie install) and fails
   * open to the system stack when missing.
   */
  fontFamily?: FontPreference;
  customFontFamily?: string;
  /** Multiplier on the --font-size-* tokens (and rem sizes via html). 1 = default. */
  fontScale?: number;
  /** Multiplier on the --line-height-* tokens. 1 = default. */
  lineSpacing?: number;
}

export type FontPreference = 'default' | 'open-dyslexic' | 'custom';

export type UpdateMode = 'auto' | 'manual' | 'external';

export interface AppState {
  settings: Settings;
  users: User[];
  agents: Agent[];
  projects: Project[];
  channels: Channel[];
  currentProjectId: string | null;
  currentAgentId: string | null;
  currentChannelId: string | null;
  currentUserId: string | null;
}

export interface CurrentState {
  currentProjectId: string | null;
  currentAgentId: string | null;
  currentChannelId: string | null;
}

export interface PluginConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    default?: any;
    description?: string;
  };
}

/**
 * Service capability declaration
 * Describes what a plugin provides via the service registry
 */
export interface PluginServiceCapability {
  version?: string;
  operations?: string[]; // e.g., ['store', 'retrieve', 'search']
  features?: string[]; // e.g., ['metadata', 'filtering', 'wildcards']
  [key: string]: any; // Allow additional metadata
}

/**
 * Service requirement declaration
 * Describes what services a plugin needs from others
 */
export interface PluginServiceRequirement {
  serviceType: string;
  optional?: boolean; // If true, plugin can function without this service
  minVersion?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  type: 'ui' | 'mcp' | 'hybrid' | 'tool' | 'import' | 'terminal';
  entry?: string; // Entry point file, defaults to 'index.js'
  icon?: string; // Unicode emoji or icon name
  permissions?: PluginPermission[];
  dependencies?: string[];
  config?: PluginConfigSchema; // Configuration schema
  ui?: PluginUIMetadata; // UI bundle metadata for dynamic loading

  // Service Registry fields
  capabilities?: string[]; // Service types this plugin provides (e.g., ['memory-backend'])
  provides?: Record<string, PluginServiceCapability>; // Detailed capability info
  requires?: PluginServiceRequirement[]; // Services this plugin needs

  // Sandbox configuration
  sandboxVersion?: number; // Sandbox RPC protocol the plugin targets; PluginManifestSchema caps it to the versions this build implements
  sandbox?: boolean; // Whether to run in sandbox (default: true for sandboxVersion >= 1)

  // Runtime fields (added by PluginManager, not stored in plugin.json)
  path?: string; // Full path to plugin directory
  source?: 'bundled' | 'user'; // Where the plugin was loaded from
  folderName?: string; // Plugin folder name
}

/**
 * Plugin UI bundle metadata
 * Describes the frontend components for dynamic loading
 */
export interface PluginUIMetadata {
  entry: string; // Path to the UI bundle file (relative to plugin directory)
  components: Record<string, 'default' | 'named'>; // componentName -> export type
}

/**
 * Plugin permissions for sandboxed plugins
 * Granular permissions provide fine-grained control over plugin access
 */
export type PluginPermission =
  // Data read access (granular)
  | 'data:agents:read'
  | 'data:projects:read'
  | 'data:channels:read'
  | 'data:chats:read'
  | 'data:settings:read'
  // Data write access (granular)
  | 'data:tasks:write'
  | 'data:notes:write'
  | 'data:messages:write'
  | 'data:chats:write'
  | 'data:agents:write'
  // UI capabilities
  | 'ui:views:register'
  | 'ui:notifications:show'
  // Event system
  | 'events:listen'
  | 'events:emit'
  // Tools & Services
  | 'tools:register'
  | 'services:register'
  | 'services:call'
  // Storage
  | 'storage:read'
  | 'storage:write'
  // Dangerous (require explicit grant)
  | 'network:http'
  | 'system:filesystem'
  // Coarse-grained aliases. Accepted so manifests that declare them still
  // validate and load; no grant check keys off them — the sandbox matches only
  // the granular ids above, so a plugin asking for these gets nothing.
  | 'data:read'
  | 'data:write'
  | 'ui:register'
  | 'storage:access'
  | 'network:access';

// =================================================================
// Memory Backend Service Types
// Standard interface for memory storage plugins
// =================================================================

export interface MemoryMetadata {
  tags?: string[];
  description?: string;
  importance?: number; // 0-1, higher = more important
  source?: string;
  storedAt?: number;
  updatedAt?: number;
  [key: string]: any; // Allow custom metadata
}

/**
 * A memory entry stored in the backend
 */
export interface MemoryEntry {
  key: string;
  value: string;
  metadata?: MemoryMetadata;
}

export interface MemoryStoreParams {
  key: string;
  value: string;
  metadata?: MemoryMetadata;
}

export interface MemoryStoreResult {
  success: boolean;
  key: string;
  message?: string;
  storedAt?: number;
}

export interface MemoryRetrieveResult {
  success: boolean;
  key: string;
  value?: string;
  metadata?: MemoryMetadata;
  message?: string;
}

export interface MemorySearchParams {
  query: string;
  limit?: number;
  minSimilarity?: number; // For semantic search backends
  tags?: string[]; // Filter by tags
}

export interface MemorySearchResult {
  key: string;
  value: string;
  metadata?: MemoryMetadata;
  score?: number; // Similarity/relevance score
  matchedOn?: string; // What matched: 'key', 'value', 'semantic'
}

export interface MemorySearchResponse {
  success: boolean;
  query: string;
  count: number;
  results: MemorySearchResult[];
  message?: string;
}

export interface MemoryListResult {
  success: boolean;
  count: number;
  keys: string[];
  memories?: MemoryEntry[];
  total?: number;
}

export interface MemoryDeleteResult {
  success: boolean;
  key: string;
  message?: string;
}

/**
 * Standard Memory Backend API
 *
 * All memory plugins should implement this interface and register
 * as a 'memory-backend' service. This enables:
 * - Memory processors to work with any backend
 * - Users to switch backends without changing workflows
 * - Memory aggregation across backends
 *
 * @example
 * context.services.register('memory-backend', {
 *   store: async (params) => { ... },
 *   retrieve: async (key) => { ... },
 *   search: async (params) => { ... },
 *   list: async (pattern) => { ... },
 *   delete: async (key) => { ... },
 * }, {
 *   version: '1.0',
 *   features: ['metadata', 'search', 'semantic'],
 * });
 */
export interface MemoryBackendAPI {
  /**
   * Store a memory with optional metadata
   */
  store(params: MemoryStoreParams): Promise<MemoryStoreResult>;

  retrieve(key: string): Promise<MemoryRetrieveResult>;

  /**
   * Search memories by query
   * Backends may implement text search, semantic search, or both
   */
  search(params: MemorySearchParams): Promise<MemorySearchResponse>;

  /**
   * List all memories, optionally filtered by pattern
   * Pattern supports * wildcards (e.g., "user_*")
   * `options` (limit/offset) is honored by backends that support paging (the
   * core default does); plugin backends may ignore it. `total` in the result
   * reflects the full match count so callers can page.
   */
  list(pattern?: string, options?: { limit?: number; offset?: number }): Promise<MemoryListResult>;

  delete(key: string): Promise<MemoryDeleteResult>;

  /**
   * Optional: Get backend health/stats
   */
  health?(): Promise<{ connected: boolean; status: string; [key: string]: any }>;
}

// =================================================================
// Memory Processor Service Types
// Interface for plugins that extract/transform memories from conversations
// =================================================================

/**
 * A memory extracted from a conversation
 */
export interface ExtractedMemory {
  key: string;
  value: string;
  metadata: MemoryMetadata & {
    source: 'conversation' | 'user' | 'agent' | 'system';
    chatId?: string;
    messageId?: string;
    extractedAt: number;
    confidence?: number; // 0-1, how confident the processor is in this extraction
  };
}

/**
 * Context provided to memory processors for extraction
 */
export interface MemoryExtractionContext {
  chatId: string;
  agentId: string;
  agentName: string;
  userName?: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
  existingMemories?: MemoryEntry[]; // For deduplication
}

/**
 * Result from processing a conversation for memories
 */
export interface MemoryProcessingResult {
  success: boolean;
  extracted: ExtractedMemory[];
  stored: number; // How many were actually stored (after deduplication)
  skipped: number; // How many were skipped (duplicates, low confidence, etc.)
  errors?: string[];
}

/**
 * Memory Processor API
 *
 * Plugins that extract memories from conversations implement this interface
 * and register as a 'memory-processor' service.
 *
 * @example
 * context.services.register('memory-processor', {
 *   process: async (ctx) => { ... },
 *   extractFromMessage: async (message, ctx) => { ... },
 * }, {
 *   version: '1.0',
 *   strategy: 'simple', // or 'entity-centric', 'semantic-clustering'
 * });
 */
export interface MemoryProcessorAPI {
  /**
   * Process a full conversation and extract memories
   */
  process(context: MemoryExtractionContext): Promise<MemoryProcessingResult>;

  /**
   * Extract memories from a single message (for real-time processing)
   */
  extractFromMessage?(
    message: { role: 'user' | 'assistant'; content: string; id: string },
    context: Omit<MemoryExtractionContext, 'messages'>
  ): Promise<ExtractedMemory[]>;

  /**
   * Get processor stats/health
   */
  getStats?(): Promise<{
    processedCount: number;
    extractedCount: number;
    storedCount: number;
    lastProcessedAt?: number;
  }>;
}

// =================================================================
// Activity Types
// =================================================================

// 'user' = workspace activity worth surfacing in the feed/badge;
// 'system' = app-lifecycle telemetry (loads, registrations), hidden by default
export type ActivityAudience = 'user' | 'system';

export interface Activity {
  id: string;
  type: string;
  category: string;
  source: string;
  audience: ActivityAudience;
  data?: unknown;
  projectId?: string;
  /** The agent that caused this, when a single one did. Often absent. */
  agentId?: string;
  timestamp: number;
  createdAt: number;
}

export interface ActivityFilter {
  types?: string[];
  categories?: string[];
  sources?: string[];
  audience?: ActivityAudience;
  projectId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

// =================================================================
// Theme Types
// =================================================================

export interface ThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  bgInput: string;
  bgModal: string;
  bgOverlay: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  textInverse: string;
  accentPrimary: string;
  accentSecondary: string;
  accentHover: string;
  accentActive: string;
  statusSuccess?: string;
  statusWarning?: string;
  statusError?: string;
  statusInfo?: string;
  borderPrimary: string;
  borderSecondary: string;
}

export interface ThemeBackground {
  type: 'gradient' | 'url';
  value: string;
  defaultOpacity?: number;
  defaultBlur?: number;
  locked?: boolean;
}

export interface ThemeTransparency {
  sidebar?: number;
  mainContent?: number;
  uiBlur?: number;
}

export type ThemeIconSet = 'emoji' | 'pixelart';

/**
 * Optional per-theme font stacks. These are a *suggestion* layer: they apply
 * only while the theme is active and are overridden by the user's font
 * preference in Settings (Settings.fontFamily), which is applied as an inline
 * style on the document root and therefore always wins.
 */
export interface ThemeFonts {
  /** CSS font-family value for --font-sans (UI + message text). */
  sans?: string;
  /** CSS font-family value for --font-mono (code). */
  mono?: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  category: string;
  isDark: boolean;
  colors: ThemeColors;
  fonts?: ThemeFonts;
  background?: ThemeBackground;
  transparency?: ThemeTransparency;
  iconSet?: ThemeIconSet;
  isUserTheme?: boolean;
  filePath?: string;
}

// ─── Backups ────────────────────────────────────────────────────────────────

export type SnapshotReason = 'startup' | 'periodic' | 'manual' | 'pre-restore';

export interface BackupSnapshot {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: number;
  reason: SnapshotReason;
}
