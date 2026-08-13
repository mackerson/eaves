import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { logger } from './logger';
import type { ModelMessage } from 'ai';
import {
  getChannelRepository,
  getAgentRepository,
  getSettingsRepository,
  getProjectRepository,
} from '../repositories';
import { buildToolset, buildSystemPrompt, activeToolsFor, runStream, buildRequestInfo, systemPromptPlumbing } from '../ipc/chatHelpers';
import { buildRoleplayNote } from '../utils/buildRoleplayNote';
import { buildChannelBehaviorNote } from './ChannelDispatcher';
import { DEFAULT_CHANNEL_BEHAVIOR } from '../types';
import { perspectiveShiftMessages } from '../utils/perspectiveShift';
import { sanitizeResponseMessagesForReplay } from '../utils/sanitizeResponseMessages';
import { emitCompaction, emitStreamSentinel, type StreamEnvelope } from './streamEventRouter';
import { assembleReplayHistory } from './replayHistory';
import { scanTurnFailures, failureSection } from './replayProjection';
import { summarySection } from './compaction';
import { resolveTurnBudget, type ContextBudget } from './contextBudget';
import type { ContentBlock, ToolApprovalState } from '../../shared/types';
import type { ToolSessionState } from './discoveryTools';
import {
  getPendingApprovalRegistry,
  type PendingApprovalEntry,
} from './PendingApprovalRegistry';

/**
 * Resume a streamText call after the user approved or denied a tool call.
 *
 * The pattern is straight out of the AI SDK v6 HITL docs:
 *   1. Rebuild the messages array exactly as we sent it on the original turn.
 *   2. Append the tool message carrying the approval response part.
 *   3. Re-call streamText. If approved, the SDK runs `execute` and continues
 *      the model. If denied, the SDK emits `tool-output-denied` and the model
 *      continues without ever running the tool.
 *
 * The re-stream is driven by the turn core's stream stage (`runStream`,
 * ADR-001) — event routing, metrics/cost, response-message capture, and
 * chained-approval collection live there. This module owns only what is
 * resume-specific: rebuilding the prior turn, injecting the
 * tool-approval-response, and persisting the continuation tagged
 * `resumedFromApproval`.
 *
 * The continuation is saved as a NEW assistant message so chronology stays
 * clean, and the original message's `tool-approval` contentBlock is updated
 * in place to reflect the decision (status: approved/denied + decisionAt + reason).
 */

interface AssistantContentPart {
  type?: string;
  toolCallId?: string;
  approvalId?: string;
  [k: string]: unknown;
}

/**
 * Walk a ResponseMessage[] and ensure the assistant message containing
 * `toolCallId` carries a `tool-approval-request` content part bound to
 * `approvalId`. The SDK validator uses these to map approval-response →
 * tool-call; missing the link causes AI_MissingToolResultsError.
 *
 * Returns a shallow-cloned array; the originals stay untouched (we don't
 * mutate persisted history).
 */
function injectApprovalRequestPart(
  messages: unknown[],
  toolCallId: string,
  approvalId: string,
): unknown[] {
  return messages.map(m => {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) return m;

    const parts = msg.content as AssistantContentPart[];
    const hasMatchingCall = parts.some(p => p?.type === 'tool-call' && p.toolCallId === toolCallId);
    if (!hasMatchingCall) return m;

    const alreadyHasRequest = parts.some(
      p => p?.type === 'tool-approval-request' && p.approvalId === approvalId && p.toolCallId === toolCallId,
    );
    if (alreadyHasRequest) return m;

    return {
      ...msg,
      content: [
        ...parts,
        { type: 'tool-approval-request', approvalId, toolCallId },
      ],
    };
  });
}

interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  decidedBy: string;
}

interface ApprovalResumeOptions {
  approvalId: string;
  decision: ApprovalDecision;
  /** Live registry entry, if still in-memory. May be undefined after restart. */
  registryEntry?: PendingApprovalEntry;
  /** Fallback context when registry is empty. Required if registryEntry is undefined. */
  fallbackContext?: { context: 'chat' | 'channel'; contextId: string; agentId: string; messageId: string };
  getMainWindow: () => BrowserWindow | null;
  /** Tool-state map shared across an IPC scope (chat or channel). */
  toolStates: Map<string, ToolSessionState>;
}

/**
 * Decide one approval. Kept as the single-item form of the batch path below —
 * one implementation, so the two cannot drift.
 */
export async function resumeAfterApproval(opts: ApprovalResumeOptions): Promise<{ success: boolean; error?: string }> {
  return resumeAfterApprovals({
    decisions: [{ approvalId: opts.approvalId, decision: opts.decision, registryEntry: opts.registryEntry }],
    fallbackContext: opts.fallbackContext,
    getMainWindow: opts.getMainWindow,
    toolStates: opts.toolStates,
  });
}

export interface ApprovalBatchDecision {
  approvalId: string;
  decision: ApprovalDecision;
  registryEntry?: PendingApprovalEntry;
}

export interface ApprovalBatchOptions {
  decisions: ApprovalBatchDecision[];
  fallbackContext?: { context: 'chat' | 'channel'; contextId: string; agentId: string; messageId: string };
  getMainWindow: () => BrowserWindow | null;
  toolStates: Map<string, ToolSessionState>;
}

/**
 * Decide several approvals from the same turn and resume ONCE.
 *
 * Deciding them one at a time is what made parallel approvals fragile: each
 * resume ran one tool and persisted its result on its own row, leaving the
 * shared assistant message's calls answered non-adjacently — the shape that
 * wedged a beta conversation (see sanitizeResponseMessages). Answering them
 * together sidesteps that entirely: one rebuilt history, one tool message
 * carrying every approval-response, one stream, one continuation row.
 *
 * All decisions must belong to the same conversation and agent; a batch that
 * spans turns has no single history to rebuild.
 */
export async function resumeAfterApprovals(opts: ApprovalBatchOptions): Promise<{ success: boolean; error?: string }> {
  const { decisions, fallbackContext, getMainWindow, toolStates } = opts;

  if (decisions.length === 0) {
    return { success: false, error: 'No approvals to respond to' };
  }

  // After app restart the in-memory registry is empty, so the renderer hands us
  // a fallbackContext pointing at the persisted message. Reconstruct each entry
  // from the tool-approval contentBlock — it carries the real toolCallId /
  // toolName / input. Without those, injectApprovalRequestPart can't bind the
  // approval-response to a tool-call and the SDK throws AI_MissingToolResultsError.
  const resolved: Array<{ entry: PendingApprovalEntry; decision: ApprovalDecision }> = [];
  for (const d of decisions) {
    const entry = d.registryEntry ?? (fallbackContext
      ? reconstructEntryFromPersistedBlock(d.approvalId, fallbackContext)
      : undefined);
    if (!entry) {
      return {
        success: false,
        error: `Approval ${d.approvalId} not found — it may have been cleared or the message no longer exists`,
      };
    }
    resolved.push({ entry, decision: d.decision });
  }

  // One resume rebuilds one conversation's history. Mixing containers or agents
  // would silently resume against the wrong transcript.
  const first = resolved[0].entry;
  const mismatched = resolved.find(r =>
    r.entry.contextId !== first.contextId ||
    r.entry.agentId !== first.agentId ||
    r.entry.context !== first.context);
  if (mismatched) {
    return {
      success: false,
      error: 'Approvals in a batch must belong to the same conversation and agent',
    };
  }

  const entry = first;
  // Logs and the persisted row reference every decision in the batch, so a
  // continuation can be traced back to what was approved to produce it.
  const approvalIds = resolved.map(r => r.entry.approvalId);
  const approvalLabel = approvalIds.length === 1 ? approvalIds[0] : approvalIds;

  // Step 1: update the contentBlocks on the original message so the UI shows
  // every decision immediately, without waiting for the new stream.
  const decisionWindow = getMainWindow();
  for (const r of resolved) {
    await markApprovalDecided(r.entry, r.decision, decisionWindow);
  }

  // Step 2: build the prior-turn messages array.
  const built = await buildResumeMessages(entry);
  if (!built) {
    return { success: false, error: 'Could not rebuild resume context' };
  }
  const { agent, priorMessages, systemPrompt, toolset } = built;

  // The SDK's convertToLanguageModelPrompt validates that every assistant
  // tool-call has either a tool-result OR an approval-response that resolves
  // back to the tool-call via an approvalId↔toolCallId map. That map is only
  // populated from `tool-approval-request` content parts on assistant
  // messages. Persisted responseMessages from a prior turn may not include
  // that part (depends on the provider's response.messages shape), so we
  // inject it explicitly here using the IDs we already have on the registry
  // entry. Without this the validator throws AI_MissingToolResultsError on
  // the resume request.
  // Sanitize prior history first — drop unbalanced tool-calls / tool-results
  // from earlier turns. preserveCallIds keeps THIS approval's tool-call alive
  // even though it has no tool-result yet (the approval-response will resolve
  // it on the resumed streamText call).
  // Every call in the batch stays alive through sanitizing — each one is
  // resolved by its approval-response below, not by a tool-result.
  const preservedCallIds = new Set(resolved.map(r => r.entry.toolCallId));

  // Siblings from the same assistant message whose approvals are still
  // outstanding. When one call of several is decided on its own — which is
  // what the inline approval card does — the rest are not part of this resume
  // and get a synthesized result. Without this they are described as failures
  // of unknown outcome, and an agent reading that goes looking for a race:
  // re-reading files, re-issuing calls, reasoning about a bug that is not
  // there. They are simply still in the queue, and they are told so.
  const stillPending = new Set(
    getPendingApprovalRegistry()
      .listForContext(entry.context, entry.contextId)
      .filter(p => p.messageId === entry.messageId && !preservedCallIds.has(p.toolCallId))
      .map(p => p.toolCallId),
  );

  const sanitizedPrior = sanitizeResponseMessagesForReplay(
    priorMessages,
    preservedCallIds,
    stillPending,
  );

  // One approval-request part per decided call, so the SDK can map each
  // response back to the call it belongs to.
  const enrichedPriorMessages = resolved.reduce<unknown[]>(
    (messages, r) => injectApprovalRequestPart(messages, r.entry.toolCallId, r.entry.approvalId),
    sanitizedPrior,
  );

  // One tool message carrying every response. This is the whole point of
  // batching: the SDK runs the approved tools together and their results land
  // adjacent to the calls that made them, instead of arriving one resume at a
  // time and stranding each other.
  const approvalMessage: ModelMessage = {
    role: 'tool',
    content: resolved.map(r => ({
      type: 'tool-approval-response',
      approvalId: r.entry.approvalId,
      approved: r.decision.approved,
      ...(r.decision.reason ? { reason: r.decision.reason } : {}),
    })) as never,
  };

  const mainWindow = getMainWindow();

  // ADR-001 additive envelope: every live event this resume turn produces is
  // attributable to its container, same as any other turn.
  const envelope: StreamEnvelope = {
    turnId: randomUUID(),
    agentId: entry.agentId,
    containerId: entry.contextId,
    context: entry.context,
  };

  // Same repair → compact → window → repair → assert pipeline the chat and
  // channel surfaces run. Resume specifically needs the budget stages: without
  // them it re-sends the FULL rebuilt history, so on a small local context
  // window a tool-heavy conversation overflows the server exactly when the
  // user approves a pending call. preserveCallIds keeps this approval's
  // still-unresolved call alive — and exempt from the adjacency invariant,
  // since the SDK resolves it from the approval-response appended below.
  const assembled = await assembleReplayHistory({
    agent,
    containerId: entry.contextId,
    budget: built.budget,
    messages: enrichedPriorMessages,
    preserveCallIds: preservedCallIds,
    onCompacting: (phase) => emitCompaction(mainWindow, phase, envelope),
    source: `resume:${entry.context}`,
  });
  let effectiveSystemPrompt = systemPrompt;
  if (assembled.summary) {
    effectiveSystemPrompt += summarySection(assembled.summary);
  }
  effectiveSystemPrompt += failureSection(built.failures ?? []);
  let windowedPrior = assembled.messages;

  // The approval-response can only resolve against the assistant message that
  // carries this tool-call; if compaction/windowing dropped it (pathological:
  // a single over-budget message after it), force it back in — otherwise the
  // SDK validator throws AI_MissingToolResultsError.
  const carriesCall = (m: unknown): boolean => {
    const msg = m as { role?: string; content?: unknown };
    return msg?.role === 'assistant' && Array.isArray(msg.content) &&
      (msg.content as AssistantContentPart[]).some(p => p?.type === 'tool-call' && p.toolCallId === entry.toolCallId);
  };
  if (!windowedPrior.some(carriesCall)) {
    const callMessage = enrichedPriorMessages.find(carriesCall);
    if (callMessage) {
      windowedPrior = [callMessage as (typeof windowedPrior)[number], ...windowedPrior];
    }
  }

  const messagesForStream = [...windowedPrior, approvalMessage];

  // Step 3: re-stream through the turn core's stream stage. runStream owns
  // event routing (envelope-stamped), metrics/cost, response-message capture,
  // and chained-approval collection. Reuse the same toolset so
  // needsApproval-gated tools still gate on subsequent (unrelated) calls.
  try {
    // Stamped, so a *channel* resume no longer flips the chat surface's busy
    // state on its way past — this path serves both contexts.
    emitStreamSentinel(mainWindow, 'start', envelope);

    // Same active-tool gating as the original turn — a small-window agent must
    // not suddenly receive every tool schema on resume.
    const activeToolsFn = activeToolsFor(toolset, built.budget.sizeClass);

    const result = await runStream({
      agent,
      formattedResult: { messages: messagesForStream, systemPrompt: effectiveSystemPrompt },
      enabledTools: toolset.enabledTools as Record<string, unknown>,
      activeTools: activeToolsFn,
      // Resume exposes no stop/abort surface; hand runStream an inert signal.
      abortSignal: new AbortController().signal,
      mainWindow,
      messageCount: messagesForStream.length,
      envelope,
      // A resume is a real billed request against the same budget as any other
      // turn, and it runs the same compaction/windowing pipeline — without this
      // it was the one turn shape that reported no context telemetry at all.
      // `messagesTotal` counts the prior history plus the approval response,
      // i.e. what would have been sent had nothing been windowed away.
      requestInfo: buildRequestInfo({
        budget: built.budget,
        systemPrompt: effectiveSystemPrompt,
        messagesTotal: enrichedPriorMessages.length + 1,
        messagesSent: messagesForStream.length,
        activeToolNames: activeToolsFn(),
        includeSystemPrompt: agent.debugLogging,
      }),
    });

    if (result.streamError) {
      logger.warn('[approvalResume] Resume turn ended with stream error', {
        approvalIds, error: result.streamError,
      });
    }

    const hasPendingApprovals = (result.pendingApprovals?.length ?? 0) > 0;
    const hasContent = result.response.trim().length > 0 || result.contentBlocks.length > 0;

    if (!hasContent && !hasPendingApprovals) {
      // Empty turns never persist on any path (ADR-001). The decision itself
      // is already recorded on the original message's tool-approval block.
      logger.warn('[approvalResume] Empty resume turn — nothing persisted', { approvalIds });
    } else {
      // Legacy toolCalls mirror — same derivation ContentBlocksBuilder uses.
      const legacyToolCalls = result.contentBlocks
        .filter(b => b.type === 'tool-call')
        .map(b => b.toolCall!)
        .filter(Boolean);

      // Persist continuation as a new assistant message in the same
      // chat/channel. Empty content is fine when tool activity or a pending
      // approval is present — those surface via contentBlocks.
      let newMessageId: string;
      if (entry.context === 'chat') {
        const chatRepo = getChannelRepository();
        const newMsg = chatRepo.createDirectMessage({
          chatId: entry.contextId,
          senderId: entry.agentId,
          senderType: 'agent',
          senderDisplayName: agent.name,
          senderColor: agent.color,
          // Chain onto the prior turn like every other insert path — a NULL
          // parent would lump this row with other root-level messages when
          // branch counts group siblings by parent_message_id.
          parentMessageId: chatRepo.getLatestActiveMessageId(entry.contextId) ?? undefined,
          metadata: { participantType: 'agent', resumedFromApproval: approvalLabel },
          content: result.response,
          contentBlocks: result.contentBlocks.length > 0 ? result.contentBlocks : undefined,
          toolCalls: legacyToolCalls,
          responseMessages: result.responseMessages,
          timestamp: Date.now(),
          metrics: result.metrics,
        });
        newMessageId = newMsg.id;
      } else {
        const channelRepo = getChannelRepository();
        const newMsg = channelRepo.createMessage({
          channelId: entry.contextId,
          senderId: entry.agentId,
          senderType: 'agent',
          senderDisplayName: agent.name,
          senderColor: agent.color,
          metadata: {
            participantType: 'agent',
            dispatchedBy: 'channel-dispatcher',
            resumedFromApproval: approvalLabel,
          },
          content: result.response,
          contentBlocks: result.contentBlocks.length > 0 ? result.contentBlocks : undefined,
          toolCalls: legacyToolCalls,
          responseMessages: result.responseMessages,
          timestamp: Date.now(),
          metrics: result.metrics,
        });
        newMessageId = newMsg.id;
        if (mainWindow) {
          mainWindow.webContents.send('channel-message-added', { channelId: entry.contextId, message: newMsg });
        }
      }

      // Chained approvals: the resumed turn can itself suspend on another
      // needsApproval call — register against the new message so the next
      // approval:respond can resume from it.
      if (hasPendingApprovals && result.pendingApprovals) {
        const registry = getPendingApprovalRegistry();
        for (const a of result.pendingApprovals) {
          registry.register({
            ...a, context: entry.context, contextId: entry.contextId,
            agentId: entry.agentId, messageId: newMessageId,
          });
        }
      }
    }

    emitStreamSentinel(mainWindow, 'end', envelope);

    return { success: true };
  } catch (error) {
    logger.error('[approvalResume] Failed to resume after approval', {
      approvalIds, error: error instanceof Error ? error.message : String(error),
    });
    emitStreamSentinel(mainWindow, 'end', envelope);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface ResumeContext {
  agent: NonNullable<Awaited<ReturnType<ReturnType<typeof getAgentRepository>['getById']>>>;
  project: NonNullable<Awaited<ReturnType<ReturnType<typeof getProjectRepository>['getById']>>>;
  settings: ReturnType<ReturnType<typeof getSettingsRepository>['get']>;
  priorMessages: unknown[];
  systemPrompt: string;
  toolset: Awaited<ReturnType<typeof buildToolset>>;
  budget: ContextBudget;
  channelParticipants?: { id: string; type: string; displayName: string }[];
  /** Turns that failed and never reached the model, reported via the system prompt. */
  failures: string[];
}

async function buildResumeMessages(entry: PendingApprovalEntry): Promise<ResumeContext | null> {
  const agentRepo = getAgentRepository();
  const settingsRepo = getSettingsRepository();
  const projectRepo = getProjectRepository();

  const agent = agentRepo.getById(entry.agentId);
  const settings = settingsRepo.get();
  const currentState = settingsRepo.getCurrentState();

  if (!agent) {
    logger.warn('[approvalResume] Agent missing', { agentId: entry.agentId });
    return null;
  }

  // Warm the live context-window cache before computing the budget — same as
  // every other turn path. Without this, a resume right after app start would
  // fall back to the conservative local-provider default (4096 → tiny class →
  // tools stripped) instead of the server's real loaded window.
  const budget = await resolveTurnBudget(agent);

  if (entry.context === 'chat') {
    const chatRepo = getChannelRepository();
    const chat = chatRepo.getDirectChatById(entry.contextId);
    if (!chat) return null;

    const projectId = currentState.projectId;
    const project = projectId ? projectRepo.getById(projectId) : null;
    if (!project) return null;

    const toolStates = new Map<string, ToolSessionState>();
    const toolset = await buildToolset(agent, project, entry.contextId, toolStates);
    const systemPrompt = await buildSystemPrompt({
      agent, project, settings,
      participants: chat.participants,
      ...systemPromptPlumbing(toolset, budget),
      // Same plumbing ChatService.chatWithAgent uses — without this the
      // resumed turn would lose the in-character framing and persona that
      // were present on the original turn.
      roleplayNote: buildRoleplayNote(agent, chat),
    });

    // Rebuild prior turn messages — same path ChatService takes, prefer
    // SDK-shape responseMessages on agent turns so tool_use_ids match.
    // Failed turns come out here too: resuming an approval is exactly when a
    // thread is likeliest to carry one, since the failure is often what
    // interrupted the approval in the first place.
    const failures = scanTurnFailures(chat.messages);
    const priorMessages: unknown[] = [];
    for (const msg of failures.rows) {
      if (msg.senderType === 'agent' && Array.isArray(msg.responseMessages) && msg.responseMessages.length > 0) {
        for (const m of msg.responseMessages) priorMessages.push(m);
        continue;
      }
      priorMessages.push({
        role: msg.senderType === 'human' ? 'user' : 'assistant',
        content: msg.content || '',
      });
    }

    return { agent, project, settings, priorMessages, systemPrompt, toolset, budget, failures: failures.unresolved };
  }

  // Channel
  const channelRepo = getChannelRepository();
  const channel = channelRepo.getById(entry.contextId, { includeMessages: true, messageLimit: 100 });
  if (!channel) return null;

  const projectId = channel.projectId || currentState.projectId;
  const project = projectId ? projectRepo.getById(projectId) : null;
  if (!project) return null;

  const toolStates = new Map<string, ToolSessionState>();
  const toolset = await buildToolset(agent, project, entry.contextId, toolStates);
  const behavior = agent.channelBehavior || DEFAULT_CHANNEL_BEHAVIOR;
  const systemPrompt = await buildSystemPrompt({
    agent, project, settings,
    participants: channel.participants,
    participantNote: buildChannelBehaviorNote(agent, behavior),
    ...systemPromptPlumbing(toolset, budget),
  });

  // For the resuming agent, prefer SDK-shape responseMessages on its own
  // turns — the tool-call we're approving must keep the exact toolCallId the
  // SDK emitted, so the appended tool-approval-response binds correctly.
  // Other participants get perspective-shifted (flattened to text) since
  // their toolCalls aren't relevant to this agent's resume context.
  const flattenable: { role: 'user' | 'assistant'; content: string; name?: string; toolCalls?: unknown[]; metadata?: Record<string, unknown> }[] = [];
  const priorMessages: unknown[] = [];

  const flushFlattenable = () => {
    if (flattenable.length === 0) return;
    const shifted = perspectiveShiftMessages(flattenable as never, entry.agentId);
    for (const s of shifted) priorMessages.push(s);
    flattenable.length = 0;
  };

  const failures = scanTurnFailures(channel.messages);
  for (const msg of failures.rows) {
    const isOwnAgentTurn =
      msg.senderType === 'agent' &&
      msg.senderId === entry.agentId &&
      Array.isArray(msg.responseMessages) &&
      msg.responseMessages.length > 0;

    if (isOwnAgentTurn) {
      flushFlattenable();
      for (const m of msg.responseMessages!) priorMessages.push(m);
      continue;
    }

    flattenable.push({
      role: msg.senderType === 'human' ? 'user' : 'assistant',
      content: msg.content,
      name: `${msg.senderType}_${msg.senderId}`,
      toolCalls: msg.toolCalls,
      metadata: { senderType: msg.senderType, displayName: msg.senderDisplayName },
    });
  }
  flushFlattenable();

  return {
    agent, project, settings,
    priorMessages,
    systemPrompt,
    toolset,
    budget,
    channelParticipants: channel.participants,
    failures: failures.unresolved,
  };
}

/**
 * Reconstruct a PendingApprovalEntry from the persisted tool-approval contentBlock.
 * Used when the in-memory registry was cleared (e.g. app restart) but the renderer
 * still has the original messageId. The ToolApprovalState on the block carries the
 * authoritative toolCallId / toolName / input the SDK needs to bind the resume.
 */
function reconstructEntryFromPersistedBlock(
  approvalId: string,
  fallbackContext: { context: 'chat' | 'channel'; contextId: string; agentId: string; messageId: string },
): PendingApprovalEntry | undefined {
  const findApproval = (blocks: ContentBlock[] | undefined): ToolApprovalState | undefined => {
    if (!blocks) return undefined;
    for (const b of blocks) {
      if (b.type === 'tool-approval' && b.approval.approvalId === approvalId) {
        return b.approval;
      }
    }
    return undefined;
  };

  let approval: ToolApprovalState | undefined;

  if (fallbackContext.context === 'chat') {
    const chat = getChannelRepository().getDirectChatById(fallbackContext.contextId);
    const msg = chat?.messages.find(m => m.id === fallbackContext.messageId);
    approval = findApproval(msg?.contentBlocks);
  } else {
    const messages = getChannelRepository().getMessagesByChannelId(fallbackContext.contextId);
    const msg = messages.find(m => m.id === fallbackContext.messageId);
    approval = findApproval(msg?.contentBlocks);
  }

  if (!approval) {
    logger.warn('[approvalResume] No tool-approval block found for fallback context', {
      approvalId, ...fallbackContext,
    });
    return undefined;
  }

  return {
    approvalId: approval.approvalId,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    input: approval.input,
    context: fallbackContext.context,
    contextId: fallbackContext.contextId,
    agentId: fallbackContext.agentId,
    messageId: fallbackContext.messageId,
    createdAt: 0,
  };
}

async function markApprovalDecided(
  entry: PendingApprovalEntry,
  decision: ApprovalDecision,
  mainWindow: BrowserWindow | null,
): Promise<void> {
  const updateBlock = (blocks: ContentBlock[] | undefined): ContentBlock[] | undefined => {
    if (!blocks) return blocks;
    return blocks.map(b => {
      if (b.type === 'tool-approval' && b.approval.approvalId === entry.approvalId) {
        const next: ToolApprovalState = {
          ...b.approval,
          status: decision.approved ? 'approved' : 'denied',
          decisionAt: Date.now(),
          decidedBy: decision.decidedBy,
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
        return { ...b, approval: next };
      }
      return b;
    });
  };

  if (entry.context === 'chat') {
    const chatRepo = getChannelRepository();
    const chat = chatRepo.getDirectChatById(entry.contextId);
    const msg = chat?.messages.find(m => m.id === entry.messageId);
    if (!msg) return;
    const updated = updateBlock(msg.contentBlocks);
    if (updated) {
      chatRepo.updateMessage(entry.messageId, { contentBlocks: updated });
      pushDecidedBlocks(mainWindow, entry.messageId, updated);
    }
    return;
  }

  const channelRepo = getChannelRepository();
  const messages = channelRepo.getMessagesByChannelId(entry.contextId);
  const msg = messages.find(m => m.id === entry.messageId);
  if (!msg) return;
  const updated = updateBlock(msg.contentBlocks);
  if (updated) {
    // isDraft stays undefined — deciding an approval is not a draft
    // finalization, and passing false re-emits draftFinalized, which would
    // spuriously re-dispatch @mentions on the original message.
    channelRepo.updateMessageContentBlocks(entry.messageId, updated, msg.content, undefined, msg.metrics, msg.responseMessages);
    pushDecidedBlocks(mainWindow, entry.messageId, updated);
  }
}

/**
 * Tell the renderer the decision landed.
 *
 * Writing the contentBlocks was only ever half of it: the repository write
 * updates the database, and the transcript is rendering from state it already
 * holds. Without a push the card stays "pending" on screen until something
 * unrelated forces a re-render — in practice the end of whatever stream is
 * running, which is exactly when the user is least likely to still be looking.
 * The approval queue looked correct throughout because it refreshes itself on
 * this same event, which is what made the two surfaces disagree.
 *
 * `isDraft` is deliberately absent, for the same reason the write omits it:
 * deciding an approval is not a draft finalization, and claiming otherwise
 * re-emits draftFinalized and re-dispatches the original message's @mentions.
 */
function pushDecidedBlocks(
  mainWindow: BrowserWindow | null,
  messageId: string,
  contentBlocks: ContentBlock[],
): void {
  // Same guard as every other send in this file — a plain null check.
  if (!mainWindow) return;
  mainWindow.webContents.send('message-updated', { messageId, contentBlocks });
}

/**
 * Close tool approvals that were never resolved because the conversation moved
 * on (a new turn started instead of the user approving/denying), clearing the
 * "pending forever" state the UI would otherwise show.
 *
 * The tool-call itself STAYS in the stored responseMessages. It used to be
 * stripped here, because a stranded call with no result locked the thread —
 * but replay now answers an unanswered call rather than deleting it, so the
 * thread is safe either way, and keeping the call is what lets the agent see
 * that it asked to run something the user never acted on.
 *
 * Idempotent (only acts on status:'pending' approvals). Call at the start of a
 * fresh turn.
 */
export async function closeSupersededApprovals(
  context: 'chat' | 'channel',
  contextId: string,
): Promise<number> {
  const repo = getChannelRepository();
  const messages = context === 'chat'
    ? (repo.getDirectChatById(contextId)?.messages ?? [])
    : repo.getMessagesByChannelId(contextId);

  let closed = 0;
  for (const msg of messages) {
    const blocks = msg.contentBlocks;
    if (!Array.isArray(blocks)) continue;
    const pendingIds = new Set<string>();
    for (const b of blocks as ContentBlock[]) {
      if (b.type === 'tool-approval' && b.approval.status === 'pending') {
        pendingIds.add(b.approval.toolCallId);
      }
    }
    if (pendingIds.size === 0) continue;

    // Mark each pending approval denied ('superseded').
    const updatedBlocks = (blocks as ContentBlock[]).map(b => {
      if (b.type === 'tool-approval' && b.approval.status === 'pending') {
        getPendingApprovalRegistry().resolve(b.approval.approvalId);
        closed++;
        const next: ToolApprovalState = {
          ...b.approval,
          status: 'denied',
          decisionAt: Date.now(),
          decidedBy: 'system',
          reason: 'superseded by a new message',
        };
        return { ...b, approval: next };
      }
      return b;
    });

    // Only the now-moot approval-request goes; the tool-call stays so replay
    // can answer it and the agent keeps the record of what it tried to run.
    const rms = Array.isArray(msg.responseMessages) ? (msg.responseMessages as Array<{ role?: string; content?: unknown }>) : [];
    const strippedRms = rms
      .map(rm => {
        if (!Array.isArray(rm.content)) return rm;
        const content = (rm.content as Array<{ type?: string; toolCallId?: string }>).filter(
          p => !(p?.type === 'tool-approval-request'
            && typeof p.toolCallId === 'string' && pendingIds.has(p.toolCallId)),
        );
        return { ...rm, content };
      })
      .filter(rm => !Array.isArray(rm.content) || rm.content.length > 0);

    if (context === 'chat') {
      repo.updateMessage(msg.id, { contentBlocks: updatedBlocks, responseMessages: strippedRms });
    } else {
      repo.updateMessageContentBlocks(msg.id, updatedBlocks, msg.content, undefined, msg.metrics, strippedRms);
    }
  }

  if (closed > 0) {
    logger.info('[approval] closed superseded pending approvals', { context, contextId, closed });
  }
  return closed;
}
