/**
 * Shared type definitions for IPC communication between main and renderer processes
 */

import { Message, User, ContentBlock, MessageMetrics, AppState, ToolCall } from './types';
import { z } from 'zod/v3';
import {
  CreateAgentIPCSchema,
  UpdateAgentIPCSchema,
  CreateChannelIPCSchema,
  CreateChatSchema,
  UpdateChatSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  CreateNoteSchema,
  UpdateNoteSchema,
  ListNotesOptionsSchema,
  CreateLabelSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
  CreateUserSchema,
  UpdateUserSchema,
  AddMCPServerSchema,
  UpdateMCPServerSchema,
  ValidateApiKeySchema,
  OOBEGenerateSchema,
  UpdateSettingsSchema,
} from './validation';

// Chat types
export interface ChatRequest {
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
    name?: string;
    metadata?: Record<string, unknown>;
    agentId?: string;
    toolCalls?: ToolCall[];
  }>;
  agentId: string;
}

export interface ChatResponse {
  success: boolean;
  content?: string;
  error?: string;
  metrics?: MessageMetrics;
  /** AI SDK ResponseMessage[] from this turn — pass to add-agent-message
   *  or update-message-content-blocks so it's persisted for next-turn replay. */
  responseMessages?: unknown[];
}

export interface ChatStreamEvent {
  type: 'text' | 'content' | 'tool-call-start' | 'tool-call-result' | 'tool-call-error' | 'error' | 'compaction-start' | 'compaction-end' | 'stream:start' | 'stream:end';
  content?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

// Agent types — derived from Zod schemas (single source of truth)
export type CreateAgentRequest = z.infer<typeof CreateAgentIPCSchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentIPCSchema>;

// Channel types — derived from Zod schemas (single source of truth)
export type CreateChannelRequest = z.infer<typeof CreateChannelIPCSchema>;

export interface UpdateChannelRequest {
  name?: string;
  pinned?: boolean;
  /** Full replacement of the channel's tag list; null clears it. */
  tags?: string[] | null;
}

export interface SearchChannelsRequest {
  query: string;
  includeArchived?: boolean;
}

export interface GetChannelsByTagsRequest {
  tags: string[];
  includeArchived?: boolean;
}

export interface SendMessageRequest {
  channelId: string;
  content: string;
  /** Selected-agent send: the server runs this agent's turn (draft → stream →
   *  finalize) and suppresses respondTo:'all' broadcast for this message. */
  agentId?: string;
  /** File paths to attach — same shape as SendChatMessageRequest.attachments. */
  attachments?: string[];
}

export interface AddAgentMessageRequest {
  channelId: string;
  agentId: string;
  content: string;
  toolCalls?: Array<{
    toolName: string;
    args: any;
    result?: any;
    error?: any;
    status: 'running' | 'completed' | 'error';
  }>;
  contentBlocks?: ContentBlock[];
  metrics?: MessageMetrics;
  isDraft?: boolean;
  /** AI SDK ResponseMessage[] for next-turn replay. */
  responseMessages?: unknown[];
}

export interface AddChannelParticipantRequest {
  channelId: string;
  participantId: string;
}

export interface StopStreamRequest {
  channelId?: string;
  agentId?: string;
}

// Chat types — derived from Zod schemas (single source of truth)
export type CreateChatRequest = z.infer<typeof CreateChatSchema>;
export type UpdateChatRequest = z.infer<typeof UpdateChatSchema>;

export interface SendChatMessageRequest {
  chatId: string;
  content: string;
  attachments?: string[]; // File paths to attach
}

export interface AddChatAgentMessageRequest {
  chatId: string;
  agentId: string;
  content: string;
  toolCalls?: Array<{
    toolName: string;
    args: any;
    result?: any;
    error?: any;
    status: 'running' | 'completed' | 'error';
  }>;
  contentBlocks?: ContentBlock[];
  metrics?: MessageMetrics;
}

export interface AddChatParticipantRequest {
  chatId: string;
  participantId: string;
}

export interface SearchChatsRequest {
  query: string;
  includeArchived?: boolean;
}

export interface GetChatsByTagsRequest {
  tags: string[];
  includeArchived?: boolean;
}

// Task types — derived from Zod schemas (single source of truth).
// Create* uses z.input: the renderer sends the pre-default payload (color/
// priority are filled in by the schema's .default() on the main side).
export type CreateTaskRequest = z.input<typeof CreateTaskSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskSchema>;

// Note types — derived from Zod schemas (single source of truth)
export type CreateNoteRequest = z.input<typeof CreateNoteSchema>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteSchema>;
export type ListNotesRequest = z.infer<typeof ListNotesOptionsSchema>;
export type CreateNoteLabelRequest = z.infer<typeof CreateLabelSchema>;

// Project types — derived from Zod schemas (single source of truth)
export type CreateProjectRequest = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectSchema>;

// User types — derived from Zod schemas (single source of truth)
export type CreateUserRequest = z.infer<typeof CreateUserSchema>;
export type UpdateUserRequest = z.infer<typeof UpdateUserSchema>;

// MCP Server types — derived from Zod schemas (single source of truth)
export type MCPServerRequest = z.infer<typeof AddMCPServerSchema>;
export type UpdateMCPServerRequest = z.infer<typeof UpdateMCPServerSchema>;

// Settings types — derived from Zod schema (single source of truth)
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsSchema>;

// OOBE types — derived from Zod schemas (single source of truth)
export type ValidateApiKeyRequest = z.infer<typeof ValidateApiKeySchema>;
export type OOBEGenerateRequest = z.infer<typeof OOBEGenerateSchema>;

export interface ValidateApiKeyResponse {
  valid: boolean;
  error?: string;
  models?: string[];
}

export interface OOBEStreamEvent {
  type: 'text' | 'done' | 'error';
  content?: string;
  error?: string;
}

// Log types
export interface LogErrorRequest {
  message: string;
  error?: unknown;
  context?: Record<string, unknown>;
  // Structured fields the log-error handler/schema also accept (e.g. from ErrorBoundary).
  stack?: string;
  componentStack?: string;
  timestamp?: number;
}

// Response types
export interface SuccessResponse {
  success: true;
}

export interface FailureResponse {
  success: false;
  error: string;
}

export interface MessageResponse {
  success: boolean;
  message?: Message;
  error?: string;
}

export interface UserResponse {
  success: boolean;
  user?: User;
  error?: string;
}

// ── LAN sync ────────────────────────────────────────────────────────────

export interface SyncPeerInfo {
  deviceId: string;
  deviceName: string;
  certFingerprint: string;
  pairedAt: number;
  lastSeenAt: number | null;
  lastAppliedSeq: number;
  lastAckedSeq: number;
  online: boolean;
}

export interface SyncDiscoveredDevice {
  deviceId: string;
  deviceName: string;
  host: string;
  port: number;
}

export interface SyncStateSnapshot {
  enabled: boolean;
  running: boolean;
  deviceId: string;
  deviceName: string;
  fingerprint: string | null;
  port: number | null;
  pairingMode: boolean;
  pendingPair: {
    deviceId: string;
    deviceName: string;
    code: string;
    localConfirmed: boolean;
  } | null;
  peers: SyncPeerInfo[];
  discovered: SyncDiscoveredDevice[];
  schemaVersion: number;
}

/**
 * Result of any window zoom operation. Carries the clamp bounds alongside the
 * level so a menu can disable "Zoom In"/"Zoom Out" at the ends without
 * duplicating the main process's limits.
 */
export interface ZoomLevelState {
  /** Chromium zoom level; 0 is 100%. */
  level: number;
  /** 1.2 ^ level — the multiplier to display as a percentage. */
  factor: number;
  min: number;
  max: number;
}

// App state types - re-exported from shared/types.ts
export type { AppState };
