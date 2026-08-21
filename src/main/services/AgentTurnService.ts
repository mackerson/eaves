import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { logger } from './logger';
import { eventBus } from './EventBus';
import { MessageFormatter } from './MessageFormatter';
import { ContentBlocksBuilder } from './ContentBlocksBuilder';
import { perspectiveShiftMessages } from '../utils/perspectiveShift';
import { resolveStickyProvider } from '../utils/stickyProvider';
import { friendlyAIErrorMessage } from '../utils/aiErrors';
import { buildRoleplayNote } from '../utils/buildRoleplayNote';
import { assembleReplayHistory } from './replayHistory';
import { reportSessionBlocked } from './WorkSessionService';
import {
  createAttachmentLoaders,
  expandImageBlock,
  expandFileBlock,
  projectChatHistory,
  scanTurnFailures,
  failureSection,
  type InlineImagePart,
} from './replayProjection';
import { summarySection } from './compaction';
import {
  routeStreamEvent,
  emitStreamStart,
  emitStreamComplete,
  emitStreamAborted,
  emitAgentSpend,
  createStreamMetrics,
  emitCompaction,
  emitStreamSentinel,
  type StreamEnvelope,
  type StreamMetrics,
} from './streamEventRouter';
import { buildToolset, buildSystemPrompt, runStream, activeToolsFor, buildRequestInfo, systemPromptPlumbing } from '../ipc/chatHelpers';
import { resolveTurnBudget } from './contextBudget';
import type { StreamResult, PendingApprovalInfo } from '../ipc/chatHelpers';
import { getChannelRepository } from '../repositories';
import { getPendingApprovalRegistry } from './PendingApprovalRegistry';
import { getActiveWorkRegistry } from './ActiveWorkRegistry';
import { calculateCost } from '../../shared/pricing';
import type { Tool } from 'ai';
import type { ToolSessionState } from './discoveryTools';
import type { Agent, Channel, ChannelBehavior, ContentBlock, Message, Project, Settings } from '../types';
import { DEFAULT_CHANNEL_BEHAVIOR } from '../types';
import type { ChatMessage } from '../../shared/types';

/**
 * AgentTurnService — the one "run an agent turn" core (ADR-001 Decision 1).
 *
 * Pipeline: build history (perspective-shifted for channels) → toolset +
 * system prompt → stream (every chat-stream event stamped with the additive
 * { turnId, agentId, containerId, context } envelope) → persist per policy →
 * push. Drivers (ChatService, ChannelDispatcher) stay thin: they own guards,
 * target resolution, and abort-controller registries, and delegate the turn
 * here.
 *
 * Persistence policies:
 *  - 'chat-assistant'     — ChatService shape: assistant reply persisted as a
 *                           chat message (empty replies included — chats have
 *                           no drafts, pinned contract), errors persisted as
 *                           in-chat notices with any partial content.
 *  - 'channel-broadcast'  — dispatcher reply: terminal (dispatchedBy +
 *                           parentDispatchMessageId), empty turns skipped.
 *  - 'channel-selected'   — selected-agent reply: draft → finalize via
 *                           updateMessageContentBlocks (non-terminal, mentions
 *                           in it re-enter dispatch). Empty turns delete the
 *                           draft — they never persist (ADR-001).
 */

export type TurnContext = 'chat' | 'channel';
export type TurnPersistence = 'chat-assistant' | 'channel-broadcast' | 'channel-selected';

export interface AgentTurnRequest {
  context: TurnContext;
  /** chatId (a type='direct' channel row) or channelId. */
  containerId: string;
  agent: Agent;
  project: Project;
  settings: Settings;
  /** Message that provoked this turn — parents channel replies and error notices. */
  trigger?: { messageId?: string };
  persistence: TurnPersistence;
  abortSignal: AbortSignal;
  /** chat-assistant only: regenerate linkage (see ChatService.chatWithAgent). */
  branchOverride?: { parentMessageId: string | null; branchIndex: number };
  /**
   * Stops this turn. The driver owns the abort controller, so it supplies the
   * hook; without one the turn is still listed as running, just not stoppable
   * from outside the surface that started it.
   */
  onCancel?: () => void;
}

export interface AgentTurnDeps {
  getMainWindow: () => BrowserWindow | null;
  /** The driver's per-container tool-session cache (dispatcher or ChatService owns it). */
  toolStates: Map<string, ToolSessionState>;
}

export type TurnStatus = 'completed' | 'empty' | 'aborted' | 'error';

export interface AgentTurnResult {
  turnId: string;
  status: TurnStatus;
  /** The persisted reply, when the policy persisted one. */
  message?: Message | ChatMessage;
  response: string;
  contentBlocks: ContentBlock[];
  metrics?: StreamMetrics;
  pendingApprovals?: PendingApprovalInfo[];
  /** Terminal in-band stream failure (already recorded as a system block). */
  streamError?: string;
  /** Friendly error text when status === 'error' (chat-assistant only — channel policies rethrow). */
  errorMessage?: string;
}

export async function runAgentTurn(request: AgentTurnRequest, deps: AgentTurnDeps): Promise<AgentTurnResult> {
  const envelope: StreamEnvelope = {
    turnId: randomUUID(),
    agentId: request.agent.id,
    containerId: request.containerId,
    context: request.context,
  };

  // Every agent turn — chat and channel alike — funnels through here, so one
  // registration covers both surfaces. The driver still owns the abort
  // controller; this only exposes it, so a turn can be seen and stopped from
  // somewhere other than the window that started it.
  const work = getActiveWorkRegistry().start({
    kind: request.context === 'chat' ? 'chat-turn' : 'channel-turn',
    agentId: request.agent.id,
    agentName: request.agent.name,
    containerId: request.containerId,
    label: request.agent.name,
    onCancel: request.onCancel,
  });

  try {
    if (request.persistence === 'chat-assistant') {
      if (request.context !== 'chat') {
        throw new Error(`chat-assistant persistence requires context 'chat', got '${request.context}'`);
      }
      return await runChatAssistantTurn(request, deps, envelope);
    }

    if (request.context !== 'channel') {
      throw new Error(`${request.persistence} persistence requires context 'channel', got '${request.context}'`);
    }

    const channel = getChannelRepository().getById(request.containerId, { includeMessages: true, messageLimit: 100 });
    if (!channel) {
      throw new Error('Channel not found');
    }

    return request.persistence === 'channel-selected'
      ? await runChannelSelectedTurn(request, deps, envelope, channel)
      : await runChannelBroadcastTurn(request, deps, envelope, channel);
  } finally {
    work.done();
  }
}

// ─── Channel turns ───────────────────────────────────────────────

/**
 * Shared channel-turn machinery: perspective-shift the channel history,
 * assemble budget/toolset/system prompt, then drive runStream — which routes
 * live 'chat-stream' events (envelope-stamped) to the renderer. Persistence
 * stays with the policy functions below.
 */
async function streamChannelTurn(
  channel: Channel,
  agent: Agent,
  project: Project,
  settings: Settings,
  abortSignal: AbortSignal,
  deps: AgentTurnDeps,
  envelope: StreamEnvelope,
): Promise<StreamResult> {
  const channelId = channel.id;
  const behavior: ChannelBehavior = agent.channelBehavior || DEFAULT_CHANNEL_BEHAVIOR;

  // Attachment expansion. Channel history is a text-flattening pipeline —
  // perspectiveShift prefixes and merges by string concatenation — so
  // attachments expand to inline text here (full contents for the current
  // turn's files, lightweight references for older turns, same helper the
  // chat path uses), and the current turn's images additionally ride as real
  // vision parts injected after MessageFormatter (whose string transforms
  // would break content-part arrays).
  const loaders = createAttachmentLoaders();

  // Same treatment the chat surface gives failed turns: out of the message
  // stream, reported through the system prompt. Channels persist these with
  // `[Error: …]` as the content, which would otherwise reach other
  // participants as though this agent had said it. Scan before indexing —
  // the surviving rows are what everything below is positional against.
  const failures = scanTurnFailures(channel.messages);

  let lastHumanIndex = -1;
  for (let i = failures.rows.length - 1; i >= 0; i--) {
    if (failures.rows[i].senderType === 'human') {
      lastHumanIndex = i;
      break;
    }
  }
  const currentImageParts: InlineImagePart[] = [];

  // Convert DB messages to the chat format expected by perspectiveShift
  const chatMessages = failures.rows.map((msg, index) => {
    let content = msg.content;
    if (Array.isArray(msg.contentBlocks)) {
      const isCurrentTurn = index === lastHumanIndex;
      const extras: string[] = [];
      for (const block of msg.contentBlocks as any[]) {
        if (block?.type === 'image' && block.url) {
          const expanded = expandImageBlock(block, loaders, isCurrentTurn);
          if ('part' in expanded) {
            currentImageParts.push(expanded.part);
            // Keep a text marker alongside the vision part: the raw-prompt
            // (instruct-template) path can't carry parts, and the [Name]:
            // prefixed history reads better with an explicit reference.
            extras.push(`[Image: ${block.alt || 'attached image'}]`);
          } else {
            extras.push(expanded.text);
          }
        } else if (block?.type === 'file' && block.url) {
          extras.push(expandFileBlock(block, loaders, isCurrentTurn));
        }
      }
      if (extras.length > 0) {
        content = [content, ...extras].filter(Boolean).join('\n\n');
      }
    }
    return {
      role: (msg.senderType === 'human' ? 'user' : 'assistant') as 'user' | 'assistant',
      content,
      name: `${msg.senderType}_${msg.senderId}`,
      toolCalls: msg.toolCalls,
      metadata: {
        senderType: msg.senderType,
        displayName: msg.senderDisplayName,
      },
    };
  });

  // Perspective shift for the responding agent
  const perspectiveMessages = perspectiveShiftMessages(chatMessages, agent.id);

  const budget = await resolveTurnBudget(agent);

  // Build toolset
  const toolset = await buildToolset(agent, project, channelId, deps.toolStates);

  // Build system prompt with channel behavior note
  const behaviorNote = buildChannelBehaviorNote(agent, behavior);
  const systemPrompt = await buildSystemPrompt({
    agent,
    project,
    settings,
    participants: channel.participants,
    participantNote: behaviorNote,
    ...systemPromptPlumbing(toolset, budget),
  });

  // Same repair → compact → window → assert pipeline the chat surface runs.
  // The prose projection can't carry tool structure, so the repair passes are
  // mostly inert here — but the empty-turn drop and the invariant assertion
  // are not: without them a channel is just as wedgeable as a chat.
  const assembled = await assembleReplayHistory({
    agent,
    containerId: channelId,
    budget,
    messages: perspectiveMessages,
    onCompacting: (phase) => emitCompaction(deps.getMainWindow(), phase, envelope),
    source: 'channel',
  });
  let effectiveSystemPrompt = assembled.summary
    ? systemPrompt + summarySection(assembled.summary)
    : systemPrompt;
  effectiveSystemPrompt += failureSection(failures.unresolved);
  if (currentImageParts.length > 0) {
    // Same describe-first nudge the chat path appends on image turns — a real
    // system instruction, suffixed so the cached prompt prefix still hits.
    effectiveSystemPrompt += '\n\nWhen the user shares an image, start by briefly describing what you see, then address their message — this keeps the visual context available as the conversation continues.';
  }
  const formattedResult = MessageFormatter.formatMessages(
    agent,
    assembled.messages as typeof perspectiveMessages,
    effectiveSystemPrompt,
    settings.userName,
  );

  // Attach the current turn's images as vision parts on the final user
  // message. Post-format on purpose: MessageFormatter's contextFormatting
  // and instruct-template paths operate on string content. The raw-prompt
  // path can't carry parts at all — it keeps the [Image: …] text markers
  // appended during history expansion above.
  if (currentImageParts.length > 0 && !formattedResult.useRawPrompt) {
    for (let i = formattedResult.messages.length - 1; i >= 0; i--) {
      const m = formattedResult.messages[i] as { role: string; content: unknown };
      if (m.role === 'user') {
        m.content = [{ type: 'text', text: m.content }, ...currentImageParts] as unknown as string;
        break;
      }
    }
  }

  // Stream AI response. Register the full tool set; gate active schemas per
  // step — deferred tools stay off the wire until enabled, and a tiny window
  // trims to discovery + enabled. Recomputed live so a mid-turn enable lands.
  const activeToolsFn = activeToolsFor(toolset, budget.sizeClass);
  const activeToolNames = activeToolsFn();
  return runStream({
    agent,
    formattedResult,
    enabledTools: toolset.enabledTools as Record<string, unknown>,
    activeTools: activeToolsFn,
    abortSignal,
    mainWindow: deps.getMainWindow(),
    messageCount: chatMessages.length,
    envelope,
    // OpenRouter sticky pin: keep this conversation on the backend that
    // served its last agent turn, for prompt-cache continuity.
    preferredProvider: resolveStickyProvider(channel.messages, agent.provider),
    requestInfo: buildRequestInfo({
      budget,
      systemPrompt,
      messagesTotal: perspectiveMessages.length,
      messagesSent: assembled.messages.length,
      activeToolNames,
      includeSystemPrompt: agent.debugLogging,
    }),
  });
}

/**
 * Broadcast reply (dispatcher @mention / respondTo:'all'): terminal —
 * terminality is structural (this path chains no intent); dispatchedBy is
 * observability metadata only, never read as a guard. parentDispatchMessageId
 * carries chain accounting. Empty turns never persist. Errors propagate to the dispatcher,
 * which persists the in-channel error notice.
 */
async function runChannelBroadcastTurn(
  request: AgentTurnRequest,
  deps: AgentTurnDeps,
  envelope: StreamEnvelope,
  channel: Channel,
): Promise<AgentTurnResult> {
  const { agent, project, settings } = request;
  const channelRepo = getChannelRepository();

  const result = await streamChannelTurn(channel, agent, project, settings, request.abortSignal, deps, envelope);

  if (request.abortSignal.aborted) {
    logger.info('[AgentTurnService] Broadcast turn aborted post-stream', { channelId: channel.id, agentId: agent.id });
    emitStreamAborted(agent.id, envelope);
    return { turnId: envelope.turnId, status: 'aborted', response: result.response, contentBlocks: result.contentBlocks, metrics: result.metrics, streamError: result.streamError };
  }

  if (result.streamError) {
    logger.warn('[AgentTurnService] Agent turn ended with stream error', {
      agentId: agent.id, error: result.streamError,
    });
  }

  const hasPendingApprovals = (result.pendingApprovals?.length ?? 0) > 0;
  const hasContent = result.response.trim().length > 0 || result.contentBlocks.length > 0;
  // Skip silent turns — no narration, no tool activity, no pending approvals.
  // Don't pollute the channel with empty agent rows in that case.
  if (!hasContent && !hasPendingApprovals) {
    logger.warn('[AgentTurnService] Empty response from agent', { agentId: agent.id });
    return { turnId: envelope.turnId, status: 'empty', response: result.response, contentBlocks: result.contentBlocks, metrics: result.metrics, streamError: result.streamError };
  }

  // Save agent message — dispatchedBy is terminal metadata (not a guard),
  // parentDispatchMessageId tracks chain depth for downstream dispatches
  const agentMessage = channelRepo.createMessage({
    channelId: channel.id,
    senderId: agent.id,
    senderType: 'agent',
    senderDisplayName: agent.name,
    senderColor: agent.color,
    metadata: {
      participantType: 'agent',
      dispatchedBy: 'channel-dispatcher',
      parentDispatchMessageId: request.trigger?.messageId,
    },
    // Empty content fine — approval state lives in the tool-approval
    // contentBlock; renderer hints cover truly-empty turns.
    content: result.response,
    contentBlocks: result.contentBlocks.length > 0 ? result.contentBlocks : undefined,
    // Persist SDK-shape so the model's record of this turn's tool calls
    // survives across turns. Same pattern as the chat path.
    responseMessages: result.responseMessages,
    timestamp: Date.now(),
    metrics: result.metrics,
  });

  if (hasPendingApprovals && result.pendingApprovals) {
    const registry = getPendingApprovalRegistry();
    for (const a of result.pendingApprovals) {
      registry.register({
        approvalId: a.approvalId,
        toolCallId: a.toolCallId,
        toolName: a.toolName,
        input: a.input,
        context: 'channel',
        contextId: channel.id,
        agentId: agent.id,
        messageId: agentMessage.id,
      });
    }
  }

  // Notify renderer so the UI updates in real time
  const mainWindow = deps.getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send('channel-message-added', {
      channelId: channel.id,
      message: agentMessage,
    });
  }

  logger.info('[AgentTurnService] Agent response saved', {
    agentName: agent.name, channelId: channel.id, messageId: agentMessage.id,
    responseLength: result.response.length,
  });

  return {
    turnId: envelope.turnId,
    status: 'completed',
    message: agentMessage,
    response: result.response,
    contentBlocks: result.contentBlocks,
    metrics: result.metrics,
    pendingApprovals: result.pendingApprovals,
    streamError: result.streamError,
  };
}

/**
 * Selected-agent reply (a human channel send addressed to one agent):
 *  - empty draft first (dispatch-silent), announced via 'channel-message-added'
 *    so the renderer has a row to bind the live 'chat-stream' events to;
 *  - finalize via updateMessageContentBlocks so the repository emits
 *    message:updated(draftFinalized) — @mentions in the reply re-enter
 *    dispatch, parented to the draft id — plus the 'message-updated' push.
 * The reply carries NO dispatchedBy: unlike broadcast replies it is not
 * terminal. Multi-agent chaining semantics depend on this.
 *
 * Abort or an empty turn deletes the draft — empty turns never persist
 * (ADR-001), rather than finalizing an empty row. Errors delete the draft and
 * propagate to the dispatcher's error-notice path.
 */
async function runChannelSelectedTurn(
  request: AgentTurnRequest,
  deps: AgentTurnDeps,
  envelope: StreamEnvelope,
  channel: Channel,
): Promise<AgentTurnResult> {
  const { agent, project, settings, abortSignal } = request;
  const channelRepo = getChannelRepository();
  const channelId = channel.id;
  let draftId: string | undefined;

  try {
    // The selected agent joins the channel on its first reply — it can be
    // addressed before it is a participant.
    if (!channel.participants.some(p => p.id === agent.id)) {
      channelRepo.addParticipant(channelId, {
        id: agent.id,
        type: 'agent',
        displayName: agent.name,
        color: agent.color,
        joinedAt: Date.now(),
      });
    }

    const draft = channelRepo.createMessage({
      channelId,
      senderId: agent.id,
      senderType: 'agent',
      senderDisplayName: agent.name,
      senderColor: agent.color,
      metadata: { participantType: 'agent' },
      content: '',
      timestamp: Date.now(),
      isDraft: true,
    });
    draftId = draft.id;

    // Announce the draft so the renderer has a message row to bind the
    // live 'chat-stream' events to.
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('channel-message-added', { channelId, message: draft });
    }

    const result = await streamChannelTurn(channel, agent, project, settings, abortSignal, deps, envelope);

    // Abort can race a cleanly-ending provider stream (the stream returns
    // instead of throwing AbortError). Honor the user's stop: drop the
    // draft rather than finalizing a truncated reply.
    if (abortSignal.aborted) {
      channelRepo.deleteMessage(draft.id);
      draftId = undefined;
      logger.info('[AgentTurnService] Selected-agent turn aborted post-stream', { channelId, agentId: agent.id });
      emitStreamAborted(agent.id, envelope);
      return { turnId: envelope.turnId, status: 'aborted', response: result.response, contentBlocks: result.contentBlocks, metrics: result.metrics, streamError: result.streamError };
    }

    if (result.streamError) {
      logger.warn('[AgentTurnService] Selected-agent turn ended with stream error', {
        agentId: agent.id, error: result.streamError,
      });
    }

    const hasPendingApprovals = (result.pendingApprovals?.length ?? 0) > 0;
    const hasContent = result.response.trim().length > 0 || result.contentBlocks.length > 0;
    if (!hasContent && !hasPendingApprovals) {
      // Empty turn: delete the draft instead of finalizing an empty row
      // (ADR-001 — broadcast semantics win). Still push a finalize-shaped
      // 'message-updated' so the renderer's pending send settles; the row is
      // gone server-side, so the ghost disappears on the next reload.
      channelRepo.deleteMessage(draft.id);
      draftId = undefined;
      logger.warn('[AgentTurnService] Empty selected-agent turn — draft deleted', { channelId, agentId: agent.id });
      if (mainWindow) {
        mainWindow.webContents.send('message-updated', {
          messageId: draft.id,
          contentBlocks: [],
          content: '',
          isDraft: false,
          metrics: result.metrics,
        });
      }
      return { turnId: envelope.turnId, status: 'empty', response: result.response, contentBlocks: result.contentBlocks, metrics: result.metrics, streamError: result.streamError };
    }

    channelRepo.updateMessageContentBlocks(
      draft.id,
      result.contentBlocks,
      result.response,
      false,
      result.metrics,
      result.responseMessages,
    );

    if (result.pendingApprovals) {
      const registry = getPendingApprovalRegistry();
      for (const a of result.pendingApprovals) {
        registry.register({
          approvalId: a.approvalId,
          toolCallId: a.toolCallId,
          toolName: a.toolName,
          input: a.input,
          context: 'channel',
          contextId: channelId,
          agentId: agent.id,
          messageId: draft.id,
        });
      }
    }

    // Finalize push — the renderer's pending send settles on this.
    if (mainWindow) {
      mainWindow.webContents.send('message-updated', {
        messageId: draft.id,
        contentBlocks: result.contentBlocks,
        content: result.response,
        isDraft: false,
        metrics: result.metrics,
      });
    }

    logger.info('[AgentTurnService] Selected-agent reply finalized', {
      agentName: agent.name, channelId, messageId: draft.id,
      responseLength: result.response.length,
    });

    return {
      turnId: envelope.turnId,
      status: 'completed',
      message: { ...draft, content: result.response, contentBlocks: result.contentBlocks, isDraft: false },
      response: result.response,
      contentBlocks: result.contentBlocks,
      metrics: result.metrics,
      pendingApprovals: result.pendingApprovals,
      streamError: result.streamError,
    };
  } catch (error) {
    // The draft never finalized — drop it rather than leave a dangling empty
    // draft row. The dispatcher owns the error notice, so rethrow.
    if (draftId) {
      try { channelRepo.deleteMessage(draftId); } catch { /* best effort */ }
    }
    throw error;
  }
}

// ─── Chat turn ───────────────────────────────────────────────────

/**
 * 1:1 assistant turn (the ChatService.chatWithAgent path). Persists the
 * assistant reply (empty included: chats have no drafts, and the renderer
 * shows a "(no response)" hint), persists partial content + an error notice
 * on failure, and brackets the live stream with the 'stream:start' /
 * 'stream:end' sentinels.
 */
async function runChatAssistantTurn(
  request: AgentTurnRequest,
  deps: AgentTurnDeps,
  envelope: StreamEnvelope,
): Promise<AgentTurnResult> {
  const { agent, settings, project: currentProject, containerId: chatId, abortSignal } = request;
  const agentId = agent.id;
  const chatRepo = getChannelRepository();

  const mcpClients: any[] = [];
  const builder = new ContentBlocksBuilder();
  const streamMetrics = createStreamMetrics();
  // Branch metadata for the assistant reply this turn produces. Computed
  // once after history loads, shared by both the success and error
  // persist paths so a partial-error save lands as the same regen
  // sibling that a successful save would have.
  let parentForReply: string | null = null;
  let branchIndexForReply = 0;

  try {
    const chat = chatRepo.getConversationById(chatId);

    if (!chat) {
      logger.error('[AgentTurnService] Chat not found', { chatId });
      throw new Error('Chat not found');
    }

    // For a regenerate, the override (computed from regenerateFrom in the
    // IPC handler) places the new row as a sibling of the archived
    // original. For a normal turn, parent the reply onto the last active
    // message in the chat — that's the trigger turn (a user message in
    // the typical flow). Populating this means a future regenerate of
    // this reply will share a meaningful parent_message_id with siblings
    // (rather than every root-level message looking like a sibling under
    // NULL parent).
    const lastActive = chat.messages[chat.messages.length - 1];
    parentForReply = request.branchOverride
      ? request.branchOverride.parentMessageId
      : (lastActive?.id ?? null);
    branchIndexForReply = request.branchOverride?.branchIndex ?? 0;

    const toolset = await buildToolset(agent, currentProject, chatId, deps.toolStates, {
      getMainWindow: deps.getMainWindow,
    });
    mcpClients.push(...toolset.mcpClients);

    const budget = await resolveTurnBudget(agent);

    const { enabledTools } = toolset;

    const systemPrompt = await buildSystemPrompt({
      agent,
      project: currentProject,
      settings,
      participants: chat.participants,
      ...systemPromptPlumbing(toolset, budget),
      roleplayNote: buildRoleplayNote(agent, chat),
    });

    const mainWindow = deps.getMainWindow();
    const startTime = Date.now();

    const memory = {
      settings,
      users: [],
      agents: [],
      projects: [],
      channels: [],
      currentProjectId: null,
      currentAgentId: null,
      currentChannelId: null,
      currentUserId: null,
    };

    logger.info('[AgentTurnService] Starting AI stream', { provider: agent.provider, model: agent.model });

    emitStreamSentinel(mainWindow, 'start', envelope);

    emitStreamStart(agent.id, agent, chat.messages.length);

    // Handle attachments — loaders shared with the channel history builder.
    const loaders = createAttachmentLoaders();

    // Turns that died mid-stream come out of the message array and get
    // reported through the system prompt instead — an infrastructure failure
    // is not something the model said.
    const failures = scanTurnFailures(chat.messages);
    const { messages, lastUserMessageHasImages } = projectChatHistory(failures.rows, loaders);

    // When the turn carries an image, ask the model to describe it first —
    // but as a REAL system instruction, not a "[System: …]" string smuggled
    // into the user's message content. A prefix like "System:"/"Tool:" is a
    // trust boundary; rendering one inside a user turn is a role-spoof vector
    // (and lets any user message fake a system directive). Appended as a
    // suffix so the cached system-prompt prefix still hits on image turns.
    let effectiveSystemPrompt = lastUserMessageHasImages
      ? `${systemPrompt}\n\nWhen the user shares an image, start by briefly describing what you see, then address their message — this keeps the visual context available as the conversation continues.`
      : systemPrompt;

    // Repair → compact → window → repair → assert, shared with the channel
    // and resume surfaces (a chat is a `channels` row with type='direct', so
    // chatId is the container id compaction keys on).
    const assembled = await assembleReplayHistory({
      agent,
      containerId: chatId,
      budget,
      messages,
      onCompacting: (phase) => emitCompaction(mainWindow, phase, envelope),
      source: 'chat',
    });
    if (assembled.summary) {
      effectiveSystemPrompt += summarySection(assembled.summary);
    }
    effectiveSystemPrompt += failureSection(failures.unresolved);
    const windowedMessages = assembled.messages as typeof messages;

    // Register the full tool set; gate what's actually exposed per step.
    // 'all' mode exposes everything but the deferred tools; 'enabled' mode and
    // any tiny window trim to discovery + enabled. Recomputed each step so a
    // tool the model enables can be used in the same turn.
    const activeToolsFn = activeToolsFor(toolset, budget.sizeClass);
    const activeToolNames = activeToolsFn();
    const effectiveTools = enabledTools;

    // Defensive guard: streamText throws InvalidPromptError("messages must
    // not be empty") if we hand it nothing. We've seen this fall out of
    // upstream issues (e.g. a failed user-message insert leaving the chat
    // empty when the agent turn fires). Surface a clear error instead of
    // a generic SDK throw.
    if (windowedMessages.length === 0) {
      const err = new Error('No messages to send — was the user message saved?');
      logger.error('[AgentTurnService] empty messages array, refusing to stream', {
        chatId, agentId, totalMessages: chat.messages.length, builtMessages: messages.length,
      });
      throw err;
    }

    // Captured from the terminal 'response-messages' event so we can persist
    // the SDK-shape record alongside the UI-shape contentBlocks.
    let capturedResponseMessages: unknown[] | undefined;
    // OpenRouter's real reported cost for this turn, preferred over the
    // token-count estimate when present.
    let orReportedCost: number | undefined;
    // Approvals raised this turn — registered with the registry once the
    // resulting assistant message has an id we can reference for resume.
    const pendingApprovals: PendingApprovalInfo[] = [];

    const { streamAIResponse } = await import('./ai');
    for await (const event of streamAIResponse(
      agent,
      memory,
      windowedMessages,
      effectiveSystemPrompt,
      Object.keys(effectiveTools).length > 0 ? effectiveTools as Record<string, Tool> : undefined,
      abortSignal,
      undefined,
      // Chats don't run the instruct-template/raw-prompt path (messages can
      // carry image content parts), but agent-configured stop sequences must
      // still be honored — channels already plumb these via formatMessages.
      MessageFormatter.collectStoppingStrings(agent, agent.instructTemplate, agent.contextFormatting),
      {
        activeTools: activeToolsFn,
        // Sticky pin: keep this chat on the OpenRouter backend that served its
        // last agent turn (prompt-cache continuity).
        preferredProvider: resolveStickyProvider(chat.messages, agent.provider),
      }
    )) {
      if (typeof event === 'object' && event !== null && 'type' in event && event.type === 'response-messages') {
        capturedResponseMessages = (event as { messages: unknown[] }).messages;
        continue; // backend-only; don't feed to UI builder or renderer
      }
      if (typeof event === 'object' && event !== null && 'type' in event && event.type === 'provider-metadata') {
        const e = event as { servedProvider?: string; cost?: number; cachedTokens?: number; cacheWriteTokens?: number };
        if (e.servedProvider) streamMetrics.servedProvider = e.servedProvider;
        if (typeof e.cachedTokens === 'number') streamMetrics.cachedTokens = e.cachedTokens;
        if (typeof e.cacheWriteTokens === 'number') streamMetrics.cacheWriteTokens = e.cacheWriteTokens;
        if (typeof e.cost === 'number') orReportedCost = e.cost;
        continue; // backend-only signal
      }
      if (typeof event === 'object' && event !== null && 'type' in event && event.type === 'tool-approval-request') {
        const e = event as { approvalId: string; toolCallId: string; toolName: string; input: unknown };
        pendingApprovals.push({
          approvalId: e.approvalId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          input: e.input,
        });
      }
      builder.handleEvent(event);
      routeStreamEvent(event, agent.id, mainWindow, streamMetrics, 'content', envelope);
    }

    const timeToComplete = Date.now() - startTime;
    streamMetrics.timeToComplete = timeToComplete;
    streamMetrics.model = agent.model;
    streamMetrics.provider = agent.provider;

    // Surface a hard output-limit truncation so a cut-off reply isn't silently
    // presented as complete (field data: recurring mid-sentence cut-offs).
    if (streamMetrics.finishReason === 'length') {
      builder.addSystemNote(
        '⚠️ This reply was cut off at the output-token limit. Increase "Max Output Tokens" on this agent to allow longer responses.'
      );
    }

    // Attach context budget info for UI transparency
    streamMetrics.requestInfo = buildRequestInfo({
      budget,
      systemPrompt: effectiveSystemPrompt,
      messagesTotal: messages.length,
      messagesSent: windowedMessages.length,
      activeToolNames,
      includeSystemPrompt: agent.debugLogging,
    });

    // Prefer OpenRouter's real reported cost (usage accounting); otherwise
    // estimate from token usage (agent-level pricing overrides built-in table).
    if (typeof orReportedCost === 'number') {
      streamMetrics.cost = orReportedCost;
      streamMetrics.costBasis = 'reported';
    } else {
      const cost = calculateCost(
        agent.provider,
        agent.model,
        streamMetrics.inputTokens,
        streamMetrics.outputTokens,
        { promptCostPer1M: agent.promptCostPer1M, completionCostPer1M: agent.completionCostPer1M },
        // Cache tiers, so a warm turn is not billed as if every cached token
        // were fresh input.
        { cachedTokens: streamMetrics.cachedTokens, cacheWriteTokens: streamMetrics.cacheWriteTokens },
      );
      if (cost !== null) {
        streamMetrics.cost = cost;
        streamMetrics.costBasis = 'estimated';
      }
    }

    // A genuinely-empty generation (no text, no tool cards, nothing pending) —
    // the model returned nothing (field data: finishReason 'unknown', 0 tokens).
    // Chats persist a row per turn (pinned contract), so instead of a bare
    // "(no response)" bubble, surface a system note explaining it. Display-only:
    // the model-facing record is responseMessages/content, so this isn't replayed.
    if (
      request.persistence === 'chat-assistant' &&
      !builder.getFullText().trim() &&
      builder.getContentBlocks().length === 0 &&
      pendingApprovals.length === 0
    ) {
      builder.addSystemNote(
        '⚠️ The model returned an empty response — usually a provider hiccup. Try sending again.'
      );
    }

    const contentBlocks = builder.getContentBlocks();
    const fullText = builder.getFullText();

    logger.info('[AgentTurnService] AI stream complete', {
      responseLength: fullText.length,
      contentBlockCount: contentBlocks.length,
      metrics: streamMetrics
    });

    emitStreamComplete(agent.id, fullText.length, messages.length, streamMetrics, envelope);
    emitAgentSpend(agent, streamMetrics, { kind: envelope.context, containerId: envelope.containerId });

    // An abort does not always throw: the SDK can surface it as an in-band
    // error part, which ai.ts yields and the builder records, so the loop above
    // exits normally and this path used to report a stopped turn as a clean
    // success. Both channel policies already guard on the signal after their
    // stream (see runChannelBroadcastTurn / runChannelSelectedTurn); the chat
    // policy never did, so pressing Stop reported success and no chat:aborted
    // ever fired for a 1:1 chat.
    //
    // The partial reply is still persisted below — stopping a turn should keep
    // what was already said, not discard it. Only the *status* changes, so
    // callers can tell "finished" from "stopped".
    const wasAborted = abortSignal.aborted;
    if (wasAborted) {
      logger.info('[AgentTurnService] Chat turn aborted post-stream', { chatId, agentId: agent.id });
      emitStreamAborted(agent.id, envelope);
    }

    const agentMessage = chatRepo.createDirectMessage({
      chatId,
      senderId: agentId,
      senderType: 'agent',
      senderDisplayName: agent.name,
      senderColor: agent.color,
      metadata: { participantType: 'agent' },
      // Empty string is fine: the renderer falls through to contentBlocks
      // (tool-call cards) when present, and shows a subtle "(no response)"
      // hint when both are empty. Don't poison the persisted text with a
      // bracketed placeholder that the next turn would replay back to the
      // model as if the assistant had spoken those literal words.
      content: fullText,
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      toolCalls: builder.getLegacyToolCalls(),
      // Persist SDK-shape so next turn's history rebuild gives the model an
      // accurate record of this turn's tool calls + results.
      responseMessages: capturedResponseMessages,
      timestamp: Date.now(),
      metrics: streamMetrics,
      parentMessageId: parentForReply ?? undefined,
      branchIndex: branchIndexForReply,
    });

    // Register pending approvals against the message we just persisted —
    // the resume IPC handler keys off these to rebuild messages and
    // re-stream once the user decides.
    if (pendingApprovals.length > 0) {
      const registry = getPendingApprovalRegistry();
      for (const a of pendingApprovals) {
        registry.register({
          approvalId: a.approvalId,
          toolCallId: a.toolCallId,
          toolName: a.toolName,
          input: a.input,
          context: 'chat',
          contextId: chatId,
          agentId,
          messageId: agentMessage.id,
        });
      }

      // A work session is off to the side by design, so a pending approval in
      // one is invisible unless it is announced where somebody is looking.
      // No-ops for ordinary chats and for sessions with no parent channel.
      if (chatRepo.isWorkSession(chatId)) {
        reportSessionBlocked(chatId, pendingApprovals.map(a => a.toolName), mainWindow);
      }
    }

    emitStreamSentinel(mainWindow, 'end', envelope);

    return {
      turnId: envelope.turnId,
      status: wasAborted ? 'aborted' : 'completed',
      message: agentMessage,
      response: fullText,
      contentBlocks,
      metrics: streamMetrics,
      pendingApprovals: pendingApprovals.length > 0 ? pendingApprovals : undefined,
    };
  } catch (error: any) {

    const mainWindow = deps.getMainWindow();

    if (error.name === 'AbortError' || error.message?.includes('aborted') || error.message?.includes('terminated')) {
      logger.info('[AgentTurnService] Stream was aborted', { error: error.message });
      emitStreamSentinel(mainWindow, 'end', envelope);
      // Bus consumers need a terminal event or they wait forever — the
      // renderer gets stream:end, but nothing on the bus said this turn is
      // over (see emitStreamAborted).
      emitStreamAborted(agent.id, envelope);
      return {
        turnId: envelope.turnId,
        status: 'aborted',
        response: builder.getFullText(),
        contentBlocks: builder.getContentBlocks(),
        metrics: streamMetrics,
      };
    }

    logger.error('[AgentTurnService] Chat error:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Save any partial content accumulated before the error. Persist even
    // when nothing streamed — otherwise a connection failure leaves no
    // trace in the chat and the turn just silently vanishes.
    const contentBlocks = builder.getContentBlocks();
    const fullText = builder.getFullText();
    const errorMessage = friendlyAIErrorMessage(error, agent.provider);

    // Append error notice to content blocks
    const blocksWithError = [
      ...contentBlocks,
      { type: 'system' as const, content: `Error: ${errorMessage}`, timestamp: Date.now() },
    ];
    const textWithError = fullText.trim()
      ? fullText + `\n\n[Error: ${errorMessage}]`
      : `[Error: ${errorMessage}]`;

    chatRepo.createDirectMessage({
      chatId,
      senderId: agentId,
      senderType: 'agent',
      senderDisplayName: agent.name,
      senderColor: agent.color,
      metadata: { participantType: 'agent' },
      content: textWithError,
      contentBlocks: blocksWithError,
      toolCalls: builder.getLegacyToolCalls(),
      timestamp: Date.now(),
      metrics: streamMetrics,
      parentMessageId: parentForReply ?? undefined,
      branchIndex: branchIndexForReply,
    });

    logger.info('[AgentTurnService] Saved partial response before error', {
      contentBlockCount: contentBlocks.length,
      textLength: fullText.length,
    });

    // Send error to renderer so the user sees it
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
      containerId: envelope.containerId,
      context: envelope.context,
      turnId: envelope.turnId,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    });

    return {
      turnId: envelope.turnId,
      status: 'error',
      errorMessage,
      response: fullText,
      contentBlocks,
      metrics: streamMetrics,
    };
  } finally {
    // Only per-turn (user-configured) servers are in here. The auto-injected
    // filesystem servers are pooled for the process lifetime and owned by
    // connectMCPServers, which keeps them out of this list precisely so closing
    // a turn does not kill a server other turns are still using.
    const { disconnectMCPClients } = await import('./mcp');
    disconnectMCPClients(mcpClients);
  }
}

// ─── Channel behavior note ───────────────────────────────────────

/**
 * Build the participant note for the system prompt based on the agent's channel behavior.
 */
export function buildChannelBehaviorNote(agent: Agent, behavior: ChannelBehavior): string {
  const lines = [
    `This is a multi-participant conversation. Messages from other participants are prefixed with [Name]:. Your own prior responses have no prefix. You are ${agent.name}.`,
  ];

  if (behavior.respondTo === 'mentions-only') {
    lines.push('You were @mentioned in this channel. Respond to the mention directly and concisely.');
  }

  if (behavior.verbosity === 'brief') {
    lines.push('IMPORTANT: Keep your response brief (1-3 sentences). Be concise and avoid unnecessary elaboration. Only provide detailed responses when explicitly asked.');
  } else if (behavior.verbosity === 'normal') {
    lines.push('Respond at a normal conversational length. Avoid overly long responses.');
  }
  // 'verbose' — no constraint

  lines.push('To @mention another agent in this channel, just write @TheirName naturally in your response text. Do NOT use the channel_send_message tool for this — that tool is only for posting in a different channel.');

  return lines.join('\n');
}
