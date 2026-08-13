import { BrowserWindow } from 'electron';
import { eventBus } from './EventBus';
import { logger } from './logger';
import { friendlyAIErrorMessage } from '../utils/aiErrors';
import { runAgentTurn } from './AgentTurnService';
import { getChannelRepository, getAgentRepository, getSettingsRepository, getProjectRepository } from '../repositories';
import type { ToolSessionState } from './discoveryTools';
import type { Message } from '../types';
import { DEFAULT_CHANNEL_BEHAVIOR } from '../types';
import { parseMentions } from '../utils/mentions';

// Re-export for approvalResume's import path: the implementation lives in the
// turn core, alongside the system-prompt assembly it feeds.
export { buildChannelBehaviorNote } from './AgentTurnService';

/**
 * ChannelDispatcher runs channel agent turns from explicit dispatch intents
 * (ADR-001 Decision 2): producers call requestDispatch after persisting the
 * triggering message. The EventBus carries storage events only — nothing on
 * the bus can start a turn; the dispatcher's remaining subscriptions just
 * forward lifecycle events to the renderer.
 *
 * Loop accounting: chainDepth travels in the intent (advances only through
 * chained intents), MAX_CHAIN_DEPTH is the hard stop. Cooldown and
 * active-dispatch guards are backstops that warn when they fire — under
 * explicit intents they should only trigger on genuine agent-to-agent loops.
 */

const MAX_CHAIN_DEPTH = 3;
const DISPATCH_COOLDOWN_MS = 2000;

/**
 * An explicit "run agent turns in response to this message" command
 * (ADR-001 Decision 2). Produced by:
 *  - 'send-message' after persisting the human message (selected sends set
 *    addressedAgentId — suppression is a property of the intent, the
 *    persisted metadata copy is observability-only);
 *  - dispatchSelectedAgent after finalizing a reply (chained, depth+1);
 *  - channel_send_message after its persist (via requestChannelDispatch).
 */
export interface DispatchIntent {
  channelId: string;
  /** Message that provoked this intent — parents replies and error notices. */
  triggerMessageId: string;
  /** Text @mentions are resolved against. */
  triggerContent: string;
  senderId: string;
  senderType: 'human' | 'agent';
  /** Hops from the originating send; advances only through chained intents. */
  chainDepth: number;
  /**
   * Selected-agent send: suppresses respondTo:'all' for this message and
   * excludes the addressed agent (its single turn runs via
   * dispatchSelectedAgent). Explicit @mentions of other agents still resolve.
   */
  addressedAgentId?: string;
}

export class ChannelDispatcher {
  private activeDispatches = new Set<string>();
  private lastDispatchTime = new Map<string, number>();
  private toolStates = new Map<string, ToolSessionState>();
  private getMainWindow: () => BrowserWindow | null;
  // Captured event-bus unsubscribe fns so stop() can detach cleanly. Without
  // them the dispatcher would keep handlers alive past app-quit, which is
  // harmless in practice (the process is dying) but trips the resource-cleanup
  // audit and leaves a footgun if anything ever calls start() twice.
  private cleanups: Array<() => void> = [];

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
  }

  start(): void {
    // Deliberately NO message:created / message:updated subscriptions:
    // repository storage events never start a turn (ADR-001 Decision 3 —
    // this also closes the forged-event dispatch chain from #39). Dispatch
    // happens only through requestDispatch / dispatchSelectedAgent.
    // Forward lifecycle events to the renderer so the UI refreshes
    // when agents create/modify data via tools
    const forwardToRenderer = (ipcChannel: string) => () => {
      const win = this.getMainWindow();
      if (win) win.webContents.send(ipcChannel);
    };
    this.cleanups.push(eventBus.onEvent('channel:created', forwardToRenderer('channels-changed')));
    this.cleanups.push(eventBus.onEvent('channel:updated', forwardToRenderer('channels-changed')));
    this.cleanups.push(eventBus.onEvent('agent:created', forwardToRenderer('agents-changed')));
    this.cleanups.push(eventBus.onEvent('agent:updated', forwardToRenderer('agents-changed')));
    this.cleanups.push(eventBus.onEvent('agent:deleted', forwardToRenderer('agents-changed')));
    this.cleanups.push(eventBus.onEvent('task:created', forwardToRenderer('project-data-changed')));
    this.cleanups.push(eventBus.onEvent('task:toggled', forwardToRenderer('project-data-changed')));
    this.cleanups.push(eventBus.onEvent('task:deleted', forwardToRenderer('project-data-changed')));
    this.cleanups.push(eventBus.onEvent('note:created', forwardToRenderer('project-data-changed')));
    this.cleanups.push(eventBus.onEvent('note:deleted', forwardToRenderer('project-data-changed')));

    logger.info('[ChannelDispatcher] Started — awaiting dispatch intents');
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.activeDispatches.clear();
    this.lastDispatchTime.clear();
    logger.info('[ChannelDispatcher] Stopped');
  }

  /**
   * Drop the dispatcher's in-memory session state for a deleted channel so
   * the Map doesn't grow without bound. The persisted tool_session_states
   * row is cleared at the IPC layer alongside this — see clearChannelState
   * in src/main/ipc/channels.ts.
   */
  clearChannelState(channelId: string): void {
    this.toolStates.delete(channelId);
  }

  /**
   * Run agent turns for an explicit dispatch intent: resolve targets
   * (@mentions + respondTo:'all', minus intent-shape suppression), apply the
   * backstop guards, and dispatch sequentially. Per-agent failures persist an
   * in-channel error notice; requestDispatch itself never throws for them.
   */
  async requestDispatch(intent: DispatchIntent): Promise<void> {
    if (intent.chainDepth >= MAX_CHAIN_DEPTH) {
      logger.warn('[ChannelDispatcher] Max chain depth reached', {
        channelId: intent.channelId, depth: intent.chainDepth, messageId: intent.triggerMessageId,
      });
      return;
    }

    // Build candidate agent set: @mentioned agents + respondTo:'all' agents
    const candidateAgentIds = this.resolveDispatchTargets(intent.triggerContent, intent.channelId, intent.addressedAgentId);
    if (candidateAgentIds.length === 0) return;

    // Dispatch each candidate agent sequentially
    for (const agentId of candidateAgentIds) {
      // Don't self-trigger
      if (agentId === intent.senderId) continue;

      const dispatchKey = `${intent.channelId}:${agentId}`;

      // Backstop guards (ADR-001 Decision 4): with explicit intents these
      // should only fire under genuine agent-to-agent loops — warn so a
      // wrong intent graph is visible instead of silently swallowed.
      if (this.activeDispatches.has(dispatchKey)) {
        logger.warn('[ChannelDispatcher] Backstop: dispatch already in flight, skipping', {
          dispatchKey, triggerMessageId: intent.triggerMessageId,
        });
        continue;
      }
      const lastTime = this.lastDispatchTime.get(dispatchKey) || 0;
      if (Date.now() - lastTime < DISPATCH_COOLDOWN_MS) {
        logger.warn('[ChannelDispatcher] Backstop: cooldown active, skipping', {
          dispatchKey, triggerMessageId: intent.triggerMessageId,
        });
        continue;
      }

      try {
        await this.dispatchAgentResponse(intent.channelId, agentId, intent.triggerMessageId);
      } catch (error) {
        logger.error('[ChannelDispatcher] Dispatch failed', {
          channelId: intent.channelId, agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.persistDispatchError(intent.channelId, agentId, intent.triggerMessageId, error);
      }
    }
  }

  /**
   * Surface a failed dispatch in the channel itself. Without this the
   * @mentioned agent just never answers and the only trace is a main-process
   * log line. The notice is terminal because this path chains no dispatch
   * intent; the dispatchedBy metadata it carries is for observability only.
   */
  private persistDispatchError(channelId: string, agentId: string, triggerMessageId: string, error: unknown): Message | null {
    try {
      const agent = getAgentRepository().getById(agentId);
      if (!agent) return null;
      const message = friendlyAIErrorMessage(error, agent.provider);
      return getChannelRepository().createMessage({
        channelId,
        senderId: agentId,
        senderType: 'agent',
        senderDisplayName: agent.name,
        senderColor: agent.color,
        metadata: {
          participantType: 'agent',
          dispatchedBy: 'channel-dispatcher',
          parentDispatchMessageId: triggerMessageId,
        },
        content: `[Error: ${message}]`,
        contentBlocks: [{ type: 'system', content: `Error: ${message}`, timestamp: Date.now() }],
        timestamp: Date.now(),
      });
    } catch (persistError) {
      logger.error('[ChannelDispatcher] Failed to persist dispatch error', {
        channelId, agentId,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
      return null;
    }
  }

  /**
   * Resolve which agents should respond to this message:
   * - Agents explicitly @mentioned by name
   * - Agents with respondTo:'all' who are participants in this channel
   *
   * An addressed (selected-agent) send suppresses the respondTo:'all' set
   * entirely and excludes the addressed agent, so it gets exactly one turn.
   */
  private resolveDispatchTargets(content: string, channelId: string, addressedAgentId?: string): string[] {
    const channelRepo = getChannelRepository();
    const channel = channelRepo.getById(channelId, { includeMessages: false });
    if (!channel) return [];

    const agentRepo = getAgentRepository();
    const agentParticipants = channel.participants.filter(p => p.type === 'agent');
    const targetIds = new Set<string>();

    // 1. Parse @mentions against the actual participant names.
    const mentioned = parseMentions(content, agentParticipants.map(p => p.displayName));
    for (const name of mentioned) {
      const participant = agentParticipants.find(p => p.displayName === name);
      if (participant) {
        targetIds.add(participant.id);
      }
    }

    // 2. Add respondTo:'all' agents — unless this message is addressed to a
    // selected agent, which is an explicit target and suppresses broadcast.
    if (!addressedAgentId) {
      for (const participant of agentParticipants) {
        const agent = agentRepo.getById(participant.id);
        if (agent?.channelBehavior?.respondTo === 'all') {
          targetIds.add(participant.id);
        }
      }
    }

    if (addressedAgentId) {
      targetIds.delete(addressedAgentId);
    }

    return [...targetIds];
  }

  /**
   * Resolve the shared context a channel turn needs (agent, settings,
   * project via channel.projectId → current UI project fallback). Returns
   * null after a warn when channel/agent are missing — the pinned
   * no-error-notice shape for missing context.
   */
  private resolveTurnContext(channelId: string, agentId: string, logLabel: string) {
    const channelRepo = getChannelRepository();
    const agentRepo = getAgentRepository();
    const settingsRepo = getSettingsRepository();
    const projectRepo = getProjectRepository();

    const channel = channelRepo.getById(channelId, { includeMessages: false });
    const agent = agentRepo.getById(agentId);
    const settings = settingsRepo.get();

    if (!channel || !agent) {
      logger.warn(`[ChannelDispatcher] Missing context for ${logLabel}`, {
        hasChannel: !!channel, hasAgent: !!agent,
      });
      return null;
    }

    // Resolve project: prefer channel's own project, fall back to current UI project
    const currentState = settingsRepo.getCurrentState();
    const projectId = channel.projectId || currentState.projectId;
    const project = projectId ? projectRepo.getById(projectId) : null;

    return { channel, agent, settings, project, currentState };
  }

  /**
   * Server-side selected-agent turn: a human channel send explicitly addressed
   * to one agent. The turn itself — draft announce, live stream, finalize,
   * empty/abort draft deletion — runs in the turn core ('channel-selected'
   * policy). The reply is not terminal: this method (the finalizing
   * orchestrator) produces a chained intent for @mentions in the finalized
   * reply, parented to the reply id.
   */
  async dispatchSelectedAgent(
    channelId: string,
    agentId: string,
    triggerMessageId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const dispatchKey = `${channelId}:${agentId}`;
    // Share the broadcast path's guard keys: mention/respondTo dispatches for
    // this agent skip while the selected turn is in flight, and the cooldown
    // window starts when it settles. The selected turn itself is never gated —
    // an explicit human send must not be dropped.
    this.activeDispatches.add(dispatchKey);
    try {
      const ctx = this.resolveTurnContext(channelId, agentId, 'selected-agent turn');
      if (!ctx) return;
      if (!ctx.project) {
        throw new Error('No active project');
      }

      const result = await runAgentTurn({
        context: 'channel',
        containerId: channelId,
        agent: ctx.agent,
        project: ctx.project,
        settings: ctx.settings,
        trigger: { messageId: triggerMessageId },
        persistence: 'channel-selected',
        abortSignal: abortSignal ?? new AbortController().signal,
      }, {
        getMainWindow: this.getMainWindow,
        toolStates: this.toolStates,
      });

      // Chained intent (ADR-001): @mentions in the finalized reply reach
      // dispatch only because this finalizing orchestrator produces the intent
      // directly — the repository's storage events cannot. Selected sends are
      // human-originated (depth 0), so the reply is one hop. Fire-and-forget:
      // the send must not wait on downstream turns, and self-mentions are
      // skipped inside requestDispatch.
      if (result.status === 'completed' && result.message) {
        void this.requestDispatch({
          channelId,
          triggerMessageId: result.message.id,
          triggerContent: result.response,
          senderId: agentId,
          senderType: 'agent',
          chainDepth: 1,
        }).catch((error) => {
          logger.error('[ChannelDispatcher] Chained dispatch failed', {
            channelId, agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as Error)?.name === 'AbortError' || message.includes('aborted') || message.includes('terminated')) {
        logger.info('[ChannelDispatcher] Selected-agent turn aborted', { channelId, agentId });
        return;
      }
      logger.error('[ChannelDispatcher] Selected-agent turn failed', { channelId, agentId, error: message });
      const notice = this.persistDispatchError(channelId, agentId, triggerMessageId, error);
      // Push the notice so the renderer gets a terminal signal — without it
      // the send stays in its loading state until the user hits Stop.
      const win = this.getMainWindow();
      if (notice && win) {
        win.webContents.send('channel-message-added', { channelId, message: notice });
      }
    } finally {
      this.activeDispatches.delete(dispatchKey);
      this.lastDispatchTime.set(dispatchKey, Date.now());
    }
  }

  /**
   * Broadcast dispatch for a triggered agent (@mention / respondTo:'all').
   * The turn core ('channel-broadcast' policy) persists the terminal reply
   * and pushes it; errors propagate to requestDispatch's error-notice path.
   */
  private async dispatchAgentResponse(channelId: string, agentId: string, triggerMessageId: string): Promise<void> {
    const dispatchKey = `${channelId}:${agentId}`;
    this.activeDispatches.add(dispatchKey);

    try {
      // Close any approval the conversation walked away from — an unresolved
      // approval strands its tool-call with no result and locks the channel on
      // every send. Best-effort; never blocks the turn.
      try {
        const { closeSupersededApprovals } = await import('./approvalResume');
        await closeSupersededApprovals('channel', channelId);
      } catch (err) {
        logger.warn('[ChannelDispatcher] closeSupersededApprovals failed', {
          channelId, error: err instanceof Error ? err.message : String(err),
        });
      }

      const ctx = this.resolveTurnContext(channelId, agentId, 'dispatch');
      if (!ctx) return;

      if (!ctx.project) {
        logger.warn('[ChannelDispatcher] No project context for dispatch', {
          channelId, channelProjectId: ctx.channel.projectId, currentProjectId: ctx.currentState.projectId,
        });
        return;
      }

      logger.info('[ChannelDispatcher] Dispatching agent response', {
        channelId, agentId, agentName: ctx.agent.name,
        behavior: ctx.agent.channelBehavior || DEFAULT_CHANNEL_BEHAVIOR,
      });

      await runAgentTurn({
        context: 'channel',
        containerId: channelId,
        agent: ctx.agent,
        project: ctx.project,
        settings: ctx.settings,
        trigger: { messageId: triggerMessageId },
        persistence: 'channel-broadcast',
        abortSignal: new AbortController().signal,
      }, {
        getMainWindow: this.getMainWindow,
        toolStates: this.toolStates,
      });
    } finally {
      this.activeDispatches.delete(dispatchKey);
      this.lastDispatchTime.set(dispatchKey, Date.now());
    }
  }
}

// Singleton
let _dispatcher: ChannelDispatcher | null = null;

// Module-private accessor so the channels IPC layer can clear the
// dispatcher's per-channel session state from outside the class without
// holding the singleton itself.
export function clearChannelDispatcherState(channelId: string): void {
  _dispatcher?.clearChannelState(channelId);
}

/**
 * Intent sink for producers that can't import the singleton accessor without
 * a module cycle (channelTools ← chatHelpers ← AgentTurnService ← this file).
 * No-op before the dispatcher exists — nothing can legitimately produce an
 * intent before main.ts starts it.
 */
export function requestChannelDispatch(intent: DispatchIntent): void {
  void _dispatcher?.requestDispatch(intent).catch((error) => {
    logger.error('[ChannelDispatcher] requestDispatch failed', {
      channelId: intent.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function getChannelDispatcher(getMainWindow: () => BrowserWindow | null): ChannelDispatcher {
  if (!_dispatcher) {
    _dispatcher = new ChannelDispatcher(getMainWindow);
  }
  return _dispatcher;
}
