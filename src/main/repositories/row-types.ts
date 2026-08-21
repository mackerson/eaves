/**
 * Typed database row interfaces for repository queries.
 * These match the SQLite column shapes (snake_case) before mapping to domain types.
 */

// ============================================================================
// Core Entity Rows
// ============================================================================

export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  prompt_template: string | null;
  greeting: string | null;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  max_steps: number | null;
  context_window: number | null;
  debug_logging: number | null; // SQLite boolean
  color: string | null;
  avatar: string | null;
  default_tools: string | null; // JSON
  tool_send_mode: string | null; // 'all' | 'enabled' | null (provider default)
  compaction_mode: string | null; // 'auto' | 'manual' | 'off' | null (auto)
  instruct_template: string | null; // JSON
  stopping_strings: string | null; // JSON
  context_variables: string | null; // JSON
  context_formatting: string | null; // JSON
  prompt_cost_per_1m: number | null;
  completion_cost_per_1m: number | null;
  channel_behavior: string | null; // JSON
  archetype: string | null; // JSON
  created_at: number;
}

export interface ToolSessionStateRow {
  context_id: string;
  enabled_tools: string; // JSON array of tool names
  updated_at: number;
}

export interface MCPServerRow {
  id: string;
  name: string;
  transport: string;
  enabled: number; // SQLite boolean
  config_command: string | null;
  config_args: string | null; // JSON
  config_env: string | null; // JSON
  config_url: string | null;
}

export interface UserRow {
  id: string;
  name: string;
  color: string | null;
  is_current: number; // SQLite boolean
  created_at: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  directory: string | null;
  files: string | null; // JSON
  created_at: number;
}

export interface ChannelRow {
  id: string;
  name: string;
  type: string;
  project_id: string | null;
  created_at: number;
  pinned: number | null; // SQLite boolean
  folder_id: string | null; // conversation_folders.id
  task_id: string | null;          // work sessions: the task being worked (v71)
  parent_channel_id: string | null; // work sessions: where to report back (v71)
  // Chat-only columns: populated only on `type='direct'` (1:1 chat) rows,
  // NULL on group channels.
  agent_id: string | null;
  archived_at: number | null;
  last_message_at: number | null;
  tags: string | null;
  user_persona: string | null;
  // Compaction: running summary of aged-out turns + the newest message
  // already folded in.
  context_summary: string | null;
  summary_through_message_id: string | null;
  summary_updated_at: number | null;
}

export interface ChannelParticipantRow {
  participant_id: string;
  participant_type: string | null;
  display_name: string | null;
  color: string | null;
  joined_at: number;
}

export interface MessageRow {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: string;
  sender_display_name: string;
  sender_color: string | null;
  content: string;
  timestamp: number;
  tool_calls: string | null; // JSON
  content_blocks: string | null; // JSON (UI-shape, for renderer)
  response_messages_json: string | null; // JSON: AI SDK ResponseMessage[] (model-shape, for next-turn replay)
  metadata: string | null; // JSON
  metrics: string | null; // JSON
  parent_message_id: string | null;
  branch_index: number | null;
  status: string | null;
  is_draft: number | null; // SQLite boolean
  [key: string]: unknown; // Index signature for BaseRow compatibility
}

// ============================================================================
// Chat Rows
// ============================================================================

export interface ChatRow {
  id: string;
  name: string;
  agent_id: string;
  created_at: number;
  archived_at: number | null;
  tags: string | null;
  last_message_at: number | null;
  user_persona: string | null;
  pinned: number | null; // SQLite boolean
  folder_id: string | null; // conversation_folders.id
}

export interface ChatParticipantRow {
  participant_id: string;
  participant_type: string | null;
  display_name: string | null;
  color: string | null;
  joined_at: number;
}

// NOTE: there are no chat_* tables — a chat IS a `channels` row with
// type='direct', so ChannelRepository's chat projection reads `channels` /
// `messages` / `channel_participants`. The interfaces above and below describe
// that projected shape (a subset of the channel/message columns) and keep
// `channel_id` as the container key.
export interface ChatMessageRow {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: string;
  sender_display_name: string;
  sender_color: string | null;
  content: string;
  timestamp: number;
  tool_calls: string | null; // JSON
  content_blocks: string | null; // JSON (UI-shape)
  response_messages_json: string | null; // JSON: AI SDK ResponseMessage[]
  metadata: string | null; // JSON
  metrics: string | null; // JSON
  parent_message_id: string | null;
  branch_index: number | null;
  status: string | null;
  [key: string]: unknown; // Index signature for BaseRow compatibility
}

// ============================================================================
// Task / Note / Event Rows
// ============================================================================

export interface TaskRow {
  id: string;
  project_id: string;
  content: string;
  completed: number; // SQLite boolean
  color: string | null;
  priority: string | null;
  labels: string | null; // JSON
  sort_order: number | null;
  due_date: number | null;
  start_date: number | null;
  estimated_duration: number | null;
  event_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface NoteRow {
  id: string;
  project_id: string;
  content: string;
  title: string | null;
  color: string | null;
  pinned: number; // SQLite boolean
  labels: string | null; // JSON
  sort_order: number | null;
  event_id: string | null;
  ai_metadata: string | null; // JSON
  created_at: number;
  updated_at: number;
}

export interface NoteLabelRow {
  id: string;
  project_id: string;
  name: string;
  color: string | null;
  created_at: number;
}

export interface EventRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  start_time: number;
  end_time: number | null;
  type: string | null; // 'event' | 'milestone' | 'deadline'
  location: string | null;
  is_all_day: number | null; // SQLite boolean
  // Subtype fields, populated per `type`: status on milestones; priority +
  // is_hard on deadlines. NULL on plain events.
  status: string | null;
  priority: string | null;
  is_hard: number | null; // SQLite boolean
  created_at: number;
  updated_at: number | null;
}

// ============================================================================
// Other Entity Rows
// ============================================================================

export interface ActivityRow {
  id: string;
  type: string;
  category: string;
  source: string;
  audience: string;
  data: string | null; // JSON
  project_id: string | null;
  agent_id: string | null;
  timestamp: number;
  created_at: number;
}

export interface FileRow {
  id: string;
  project_id: string;
  name: string;
  path: string;
  type: string;
  size: number;
  mime_type: string | null;
  created_at: number;
  updated_at: number;
}

// No MilestoneRow / DeadlineRow: milestones and deadlines are `events` rows
// (see EventRow) selected by `type`, sharing one table and one row shape.

export interface WorkflowRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  dag_definition: string; // JSON
  enabled: number; // SQLite boolean
  pinned: number;
  review_status: 'pending' | 'approved';
  created_by: 'user' | 'agent';
  created_at: number;
  updated_at: number;
}

export interface RoutineRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  workflow_id: string;
  cron_schedule: string;
  enabled: number; // SQLite boolean
  last_run: number | null;
  next_run: number | null;
  pinned: number;
  last_status: 'success' | 'failure' | null;
  last_error: string | null;
  consecutive_failures: number;
  /** JSON `RoutineOutput`, or null when the routine delivers nowhere. */
  output: string | null;
  created_at: number;
  updated_at: number;
}

export interface SettingsRow {
  user_name: string | null;
  user_avatar: string | null;
  theme: string | null;
  light_theme: string | null;
  dark_theme: string | null;
  current_chat_id: string | null;
  default_agent_id: string | null;
  system_agent_id: string | null;
  background_type: string | null;
  background_value: string | null;
  background_opacity: number | null;
  background_blur: number | null;
  oobe_completed: number | null;
  workflow_review_required: number | null;
  routines_paused: number | null;
  update_mode: string | null;
  api_keys_json: string | null;
  openrouter_sticky_provider: number | null;
  memory_embedding: string | null;
  usage_settings: string | null;
  font_family: string | null;
  custom_font_family: string | null;
  font_scale: number | null;
  line_spacing: number | null;
}

export interface CurrentStateRow {
  current_project_id: string | null;
  current_agent_id: string | null;
  current_channel_id: string | null;
  current_chat_id: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  original_path: string | null;
  stored_path: string;
  mime_type: string;
  size: number;
  attachment_type: string;
  metadata: string | null; // JSON
  created_at: number;
}

export interface PluginStorageRow {
  key: string;
  value: string; // JSON
}

export interface PluginStateRow {
  plugin_id: string;
  enabled: number; // SQLite boolean
}

export interface PluginGrantRow {
  plugin_id: string;
  permissions: string; // JSON array of granted permission strings
  version: string | null;
  consented_at: number;
}

export interface AgentMemoryRow {
  id: string;
  agent_id: string;
  content: string;
  memory_type: string;
  status: string;
  source_context: string | null;
  confidence: number | null;
  reviewed_at: number | null;
  expires_at: number | null;
  created_at: number;
}

export interface ShadowNudgeRow {
  id: string;
  agent_id: string;
  content: string;
  consumed: number; // SQLite boolean
  created_at: number;
  consumed_at: number | null;
}

// ============================================================================
// Aggregate / Helper Rows
// ============================================================================

export interface MemoryEntryRow {
  key: string;
  value: string;
  metadata: string | null;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryBlockRow {
  id: string;
  agent_id: string;
  label: string;
  value: string;
  description: string | null;
  char_limit: number;
  read_only: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface CountRow {
  count: number;
}

export interface CategoryRow {
  category: string;
}
