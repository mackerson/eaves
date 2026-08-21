import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import {
  getChannelRepository,
  getAgentRepository,
  getSettingsRepository,
  getProjectRepository,
  getToolStateRepository,
} from '../repositories';
import { logger } from './logger';
import { streamAIResponse } from './ai';
import { ToolSessionState } from './discoveryTools';
import { eventBus } from './EventBus';
import { createStreamMetrics, emitAgentSpend, emitStreamSentinel, trackUsage, type StreamEnvelope } from './streamEventRouter';
import { ChatMessage } from '../../shared/types';
import { loadSessionState, seedEnabledTools } from '../ipc/chatHelpers';
import { friendlyAIErrorMessage, summarizeProviderError } from '../utils/aiErrors';
import { builtinTools } from './builtinTools';
import { loadAppState } from './appStateLoader';
import { getSandboxedPluginManager } from './sandbox';
import { runAgentTurn } from './AgentTurnService';
import { resolveSystemAgent } from './systemAgent';
import { curateTags } from '../utils/curateTags';
import type { Agent } from '../types';

/**
 * How many turns may wait behind a running one for the same chat+agent.
 *
 * A ceiling, not a design target: queueing exists so a person typing a
 * follow-up isn't ignored, and any depth beyond a handful means something is
 * generating turns in a loop rather than a human sending messages. Rejecting
 * past this is visible; silently stacking is not.
 */
const MAX_QUEUED_TURNS = 5;

export class ChatService {
  private chatToolStates = new Map<string, ToolSessionState>();
  private activeStreamControllers = new Map<string, AbortController>();
  /**
   * Tail of the per-chat turn chain. A second request for a chat already
   * running one awaits this instead of aborting it — the previous behavior
   * killed a remote user's turn mid-sentence the moment anyone typed on the
   * desktop, and left them with a dangling placeholder.
   */
  private turnChains = new Map<string, Promise<unknown>>();
  private queuedCounts = new Map<string, number>();
  /** Cleared by stopStream so a Stop doesn't just uncork the queue behind it. */
  private cancelledChains = new Set<string>();

  constructor(private getMainWindow: () => BrowserWindow | null) { }

  async chatWithAgent(
    chatId: string,
    agentId: string,
    options?: {
      /**
       * When set, the assistant reply this turn produces is persisted as a
       * sibling under `parentMessageId` with the given `branchIndex` instead
       * of as a fresh leaf. Used by the regenerate flow: the IPC handler
       * archives the original reply via ChannelRepository.regenerateFrom, then
       * passes the parent linkage + next branch_index it returned through
       * here so the new variant slots in correctly.
       */
      branchOverride?: { parentMessageId: string | null; branchIndex: number };
    },
  ) {
    const settingsRepo = getSettingsRepository();
    const projectRepo = getProjectRepository();
    const agentRepo = getAgentRepository();

    const settings = settingsRepo.get();
    const currentState = settingsRepo.getCurrentState();
    const streamKey = `${chatId}:${agentId}`;

    // Queue behind any turn already running for this chat+agent rather than
    // aborting it. Both surfaces reach this path, so a desktop send and a
    // Telegram send now take turns instead of cutting each other off.
    const priorTurn = this.turnChains.get(streamKey);
    if (priorTurn) {
      const queued = (this.queuedCounts.get(streamKey) ?? 0) + 1;
      if (queued > MAX_QUEUED_TURNS) {
        logger.warn('[ChatService] Turn queue full, rejecting', { streamKey, queued });
        return { success: false, error: `Too many queued turns for this chat (limit ${MAX_QUEUED_TURNS}).` };
      }
      this.queuedCounts.set(streamKey, queued);
      logger.info('[ChatService] Turn queued behind a running one', { streamKey, queued });
      // A prior turn that failed or was stopped must not block this one.
      await priorTurn.catch(() => undefined);
      const remaining = Math.max(0, (this.queuedCounts.get(streamKey) ?? 1) - 1);
      this.queuedCounts.set(streamKey, remaining);

      // Stop means stop — including anything that queued up behind the turn
      // the user stopped. Draining the queue afterwards would fire the very
      // turns they were trying to prevent.
      //
      // The flag is cleared by the LAST waiter to wake, not by the stopped
      // turn's own cleanup: that cleanup runs before this one resumes, so
      // clearing it there let a queued turn wake to a flag that had already
      // been erased and run anyway.
      if (this.cancelledChains.has(streamKey)) {
        if (remaining === 0) this.cancelledChains.delete(streamKey);
        logger.info('[ChatService] Dropping queued turn — chain was stopped', { streamKey });
        return { success: false, aborted: true, error: 'Cancelled before this turn started' };
      }
    }

    const streamAbortController = new AbortController();
    this.activeStreamControllers.set(streamKey, streamAbortController);

    // Publish this turn's completion before any awaiting happens, so a request
    // arriving mid-turn queues behind it rather than racing past.
    let releaseChain: () => void = () => { /* replaced below */ };
    const thisTurn = new Promise<void>((resolve) => { releaseChain = resolve; });
    this.turnChains.set(streamKey, thisTurn);

    const cleanupTimeout = setTimeout(() => {
      if (this.activeStreamControllers.has(streamKey)) {
        logger.warn('[ChatService] Stream controller cleanup timeout reached', { streamKey });
        this.activeStreamControllers.delete(streamKey);
      }
    }, 300000); // 5 minutes

    try {
      const currentProject = currentState.projectId ? projectRepo.getById(currentState.projectId) : null;
      const agent = agentRepo.getById(agentId);

      if (!currentProject) {
        logger.error('[ChatService] No active project');
        return this.failBeforeTurn(chatId, agentId, agent, new Error('No active project'));
      }

      if (!agent) {
        logger.error('[ChatService] Agent not found', { agentId });
        return this.failBeforeTurn(chatId, agentId, null, new Error('Agent not found'));
      }

      // Close any tool approval the user walked away from before starting this
      // turn — an unresolved approval strands its tool-call with no result and
      // locks the thread on every send. Best-effort; never blocks the turn.
      try {
        const { closeSupersededApprovals } = await import('./approvalResume');
        await closeSupersededApprovals('chat', chatId);
      } catch (err) {
        logger.warn('[ChatService] closeSupersededApprovals failed', {
          chatId, error: err instanceof Error ? err.message : String(err),
        });
      }

      // The turn itself — history build, envelope-tagged stream, persistence
      // (success, empty, and error-notice shapes), approval registration —
      // runs in the turn core ('chat-assistant' policy). This wrapper owns
      // only the public IPC result shape and the abort-controller registry.
      const result = await runAgentTurn({
        context: 'chat',
        containerId: chatId,
        agent,
        project: currentProject,
        settings,
        persistence: 'chat-assistant',
        abortSignal: streamAbortController.signal,
        branchOverride: options?.branchOverride,
        onCancel: () => streamAbortController.abort(),
      }, {
        getMainWindow: this.getMainWindow,
        toolStates: this.chatToolStates,
      });

      if (result.status === 'aborted') {
        return { success: false, aborted: true, error: 'Stream canceled by new request' };
      }
      if (result.status === 'error') {
        return { success: false, error: result.errorMessage };
      }
      return {
        success: true,
        response: result.response,
        metrics: result.metrics,
        pendingApprovals: result.pendingApprovals,
      };
    } finally {
      clearTimeout(cleanupTimeout);
      this.activeStreamControllers.delete(streamKey);
      releaseChain();
      if (this.turnChains.get(streamKey) === thisTurn) {
        this.turnChains.delete(streamKey);
      }
      // Cancellation state outlives this turn while anything is still queued
      // behind it — those waiters have not woken to read it yet.
      if ((this.queuedCounts.get(streamKey) ?? 0) === 0) {
        this.cancelledChains.delete(streamKey);
        this.queuedCounts.delete(streamKey);
      }
    }
  }

  /**
   * Pre-flight failure (missing project/agent): an error raised before the
   * turn core can run still needs the turn core's full failure surface —
   * persist an in-chat error notice when the agent resolved, push the
   * chat-stream error + stream:end sentinels, emit chat:error.
   */
  private failBeforeTurn(chatId: string, agentId: string, agent: Agent | null, error: Error) {
    const mainWindow = this.getMainWindow();
    const errorMessage = friendlyAIErrorMessage(error, agent?.provider);

    if (agent) {
      getChannelRepository().createDirectMessage({
        chatId,
        senderId: agentId,
        senderType: 'agent',
        senderDisplayName: agent.name,
        senderColor: agent.color,
        metadata: { participantType: 'agent' },
        content: `[Error: ${errorMessage}]`,
        contentBlocks: [{ type: 'system' as const, content: `Error: ${errorMessage}`, timestamp: Date.now() }],
        toolCalls: [],
        timestamp: Date.now(),
        metrics: createStreamMetrics(),
        branchIndex: 0,
      });
    }

    // No turn ran, so there is no turn envelope — synthesize one. Without it
    // the error and the sentinel land on whatever chat happens to be open.
    const envelope: StreamEnvelope = {
      turnId: randomUUID(),
      agentId,
      containerId: chatId,
      context: 'chat',
    };

    if (mainWindow) {
      mainWindow.webContents.send('chat-stream', {
        type: 'error',
        error: { message: errorMessage },
        ...envelope,
      });
      emitStreamSentinel(mainWindow, 'end', envelope);
    }

    eventBus.emitEvent('chat:error', {
      agentId,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    });

    return { success: false, error: errorMessage };
  }

  /**
   * Stop the running turn for a chat, and drop anything queued behind it.
   *
   * Dropping the queue is the point: a person who hits Stop after typing three
   * follow-ups wants all of it to stop, not to watch three more turns fire.
   * The flag is read by queued turns when they wake, and cleared when the
   * chain fully drains.
   */
  async stopStream(chatId: string) {
    for (const [streamKey, controller] of this.activeStreamControllers.entries()) {
      if (streamKey.startsWith(chatId + ':')) {
        logger.info('[ChatService] User requested stream stop', {
          streamKey,
          queuedBehind: this.queuedCounts.get(streamKey) ?? 0,
        });
        this.cancelledChains.add(streamKey);
        controller.abort();
        this.activeStreamControllers.delete(streamKey);
        return { success: true };
      }
    }
    return { success: false, error: 'No active stream found' };
  }

  /**
   * Clears all state associated with a chat.
   * Call this when a chat is deleted to prevent memory leaks.
   */
  clearChatState(chatId: string) {
    // Clear tool state — both the in-memory session and its persisted backing.
    this.chatToolStates.delete(chatId);
    getToolStateRepository().delete(chatId);

    // Abort and clear any active streams for this chat
    for (const [streamKey, controller] of this.activeStreamControllers.entries()) {
      if (streamKey.startsWith(chatId + ':')) {
        controller.abort();
        this.activeStreamControllers.delete(streamKey);
      }
    }

  }

  async generateMetadata(chatId: string, messages: ChatMessage[]) {
    try {
      const chatRepo = getChannelRepository();

      const chat = chatRepo.getConversationById(chatId);
      if (!chat) return { success: false, error: 'Chat not found' };

      // Title/tag generation is housekeeping, not a chat turn — route through
      // the user's pinned system agent so they can use a cheap fast model for
      // it. Falls back to defaultAgentId then first available.
      const agent = resolveSystemAgent();
      if (!agent) return { success: false, error: 'No agent available for metadata generation' };

      const memory = loadAppState();
      const userMessage = messages.find(m => m.senderType === 'human')?.content || '';
      const assistantMessage = messages.find(m => m.senderType === 'agent')?.content || '';

      // Reuse-first vocabulary: show the model what tags already exist so it
      // converges on them instead of minting synonyms (chat/conversation/
      // casual all pointing at the same region).
      const existingTags = chatRepo.getTagUsage(30, 'direct');
      const vocabularyNote = existingTags.length > 0
        ? `\nExisting tags — reuse these when they fit, and only invent a new tag when none apply: ${existingTags.join(', ')}\n`
        : '';

      const generationPrompt = `Based on this conversation exchange, generate a short, descriptive title (max 5 words) and up to 3 relevant tags (comma-separated).

Tags must name the specific subject matter, in lowercase. Never use generic tags that apply to any conversation (like "conversation", "chat", "casual", or "greeting") — if the exchange has no meaningful subject yet, return fewer tags or none.
${vocabularyNote}
User: ${userMessage}
Assistant: ${assistantMessage}

Respond ONLY with a JSON object in this exact format:
{
  "title": "Short Title Here",
  "tags": "tag1, tag2, tag3"
}`;

      const aiMessages = [{ role: 'user' as const, content: generationPrompt }];
      let fullResponse = '';

      // Auto-title generation runs without a human watching this specific call.
      // It is small but it fires once per new conversation, so over a busy week
      // it is not nothing — and an unmetered call is exactly the kind that
      // shows up as an unexplained gap between the app's totals and the bill.
      const titleMetrics = createStreamMetrics();
      const titleStartedAt = Date.now();
      for await (const event of streamAIResponse(
        agent, memory, aiMessages,
        undefined, undefined, undefined, undefined, undefined,
        { nonInteractive: true, contextLabel: `chat-title:${chatId}` },
      )) {
        if (typeof event === 'string') {
          fullResponse += event;
        }
        trackUsage(event, titleMetrics);
      }
      titleMetrics.timeToComplete = Date.now() - titleStartedAt;
      titleMetrics.model = agent.model;
      titleMetrics.provider = agent.provider;
      emitAgentSpend(agent, titleMetrics, { kind: 'chat-title', containerId: chatId });

      try {
        const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const metadata = JSON.parse(jsonMatch[0]);
          logger.info(`[ChatService] Generated chat metadata: ${metadata.title}`);

          // Curation gate: the model tags freely, this decides what's stored
          const rawTags = Array.isArray(metadata.tags) ? metadata.tags.join(', ') : String(metadata.tags ?? '');
          const tags = curateTags(rawTags);

          eventBus.emitEvent('chat:auto-title', {
            chatId,
            title: metadata.title,
            tags,
            agentId: agent.id
          });

          return {
            success: true,
            title: metadata.title,
            tags
          };
        }
      } catch (parseError) {
        logger.error('[ChatService] Failed to parse generated metadata JSON', parseError);
      }

      return { success: false, error: 'Failed to generate metadata' };
    } catch (error) {
      // Wraps an AI call, so the error can carry the whole outgoing request.
      logger.error('[ChatService] Error generating chat metadata', summarizeProviderError(error));
      return { success: false, error: 'Failed to generate metadata' };
    }
  }

  async getChatTools(chatId: string) {
    try {
      const chatRepo = getChannelRepository();
      const agentRepo = getAgentRepository();

      const chat = chatRepo.getConversationById(chatId);
      if (!chat) return { success: false, error: 'Chat not found' };

      const agent = agentRepo.getById(chat.agentId);
      if (!agent) return { success: false, error: 'Agent not found' };

      // Roleplay agents only ever surface their explicit `defaultTools`
      // allowlist. No discovery suite seeded into sessionState — that would
      // both contaminate buildToolset's reuse of the cached state and show
      // bogus tools as "enabled" in the Tool Panel for in-character chats.
      // When defaultTools is empty (the common case), the returned array
      // is empty and the renderer hides the panel.
      const isRoleplay = agent.archetype?.type === 'roleplay';
      if (isRoleplay) {
        const sessionState = loadSessionState(chatId, this.chatToolStates, new Set<string>(agent.defaultTools ?? []));

        const pluginManager = getSandboxedPluginManager();
        const pluginTools = pluginManager.getRegisteredTools();
        const allowlistedTools: Array<{ name: string; label: string; category: 'discovery' | 'builtin' | 'plugin' | 'mcp'; enabled: boolean }> = [];

        for (const toolName of agent.defaultTools ?? []) {
          let category: 'builtin' | 'plugin' | 'mcp' = 'mcp';
          if (toolName in builtinTools) category = 'builtin';
          else if (toolName in pluginTools) category = 'plugin';
          allowlistedTools.push({
            name: toolName,
            label: toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            category,
            enabled: sessionState.enabledTools.has(toolName),
          });
        }

        return { success: true, tools: allowlistedTools };
      }

      const sessionState = loadSessionState(chatId, this.chatToolStates, seedEnabledTools(agent));

      const allTools: Array<{ name: string; label: string; category: 'discovery' | 'builtin' | 'plugin' | 'mcp'; enabled: boolean }> = [];

      const discoveryTools = ['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool'];
      for (const toolName of discoveryTools) {
        allTools.push({
          name: toolName,
          label: toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          category: 'discovery',
          enabled: true,
        });
      }

      for (const [toolName] of Object.entries(builtinTools)) {
        allTools.push({
          name: toolName,
          label: toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          category: 'builtin',
          enabled: sessionState.enabledTools.has(toolName),
        });
      }

      const pluginManager = getSandboxedPluginManager();
      const pluginTools = pluginManager.getRegisteredTools();
      for (const [toolName] of Object.entries(pluginTools)) {
        allTools.push({
          name: toolName,
          label: toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          category: 'plugin',
          enabled: sessionState.enabledTools.has(toolName),
        });
      }

      for (const toolName of sessionState.enabledTools) {
        if (!allTools.find(t => t.name === toolName)) {
          allTools.push({
            name: toolName,
            label: toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            category: 'mcp',
            enabled: true,
          });
        }
      }

      return { success: true, tools: allTools };
    } catch (error) {
      logger.error('[ChatService] Error getting chat tools:', error);
      return { success: false, error: 'Failed to get chat tools' };
    }
  }

  async toggleChatTool(chatId: string, toolName: string, enabled: boolean) {
    try {
      const chatRepo = getChannelRepository();
      const agentRepo = getAgentRepository();
      const chat = chatRepo.getConversationById(chatId);
      if (!chat) return { success: false, error: 'Chat not found' };

      const agent = agentRepo.getById(chat.agentId);
      const isRoleplay = agent?.archetype?.type === 'roleplay';

      // Roleplay chats can only toggle tools the agent author allowlisted
      // via defaultTools. Otherwise a stale/buggy UI could enable arbitrary
      // tools on an in-character session.
      if (isRoleplay && !(agent.defaultTools ?? []).includes(toolName)) {
        return { success: false, error: 'Tool not available on roleplay agents unless added to defaultTools' };
      }

      const seed = isRoleplay
        ? new Set<string>(agent?.defaultTools ?? [])
        : (agent ? seedEnabledTools(agent) : new Set<string>(['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool']));
      const sessionState = loadSessionState(chatId, this.chatToolStates, seed);

      const discoveryTools = ['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool'];
      if (discoveryTools.includes(toolName) && !enabled) {
        return { success: false, error: 'Cannot disable discovery tools' };
      }

      if (enabled) {
        sessionState.enabledTools.add(toolName);
      } else {
        sessionState.enabledTools.delete(toolName);
      }
      // Persist the change so it survives restarts (same backing store the
      // discovery tools' enable_tool/disable_tool write through).
      sessionState.onChanged?.();

      return { success: true };
    } catch (error) {
      logger.error('[ChatService] Error toggling chat tool:', error);
      return { success: false, error: 'Failed to toggle tool' };
    }
  }
}
