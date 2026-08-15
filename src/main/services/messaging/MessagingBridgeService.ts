/**
 * MessagingBridgeService — Shared REPL orchestrator for external messaging platforms.
 *
 * Handles command parsing, session management, AI streaming relay, and auth.
 * Platform adapters (Telegram, Slack, etc.) handle only I/O specifics.
 */

import { BrowserWindow } from 'electron';
import {
  MessagingBridge,
  BridgeConfig,
  BridgeConnectionTest,
  BridgeError,
  BridgeSession,
  BridgeStatus,
  IncomingMessage,
} from './MessagingBridge';

/** In-memory health for one platform. Rebuilt from scratch each launch. */
interface BridgeHealth {
  connectedAt?: number;
  lastError?: BridgeError;
  lastInboundAt?: number;
}
import {
  getChannelRepository,
  getAgentRepository,
  getUserRepository,
  getSettingsRepository,
} from '../../repositories';
import { ChatService } from '../ChatService';
import { eventBus } from '../EventBus';
import { logger } from '../logger';
import { getDatabase } from '../database';
import { encryptString, decryptString } from '../encryption';

// ============================================================================
// Stream buffer for relaying AI responses to external platforms
// ============================================================================

interface StreamBuffer {
  externalChatId: string;
  messageId: string;      // Platform message ID being edited
  text: string;
  lastUpdateTime: number;
  updateTimer: ReturnType<typeof setTimeout> | null;
  complete: boolean;
}

const MIN_UPDATE_INTERVAL = 500;  // ms between edits
const CHUNK_THRESHOLD = 80;       // min new chars before updating

// ============================================================================
// Command definitions
// ============================================================================

interface ParsedCommand {
  command: string;
  args: string;
}

function parseCommand(text: string): ParsedCommand | null {
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/s);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

// ============================================================================
// Service
// ============================================================================

export class MessagingBridgeService {
  private bridges = new Map<string, MessagingBridge>();
  private streamBuffers = new Map<string, StreamBuffer>();
  private chatService: ChatService;
  private streamListeners = new Map<string, () => void>();
  private inFlightRequests = new Set<string>();

  /**
   * Per-platform health. Kept in the service rather than the renderer so a
   * failure reason outlives the settings panel that happened to be open when
   * it occurred.
   */
  private health = new Map<string, BridgeHealth>();

  constructor(private getMainWindow: () => BrowserWindow | null) {
    this.chatService = new ChatService(getMainWindow);
  }

  private getHealth(platform: string): BridgeHealth {
    let entry = this.health.get(platform);
    if (!entry) {
      entry = {};
      this.health.set(platform, entry);
    }
    return entry;
  }

  private recordBridgeError(platform: string, message: string): void {
    this.getHealth(platform).lastError = { message, at: Date.now() };
    eventBus.emitEvent('messaging:bridge:error', { platform, message });
  }

  // --------------------------------------------------------------------------
  // Bridge lifecycle
  // --------------------------------------------------------------------------

  registerBridge(bridge: MessagingBridge): void {
    this.bridges.set(bridge.platform, bridge);
    bridge.setErrorHandler?.((message) => this.recordBridgeError(bridge.platform, message));
  }

  async startBridge(platform: string): Promise<void> {
    const bridge = this.bridges.get(platform);
    if (!bridge) throw new Error(`No bridge registered for platform: ${platform}`);

    const config = this.loadBridgeConfig(platform);
    if (!config) throw new Error(`No config found for platform: ${platform}`);

    try {
      await bridge.start(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordBridgeError(platform, message);
      throw error;
    }

    const health = this.getHealth(platform);
    health.connectedAt = Date.now();
    health.lastError = undefined;

    const botUsername = bridge.getBotUsername?.() ?? undefined;
    logger.info(`[MessagingBridge] Started ${platform} bridge`, { botUsername });
    eventBus.emitEvent('messaging:bridge:started', { platform, botUsername });
  }

  async stopBridge(platform: string): Promise<void> {
    const bridge = this.bridges.get(platform);
    if (!bridge) return;

    // Clean up all stream listeners for this platform
    for (const [key, cleanup] of this.streamListeners.entries()) {
      if (key.startsWith(`${platform}:`)) {
        cleanup();
        this.streamListeners.delete(key);
      }
    }

    await bridge.stop();
    this.getHealth(platform).connectedAt = undefined;
    logger.info(`[MessagingBridge] Stopped ${platform} bridge`);
    eventBus.emitEvent('messaging:bridge:stopped', { platform });
  }

  async stopAll(): Promise<void> {
    for (const platform of this.bridges.keys()) {
      await this.stopBridge(platform).catch(err =>
        logger.error(`[MessagingBridge] Error stopping ${platform}:`, err)
      );
    }
  }

  getBridgeStatuses(): BridgeStatus[] {
    const statuses: BridgeStatus[] = [];
    for (const [platform, bridge] of this.bridges) {
      const sessions = this.getSessions(platform);
      const health = this.health.get(platform);
      const running = bridge.isRunning();
      statuses.push({
        platform,
        running,
        sessionCount: sessions.length,
        botUsername: (running ? bridge.getBotUsername?.() : null) ?? undefined,
        connectedAt: running ? health?.connectedAt : undefined,
        lastError: health?.lastError,
        lastInboundAt: health?.lastInboundAt,
      });
    }
    return statuses;
  }

  // --------------------------------------------------------------------------
  // Incoming message handler (called by adapters)
  // --------------------------------------------------------------------------

  async handleIncoming(message: IncomingMessage): Promise<void> {
    const bridge = this.bridges.get(message.platform);
    if (!bridge) return;

    // Auth check. A rejected sender is a security-relevant event, so it leaves
    // a trace locally instead of only a reply to the caller. Identifiers only —
    // message content is never logged or persisted here.
    const config = this.loadBridgeConfig(message.platform);
    if (!config || !this.isAuthorized(message.externalUserId, config)) {
      logger.warn('[MessagingBridge] Rejected unauthorized sender', {
        platform: message.platform,
        externalUserId: message.externalUserId,
      });
      eventBus.emitEvent('messaging:auth:rejected', {
        platform: message.platform,
        externalUserId: message.externalUserId,
      });
      await bridge.sendMessage(message.externalChatId, 'Unauthorized. This bot is private.');
      return;
    }

    this.getHealth(message.platform).lastInboundAt = Date.now();

    // Load or create session
    const session = this.getOrCreateSession(message.platform, message.externalUserId);
    this.touchSession(session);

    // Parse command or treat as message
    const parsed = parseCommand(message.text);
    if (parsed) {
      await this.handleCommand(bridge, message.externalChatId, session, parsed);
    } else {
      await this.handleTextMessage(bridge, message.externalChatId, session, message.text);
    }
  }

  // --------------------------------------------------------------------------
  // Command handlers
  // --------------------------------------------------------------------------

  private async handleCommand(
    bridge: MessagingBridge,
    externalChatId: string,
    session: BridgeSession,
    cmd: ParsedCommand
  ): Promise<void> {
    switch (cmd.command) {
      case 'help':
        return this.cmdHelp(bridge, externalChatId);
      case 'chats':
        return this.cmdChats(bridge, externalChatId);
      case 'search':
        return this.cmdSearch(bridge, externalChatId, cmd.args);
      case 'switch':
        return this.cmdSwitch(bridge, externalChatId, session, cmd.args);
      case 'agents':
        return this.cmdAgents(bridge, externalChatId);
      case 'agent':
        return this.cmdAgent(bridge, externalChatId, session, cmd.args);
      case 'new':
        return this.cmdNew(bridge, externalChatId, session, cmd.args);
      case 'status':
        return this.cmdStatus(bridge, externalChatId, session);
      case 'stop':
        return this.cmdStop(bridge, externalChatId, session);
      default:
        await bridge.sendMessage(externalChatId, `Unknown command: /${cmd.command}\nType /help for available commands.`);
    }
  }

  private async cmdHelp(bridge: MessagingBridge, chatId: string): Promise<void> {
    const help = [
      'Eaves Remote REPL',
      '',
      '/chats — List recent conversations',
      '/search <query> — Search conversations',
      '/switch <id|name> — Switch active conversation',
      '/agents — List available agents',
      '/agent <id|name> — Switch active agent',
      '/new [agent] [chat name] — Start new conversation',
      '/status — Show current session state',
      '/stop — Stop the current AI stream',
      '/help — Show this message',
      '',
      'Send any text to chat with the current agent.',
    ].join('\n');
    await bridge.sendMessage(chatId, help);
  }

  private async cmdChats(bridge: MessagingBridge, chatId: string): Promise<void> {
    const chatRepo = getChannelRepository();
    const chats = chatRepo.getDirectChats({ includeArchived: false });
    if (chats.length === 0) {
      await bridge.sendMessage(chatId, 'No conversations found.');
      return;
    }

    const agentRepo = getAgentRepository();
    const lines = chats.slice(0, 20).map((c, i) => {
      const agent = agentRepo.getById(c.agentId);
      const agentName = agent ? agent.name : 'Unknown';
      const date = new Date(c.lastMessageAt || c.createdAt).toLocaleDateString();
      return `${i + 1}. ${c.name} [${agentName}] (${date})`;
    });

    const header = `Conversations (${chats.length} total):\n\n`;
    await bridge.sendMessage(chatId, header + lines.join('\n'));
  }

  private async cmdSearch(bridge: MessagingBridge, chatId: string, query: string): Promise<void> {
    if (!query) {
      await bridge.sendMessage(chatId, 'Usage: /search <query>');
      return;
    }

    const chatRepo = getChannelRepository();
    const results = chatRepo.searchDirectChats(query);
    if (results.length === 0) {
      await bridge.sendMessage(chatId, `No results for "${query}".`);
      return;
    }

    const agentRepo = getAgentRepository();
    const lines = results.slice(0, 15).map((c, i) => {
      const agent = agentRepo.getById(c.agentId);
      const agentName = agent ? agent.name : 'Unknown';
      return `${i + 1}. ${c.name} [${agentName}]\n   ID: ${c.id}`;
    });

    await bridge.sendMessage(chatId, `Search results for "${query}":\n\n${lines.join('\n')}`);
  }

  private async cmdSwitch(bridge: MessagingBridge, chatId: string, session: BridgeSession, args: string): Promise<void> {
    if (!args) {
      await bridge.sendMessage(chatId, 'Usage: /switch <chat id or name>');
      return;
    }

    const chatRepo = getChannelRepository();
    // Try by ID first
    let chat = chatRepo.getDirectChatById(args);

    // Fallback: search by name or index
    if (!chat) {
      const allChats = chatRepo.getDirectChats({ includeArchived: false });
      const index = parseInt(args, 10);
      if (!isNaN(index) && index >= 1 && index <= allChats.length) {
        chat = allChats[index - 1];
      } else {
        chat = allChats.find(c => c.name.toLowerCase().includes(args.toLowerCase())) || null;
      }
    }

    if (!chat) {
      await bridge.sendMessage(chatId, `Chat not found: "${args}"`);
      return;
    }

    session.currentChatId = chat.id;
    // Auto-set agent from chat
    session.currentAgentId = chat.agentId;
    this.saveSession(session);

    const agentRepo = getAgentRepository();
    const agent = agentRepo.getById(chat.agentId);
    await bridge.sendMessage(chatId, `Switched to: ${chat.name}\nAgent: ${agent?.name || 'Unknown'}`);
  }

  private async cmdAgents(bridge: MessagingBridge, chatId: string): Promise<void> {
    const agentRepo = getAgentRepository();
    const agents = agentRepo.getAll();
    if (agents.length === 0) {
      await bridge.sendMessage(chatId, 'No agents found.');
      return;
    }

    const lines = agents.map((a, i) =>
      `${i + 1}. ${a.name} (${a.provider}/${a.model})`
    );

    await bridge.sendMessage(chatId, `Agents:\n\n${lines.join('\n')}`);
  }

  private async cmdAgent(bridge: MessagingBridge, chatId: string, session: BridgeSession, args: string): Promise<void> {
    if (!args) {
      await bridge.sendMessage(chatId, 'Usage: /agent <id or name>');
      return;
    }

    const agentRepo = getAgentRepository();
    const agents = agentRepo.getAll();

    // Try by ID, index, or name
    let agent = agentRepo.getById(args);
    if (!agent) {
      const index = parseInt(args, 10);
      if (!isNaN(index) && index >= 1 && index <= agents.length) {
        agent = agents[index - 1];
      } else {
        agent = agents.find(a => a.name.toLowerCase().includes(args.toLowerCase())) || null;
      }
    }

    if (!agent) {
      await bridge.sendMessage(chatId, `Agent not found: "${args}"`);
      return;
    }

    session.currentAgentId = agent.id;
    this.saveSession(session);

    await bridge.sendMessage(chatId, `Agent switched to: ${agent.name} (${agent.provider}/${agent.model})`);
  }

  private async cmdNew(bridge: MessagingBridge, chatId: string, session: BridgeSession, args: string): Promise<void> {
    const agentRepo = getAgentRepository();
    const userRepo = getUserRepository();
    const chatRepo = getChannelRepository();
    const currentUser = userRepo.getCurrent();

    let agentId = session.currentAgentId;
    let chatName = args || 'Telegram Chat';

    // Parse: /new agentName chat name here
    if (args) {
      const agents = agentRepo.getAll();
      const firstWord = args.split(/\s+/)[0].toLowerCase();
      const matchedAgent = agents.find(a => a.name.toLowerCase() === firstWord);
      if (matchedAgent) {
        agentId = matchedAgent.id;
        chatName = args.slice(firstWord.length).trim() || 'Telegram Chat';
      }
    }

    if (!agentId) {
      const agents = agentRepo.getAll();
      if (agents.length === 0) {
        await bridge.sendMessage(chatId, 'No agents available. Create one in Eaves first.');
        return;
      }
      agentId = agents[0].id;
    }

    const agent = agentRepo.getById(agentId);
    if (!agent) {
      await bridge.sendMessage(chatId, 'Agent not found.');
      return;
    }

    const participants = [];
    if (currentUser) {
      participants.push({
        id: currentUser.id,
        type: 'human' as const,
        displayName: currentUser.name,
        color: currentUser.color,
        joinedAt: Date.now(),
      });
    }
    participants.push({
      id: agent.id,
      type: 'agent' as const,
      displayName: agent.name,
      color: agent.color,
      joinedAt: Date.now(),
    });

    const newChat = chatRepo.createDirectChat({ name: chatName, agentId }, participants);
    session.currentChatId = newChat.id;
    session.currentAgentId = agentId;
    this.saveSession(session);

    await bridge.sendMessage(chatId, `Created: ${chatName}\nAgent: ${agent.name}\nReady to chat.`);
  }

  private async cmdStatus(bridge: MessagingBridge, chatId: string, session: BridgeSession): Promise<void> {
    const chatRepo = getChannelRepository();
    const agentRepo = getAgentRepository();

    const chat = session.currentChatId ? chatRepo.getDirectChatById(session.currentChatId) : null;
    const agent = session.currentAgentId ? agentRepo.getById(session.currentAgentId) : null;

    const lines = [
      `Platform: ${session.platform}`,
      `Chat: ${chat ? chat.name : '(none)'}`,
      `Agent: ${agent ? `${agent.name} (${agent.provider}/${agent.model})` : '(none)'}`,
    ];

    // Show last message preview if available
    if (chat) {
      const messages = chatRepo.getDirectChatById(session.currentChatId!, { includeMessages: true, messageLimit: 1 });
      if (messages?.messages?.length) {
        const last = messages.messages[messages.messages.length - 1];
        const preview = last.content.slice(0, 100) + (last.content.length > 100 ? '...' : '');
        lines.push(`Last message: ${preview}`);
      }
    }

    await bridge.sendMessage(chatId, lines.join('\n'));
  }

  private async cmdStop(bridge: MessagingBridge, chatId: string, session: BridgeSession): Promise<void> {
    if (!session.currentChatId) {
      await bridge.sendMessage(chatId, 'No active conversation to stop.');
      return;
    }

    const result = await this.chatService.stopStream(session.currentChatId);
    if (result.success) {
      await bridge.sendMessage(chatId, 'Stream stopped.');
    } else {
      await bridge.sendMessage(chatId, 'No active stream to stop.');
    }
  }

  // --------------------------------------------------------------------------
  // Text message → AI streaming relay
  // --------------------------------------------------------------------------

  private async handleTextMessage(
    bridge: MessagingBridge,
    externalChatId: string,
    session: BridgeSession,
    text: string
  ): Promise<void> {
    if (!session.currentChatId || !session.currentAgentId) {
      await bridge.sendMessage(
        externalChatId,
        'No active conversation. Use /chats to list or /new to create one.'
      );
      return;
    }

    const chatRepo = getChannelRepository();
    const agentRepo = getAgentRepository();
    const userRepo = getUserRepository();

    const chat = chatRepo.getDirectChatById(session.currentChatId);
    if (!chat) {
      session.currentChatId = null;
      this.saveSession(session);
      await bridge.sendMessage(externalChatId, 'Chat no longer exists. Use /chats or /new.');
      return;
    }

    const agent = agentRepo.getById(session.currentAgentId);
    if (!agent) {
      session.currentAgentId = null;
      this.saveSession(session);
      await bridge.sendMessage(externalChatId, 'Agent no longer exists. Use /agents to pick one.');
      return;
    }

    // Create human message in Eaves
    const currentUser = userRepo.getCurrent();
    chatRepo.createDirectMessage({
      chatId: session.currentChatId,
      senderId: currentUser?.id || 'remote-user',
      senderType: 'human',
      senderDisplayName: currentUser?.name || 'Remote User',
      senderColor: currentUser?.color,
      content: text,
      timestamp: Date.now(),
    });

    // One relay at a time per remote user — the stream buffer is a single
    // placeholder message being edited, so a second concurrent relay would
    // overwrite the first. The *turn* is no longer rejected though:
    // ChatService queues it behind whatever is running (including a desktop
    // turn on the same chat), so the message is answered rather than refused.
    const bufferKey = `${session.platform}:${externalChatId}`;
    if (this.inFlightRequests.has(bufferKey)) {
      await bridge.sendMessage(externalChatId, 'Still working on your last message — send again once I reply.');
      return;
    }

    // Clean up any orphaned listeners/buffers from a previous request
    const existingCleanup = this.streamListeners.get(bufferKey);
    if (existingCleanup) existingCleanup();
    const existingBuffer = this.streamBuffers.get(bufferKey);
    if (existingBuffer?.updateTimer) clearTimeout(existingBuffer.updateTimer);
    this.streamBuffers.delete(bufferKey);

    this.inFlightRequests.add(bufferKey);

    // Send typing indicator
    await bridge.sendTypingIndicator(externalChatId);

    // Send a placeholder message we'll edit with streaming content
    const placeholderMsgId = await bridge.sendMessage(externalChatId, '...');

    // Set up stream buffer
    this.streamBuffers.set(bufferKey, {
      externalChatId,
      messageId: placeholderMsgId,
      text: '',
      lastUpdateTime: Date.now(),
      updateTimer: null,
      complete: false,
    });

    // Capture IDs at request time to avoid cross-chat contamination
    const targetAgentId = session.currentAgentId;
    const targetChatId = session.currentChatId;

    // Listen for stream events
    const streamHandler = (event: { type: string; data?: any }) => {
      const data = event.data;
      if (!data) return;

      // agentId alone is not a conversation identity: the same agent can be
      // mid-turn in a desktop chat, another remote session, or a channel, and
      // matching on it alone piped all of that into this user's Telegram
      // window. Require the container to match. Events with no containerId
      // predate the envelope and are dropped rather than guessed at — this is
      // an outbound path to a third party, so it fails closed.
      if (data.agentId !== targetAgentId) return;
      if (data.containerId !== targetChatId) return;

      if (event.type === 'chat:stream' && data.chunk) {
        this.appendToBuffer(bridge, bufferKey, data.chunk);
      } else if (event.type === 'chat:complete') {
        this.completeBuffer(bridge, bufferKey);
        cleanup();
      } else if (event.type === 'chat:aborted') {
        // Someone else took the chat — the desktop, or a newer turn. Say so
        // rather than leaving a dangling placeholder.
        this.errorBuffer(bridge, bufferKey, 'Cancelled — this chat was answered somewhere else.');
        cleanup();
      } else if (event.type === 'chat:error') {
        logger.error('[MessagingBridge] AI stream error:', data.error);
        this.errorBuffer(bridge, bufferKey, 'An error occurred. Check Eaves for details.');
        cleanup();
      }
    };

    const cleanup = () => {
      eventBus.removeListener('chat:stream', streamHandler);
      eventBus.removeListener('chat:complete', streamHandler);
      eventBus.removeListener('chat:aborted', streamHandler);
      eventBus.removeListener('chat:error', streamHandler);
      this.streamListeners.delete(bufferKey);
      this.inFlightRequests.delete(bufferKey);
    };

    this.streamListeners.set(bufferKey, cleanup);
    eventBus.on('chat:stream', streamHandler);
    eventBus.on('chat:complete', streamHandler);
    eventBus.on('chat:aborted', streamHandler);
    eventBus.on('chat:error', streamHandler);

    // Trigger the AI response
    try {
      // chatWithAgent resolves rather than throws on abort/error, so the
      // result has to be inspected — an unchecked call left the in-flight
      // flag set forever and wedged this user on "please wait".
      // Queues behind any turn already running on this chat — including one
      // started from the desktop — instead of aborting it.
      const result = await this.chatService.chatWithAgent(targetChatId!, targetAgentId!);
      if (result && result.success === false && this.inFlightRequests.has(bufferKey)) {
        cleanup();
        this.errorBuffer(
          bridge,
          bufferKey,
          result.aborted
            ? 'Cancelled — this chat was answered somewhere else.'
            : 'An error occurred. Check Eaves for details.',
        );
      }
    } catch (error: any) {
      logger.error('[MessagingBridge] AI request failed:', error);
      cleanup();
      this.errorBuffer(bridge, bufferKey, 'An error occurred. Check Eaves for details.');
    }
  }

  // --------------------------------------------------------------------------
  // Stream buffer management
  // --------------------------------------------------------------------------

  private appendToBuffer(bridge: MessagingBridge, bufferKey: string, chunk: string): void {
    const buffer = this.streamBuffers.get(bufferKey);
    if (!buffer || buffer.complete) return;

    buffer.text += chunk;

    // Throttle updates
    const now = Date.now();
    const elapsed = now - buffer.lastUpdateTime;
    const newChars = buffer.text.length - (buffer.lastUpdateTime === 0 ? 0 : buffer.text.length - chunk.length);

    if (elapsed >= MIN_UPDATE_INTERVAL && newChars >= CHUNK_THRESHOLD) {
      this.flushBuffer(bridge, bufferKey);
    } else if (!buffer.updateTimer) {
      buffer.updateTimer = setTimeout(() => {
        buffer.updateTimer = null;
        this.flushBuffer(bridge, bufferKey);
      }, MIN_UPDATE_INTERVAL);
    }
  }

  private async flushBuffer(bridge: MessagingBridge, bufferKey: string): Promise<void> {
    const buffer = this.streamBuffers.get(bufferKey);
    if (!buffer || !buffer.text) return;

    try {
      // Truncate if over platform limit for in-progress display
      const displayText = buffer.text.length > bridge.maxMessageLength - 10
        ? buffer.text.slice(0, bridge.maxMessageLength - 13) + '...'
        : buffer.text + ' ▍';

      await bridge.editMessage(buffer.externalChatId, buffer.messageId, displayText);
      buffer.lastUpdateTime = Date.now();
    } catch (error) {
      logger.warn('[MessagingBridge] Failed to update stream message:', error);
    }
  }

  private async completeBuffer(bridge: MessagingBridge, bufferKey: string): Promise<void> {
    const buffer = this.streamBuffers.get(bufferKey);
    if (!buffer) return;

    buffer.complete = true;
    if (buffer.updateTimer) {
      clearTimeout(buffer.updateTimer);
      buffer.updateTimer = null;
    }

    try {
      const text = buffer.text || '(Empty response)';

      // Split into multiple messages if over platform limit
      if (text.length > bridge.maxMessageLength) {
        // Edit the first message with the first chunk
        await bridge.editMessage(
          buffer.externalChatId,
          buffer.messageId,
          text.slice(0, bridge.maxMessageLength)
        );
        // Send remaining chunks as new messages
        for (let i = bridge.maxMessageLength; i < text.length; i += bridge.maxMessageLength) {
          await bridge.sendMessage(
            buffer.externalChatId,
            text.slice(i, i + bridge.maxMessageLength)
          );
        }
      } else {
        await bridge.editMessage(buffer.externalChatId, buffer.messageId, text);
      }
    } catch (error) {
      logger.error('[MessagingBridge] Failed to send final message:', error);
    }

    this.streamBuffers.delete(bufferKey);
  }

  private async errorBuffer(bridge: MessagingBridge, bufferKey: string, errorMsg: string): Promise<void> {
    const buffer = this.streamBuffers.get(bufferKey);
    if (!buffer) return;

    buffer.complete = true;
    if (buffer.updateTimer) {
      clearTimeout(buffer.updateTimer);
      buffer.updateTimer = null;
    }

    try {
      const text = buffer.text
        ? `${buffer.text}\n\n[Error: ${errorMsg}]`
        : `Error: ${errorMsg}`;
      await bridge.editMessage(buffer.externalChatId, buffer.messageId, text);
    } catch (error) {
      logger.error('[MessagingBridge] Failed to send error message:', error);
    }

    this.streamBuffers.delete(bufferKey);
  }

  // --------------------------------------------------------------------------
  // Session management (SQLite-backed)
  // --------------------------------------------------------------------------

  private getOrCreateSession(platform: string, externalUserId: string): BridgeSession {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT * FROM bridge_sessions WHERE platform = ? AND external_user_id = ?'
    ).get(platform, externalUserId) as any;

    if (row) {
      return {
        platform: row.platform,
        externalUserId: row.external_user_id,
        currentChatId: row.current_chat_id,
        currentAgentId: row.current_agent_id,
        lastActiveAt: row.last_active_at,
      };
    }

    const session: BridgeSession = {
      platform,
      externalUserId,
      currentChatId: null,
      currentAgentId: null,
      lastActiveAt: Date.now(),
    };
    this.saveSession(session);
    return session;
  }

  private saveSession(session: BridgeSession): void {
    const db = getDatabase();
    db.prepare(`
      INSERT OR REPLACE INTO bridge_sessions
        (platform, external_user_id, current_chat_id, current_agent_id, last_active_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      session.platform,
      session.externalUserId,
      session.currentChatId,
      session.currentAgentId,
      session.lastActiveAt
    );
  }

  private touchSession(session: BridgeSession): void {
    session.lastActiveAt = Date.now();
    this.saveSession(session);
  }

  getSessions(platform: string): BridgeSession[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM bridge_sessions WHERE platform = ?').all(platform) as any[];
    return rows.map(row => ({
      platform: row.platform,
      externalUserId: row.external_user_id,
      currentChatId: row.current_chat_id,
      currentAgentId: row.current_agent_id,
      lastActiveAt: row.last_active_at,
    }));
  }

  // --------------------------------------------------------------------------
  // Config management (encrypted, SQLite-backed)
  // --------------------------------------------------------------------------

  loadBridgeConfig(platform: string): BridgeConfig | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM bridge_configs WHERE platform = ?').get(platform) as any;
    if (!row) return null;

    try {
      const decrypted = decryptString(row.config_encrypted);
      if (!decrypted) return null;
      const config = JSON.parse(decrypted) as BridgeConfig;
      config.autoStart = row.auto_start === 1;
      return config;
    } catch {
      logger.error(`[MessagingBridge] Failed to decrypt config for ${platform}`);
      return null;
    }
  }

  saveBridgeConfig(platform: string, config: BridgeConfig): void {
    const db = getDatabase();
    const { autoStart, ...rest } = config;
    const encrypted = encryptString(JSON.stringify(rest));
    db.prepare(`
      INSERT OR REPLACE INTO bridge_configs
        (platform, config_encrypted, enabled, auto_start)
      VALUES (?, ?, 1, ?)
    `).run(platform, encrypted, autoStart ? 1 : 0);
  }

  getBridgeConfig(platform: string): { hasConfig: boolean; allowedUserIds: string[]; autoStart: boolean } {
    const config = this.loadBridgeConfig(platform);
    if (!config) return { hasConfig: false, allowedUserIds: [], autoStart: false };
    return {
      hasConfig: true,
      allowedUserIds: config.allowedUserIds || [],
      autoStart: config.autoStart,
    };
  }

  /** Delegates to the adapter's own token check. Null means "looks fine". */
  validateBridgeToken(platform: string, token: string): string | null {
    const bridge = this.bridges.get(platform);
    if (!bridge?.validateToken) return null;
    return bridge.validateToken(token);
  }

  /**
   * Probe stored credentials without starting delivery. Records the outcome as
   * health so a failed test explains itself in the UI like any other failure.
   */
  async testBridgeConnection(platform: string): Promise<BridgeConnectionTest> {
    const bridge = this.bridges.get(platform);
    if (!bridge) return { ok: false, error: `No bridge registered for platform: ${platform}` };
    if (!bridge.testConnection) return { ok: false, error: 'This bridge does not support testing.' };

    const config = this.loadBridgeConfig(platform);
    if (!config) return { ok: false, error: 'Save a configuration first.' };

    const result = await bridge.testConnection(config);
    if (result.ok) {
      this.getHealth(platform).lastError = undefined;
    } else if (result.error) {
      this.recordBridgeError(platform, result.error);
    }
    return result;
  }

  deleteBridgeConfig(platform: string): void {
    const db = getDatabase();
    db.prepare('DELETE FROM bridge_configs WHERE platform = ?').run(platform);
  }

  getAutoStartPlatforms(): string[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT platform FROM bridge_configs WHERE auto_start = 1').all() as any[];
    return rows.map(r => r.platform);
  }

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  private isAuthorized(externalUserId: string, config: BridgeConfig): boolean {
    if (!config.allowedUserIds || config.allowedUserIds.length === 0) return false;
    return config.allowedUserIds.includes(externalUserId);
  }
}

// Singleton
let instance: MessagingBridgeService | null = null;

export function getMessagingBridgeService(getMainWindow?: () => BrowserWindow | null): MessagingBridgeService {
  if (!instance) {
    if (!getMainWindow) throw new Error('MessagingBridgeService requires getMainWindow on first init');
    instance = new MessagingBridgeService(getMainWindow);
  }
  return instance;
}
