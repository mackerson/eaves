/**
 * MessagingBridge — Platform-agnostic interface for external messaging integrations.
 *
 * Each adapter (Telegram, Slack, Discord, etc.) implements this interface.
 * The MessagingBridgeService handles shared REPL logic (commands, sessions, streaming)
 * and delegates platform-specific I/O to the adapter.
 */

export interface MessagingBridge {
  readonly platform: string;

  /**
   * Connect and begin receiving. Must reject — and leave isRunning() false —
   * if the platform rejects the credentials, so a dead bridge never reports
   * itself as running.
   */
  start(config: BridgeConfig): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  /**
   * Reject an obviously malformed token before it is stored, so the failure
   * surfaces at save time rather than as an opaque API error later.
   * Returns an error message, or null when the token looks well-formed.
   */
  validateToken?(token: string): string | null;

  /**
   * Check credentials without starting delivery. Used by the "Test connection"
   * affordance so a bad token can be diagnosed without a start/stop cycle.
   */
  testConnection?(config: BridgeConfig): Promise<BridgeConnectionTest>;

  /** Identity reported by the platform once connected, if any. */
  getBotUsername?(): string | null;

  /**
   * Called when the adapter shuts itself down (e.g. credentials revoked
   * mid-run). Lets the service record the reason and surface it, since nothing
   * asked for the stop.
   */
  setErrorHandler?(handler: (message: string) => void): void;

  /** Send a new message. Returns the platform-specific message ID. */
  sendMessage(externalChatId: string, text: string, options?: SendOptions): Promise<string>;

  /** Edit an existing message in-place (used for streaming updates). */
  editMessage(externalChatId: string, messageId: string, text: string): Promise<void>;

  /** Delete a message. */
  deleteMessage(externalChatId: string, messageId: string): Promise<void>;

  /** Show a typing/activity indicator. */
  sendTypingIndicator(externalChatId: string): Promise<void>;

  /** Platform-specific max message length. */
  readonly maxMessageLength: number;
}

export interface BridgeConfig {
  token: string;
  allowedUserIds: string[];
  autoStart: boolean;
  [key: string]: unknown;
}

export interface IncomingMessage {
  platform: string;
  externalChatId: string;
  externalUserId: string;
  text: string;
  timestamp: number;
}

export interface SendOptions {
  parseMode?: 'markdown' | 'html' | 'plain';
  replyToMessageId?: string;
}

export interface BridgeSession {
  platform: string;
  externalUserId: string;
  currentChatId: string | null;
  currentAgentId: string | null;
  lastActiveAt: number;
}

export interface BridgeStatus {
  platform: string;
  running: boolean;
  botUsername?: string;
  connectedAt?: number;
  sessionCount: number;

  /**
   * Why the bridge last failed. Held by the service rather than the UI so it
   * survives remounts — a bridge that is down should keep saying why.
   */
  lastError?: BridgeError;

  /** When a message was last accepted from the platform. */
  lastInboundAt?: number;
}

export interface BridgeError {
  message: string;
  at: number;
}

export interface BridgeConnectionTest {
  ok: boolean;
  botUsername?: string;
  error?: string;
}
