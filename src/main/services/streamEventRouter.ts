import { BrowserWindow } from 'electron';
import { eventBus } from './EventBus';
import { calculateCost } from '../../shared/pricing';
import type { MessageMetrics } from '../../shared/types';

/**
 * The live, in-flight form of `MessageMetrics`.
 *
 * It *extends* the persistable shape rather than restating it, so a field
 * added there is automatically available here and the two cannot drift —
 * which is what happened before: `cacheWriteTokens` lived only on this
 * interface, was written straight into storage by the repository's
 * JSON.stringify, and was declared by neither the persisted type nor its
 * validation schema.
 *
 * The counters are required here because a turn always has them (they start at
 * zero); they stay optional on `MessageMetrics` because an old row may not
 * carry them. Narrowing optional → required is the only difference allowed.
 */
export interface StreamMetrics extends MessageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishReason: string;
  /**
   * True once the SDK's summed whole-turn usage has landed (see trackUsage).
   *
   * Deliberately NOT on `MessageMetrics`: it is bookkeeping for the folding
   * logic and means nothing once the turn ends. It currently rides along into
   * storage as harmless noise, since the repository persists the object as-is.
   */
  usageIsTotal?: boolean;
}

export function createStreamMetrics(): StreamMetrics {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, finishReason: 'unknown' };
}

/**
 * Fold a stream event's accounting into `metrics`. Emits nothing — this is for
 * paths that spend tokens outside the interactive turn core (compaction,
 * workflow agent nodes, note metadata) and so must not push renderer events.
 *
 * `usage-total` wins over `step-finish` when present: step usage is per-step,
 * and the last step of a tool chain is usually a short summarization, so
 * trusting it undercounts every expensive step that preceded it.
 */
export function trackUsage(event: unknown, metrics: StreamMetrics): void {
  if (!event || typeof event !== 'object' || !('type' in event)) return;
  const e = event as {
    type: string;
    finishReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    servedProvider?: string;
    cost?: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
  };

  if (e.type === 'usage-total' && e.usage) {
    metrics.inputTokens = e.usage.inputTokens ?? metrics.inputTokens;
    metrics.outputTokens = e.usage.outputTokens ?? metrics.outputTokens;
    metrics.totalTokens = e.usage.totalTokens ?? metrics.totalTokens;
    metrics.usageIsTotal = true;
    return;
  }

  if (e.type === 'step-finish') {
    if (e.finishReason) metrics.finishReason = e.finishReason;
    // Only a placeholder until usage-total lands — and if the turn dies
    // mid-stream it is the best figure available, so keep the largest step
    // rather than the last one.
    if (e.usage && !metrics.usageIsTotal) {
      metrics.inputTokens = Math.max(metrics.inputTokens, e.usage.inputTokens ?? 0);
      metrics.outputTokens = Math.max(metrics.outputTokens, e.usage.outputTokens ?? 0);
      metrics.totalTokens = Math.max(metrics.totalTokens, e.usage.totalTokens ?? 0);
    }
    return;
  }

  if (e.type === 'provider-metadata') {
    if (e.servedProvider) metrics.servedProvider = e.servedProvider;
    if (typeof e.cachedTokens === 'number') metrics.cachedTokens = e.cachedTokens;
    if (typeof e.cacheWriteTokens === 'number') metrics.cacheWriteTokens = e.cacheWriteTokens;
    if (typeof e.cost === 'number') metrics.cost = e.cost;
  }
}

/**
 * One record per inference, whoever ran it.
 *
 * Cost telemetry used to exist only inside the interactive turn core, so the
 * three paths that call streamAIResponse directly — workflow agent nodes,
 * history compaction, note metadata — spent real money and reported nothing.
 * Unattended, scheduled work was precisely the spend nobody could see, which
 * is the wrong way round.
 *
 * Audience is 'system': one row per inference is the same cardinality as a
 * turn, and quietly doubling the default feed is a curation decision, not a
 * side effect of adding telemetry. The rows exist to be queried by agent.
 */
export function emitAgentSpend(
  agent: { id: string; name: string; provider: string; model: string; promptCostPer1M?: number | null; completionCostPer1M?: number | null },
  metrics: StreamMetrics,
  context: { kind: string; containerId?: string },
): void {
  const cost = typeof metrics.cost === 'number'
    ? metrics.cost
    : calculateCost(agent.provider, agent.model, metrics.inputTokens, metrics.outputTokens, {
      promptCostPer1M: agent.promptCostPer1M ?? undefined,
      completionCostPer1M: agent.completionCostPer1M ?? undefined,
    }) ?? undefined;

  eventBus.emitEvent('agent:spend', {
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    model: agent.model,
    servedProvider: metrics.servedProvider,
    kind: context.kind,
    containerId: context.containerId,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    totalTokens: metrics.totalTokens,
    cachedTokens: metrics.cachedTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    cost,
    // False means the figure is a floor, not a total — the turn ended before
    // the SDK's summed usage arrived. Aggregations must not silently treat
    // the two as equivalent.
    usageIsTotal: metrics.usageIsTotal === true,
    durationMs: metrics.timeToComplete,
  });
}

/**
 * Additive turn envelope (ADR-001 Decision 1): stamped onto every
 * 'chat-stream' event so renderer consumers can attribute concurrent turns
 * to their container. Purely additive — untagged consumers keep working.
 */
export interface StreamEnvelope {
  turnId: string;
  agentId: string;
  containerId: string;
  context: 'chat' | 'channel';
}

/**
 * Route a single stream event to EventBus and renderer.
 * Handles text chunks, tool events, and metrics accumulation.
 */
export function routeStreamEvent(
  event: any,
  agentId: string,
  mainWindow: BrowserWindow | null,
  metrics: StreamMetrics,
  textType: 'text' | 'content' = 'text',
  envelope?: StreamEnvelope,
): void {
  if (typeof event === 'string') {
    // containerId/context ride along so bus consumers can tell *which*
    // conversation a chunk belongs to. Without them a consumer can only match
    // on agentId, which is not a conversation identity — one agent active in
    // two places would have its output cross-fed (see MessagingBridgeService).
    eventBus.emitEvent('chat:stream', {
      agentId,
      chunk: event,
      length: event.length,
      containerId: envelope?.containerId,
      context: envelope?.context,
      turnId: envelope?.turnId,
    });
    if (mainWindow) {
      mainWindow.webContents.send('chat-stream', { type: textType, content: event, ...envelope });
    }
  } else {
    if (event.type === 'tool-call-start') {
      eventBus.emitEvent('tool:call', { agentId, toolName: event.toolName, args: event.args });
    } else if (event.type === 'tool-call-result') {
      eventBus.emitEvent('tool:result', { agentId, toolName: event.toolName, result: event.result });
    } else if (event.type === 'tool-call-error') {
      eventBus.emitEvent('tool:error', { agentId, toolName: event.toolName, error: event.error });
    } else if (event.type === 'step-finish') {
      trackUsage(event, metrics);
    } else if (event.type === 'usage-total') {
      // Backend-only signal; never leak to the renderer IPC.
      trackUsage(event, metrics);
      return;
    } else if (event.type === 'response-messages') {
      // Backend-only signal for persistence; never leak to the renderer IPC.
      return;
    } else if (event.type === 'tool-approval-request') {
      eventBus.emitEvent('tool:approval-request', {
        agentId,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      });
    } else if (event.type === 'tool-output-denied') {
      eventBus.emitEvent('tool:denied', {
        agentId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    } else if (event.type === 'error') {
      // Terminal in-band stream failure — a refused connection, an overloaded
      // provider. The SDK surfaces these as a stream part rather than a throw,
      // so the turn "completes" with an error notice and nothing reached the
      // bus: the commonest way an agent fails was the one failure the activity
      // feed never recorded. Thrown errors take the catch blocks' chat:error
      // instead, so this does not double-report.
      eventBus.emitEvent('chat:error', {
        agentId,
        containerId: envelope?.containerId,
        context: envelope?.context,
        turnId: envelope?.turnId,
        error: {
          message: typeof event.error === 'string' ? event.error : event.error?.message,
        },
      });
    }
    if (mainWindow) {
      mainWindow.webContents.send('chat-stream', envelope ? { ...event, ...envelope } : event);
    }
  }
}

export function emitStreamStart(agentId: string, agent: { name: string; provider: string; model: string }, messageCount: number): void {
  eventBus.emitEvent('chat:start', {
    agentId,
    agentName: agent.name,
    provider: agent.provider,
    model: agent.model,
    messageCount,
  });
}

export function emitStreamComplete(agentId: string, responseLength: number, messageCount: number, metrics: StreamMetrics, envelope?: StreamEnvelope): void {
  eventBus.emitEvent('chat:complete', {
    agentId,
    responseLength,
    messageCount,
    metrics,
    containerId: envelope?.containerId,
    context: envelope?.context,
    turnId: envelope?.turnId,
  });
}

/**
 * Terminal signal for a turn that was cancelled rather than finished — a stop
 * button, or a newer turn for the same chat/agent aborting this one.
 *
 * Bus consumers treat chat:complete/chat:error as the only ways a turn ends,
 * so without this an aborted turn never releases them: MessagingBridgeService
 * kept its in-flight flag and stream listeners forever, leaving the remote
 * user's placeholder dangling and every later message answered with "please
 * wait for the current response to finish" until the app restarted.
 */
export function emitStreamAborted(agentId: string, envelope?: StreamEnvelope): void {
  eventBus.emitEvent('chat:aborted', {
    agentId,
    containerId: envelope?.containerId,
    context: envelope?.context,
    turnId: envelope?.turnId,
  });
}

/**
 * Chat-surface lifecycle brackets.
 *
 * These were bare `'stream:start'` / `'stream:end'` strings, which made every
 * turn look alike to the renderer: a Telegram-driven turn in some other chat
 * flipped the desktop composer's busy flag (and could flush its send queue),
 * and a channel approval-resume did the same to a surface it has nothing to do
 * with. Stamped with the envelope, the renderer can tell whose turn ended.
 *
 * The legacy strings survive as the `type`, so this is additive like every
 * other envelope field — an unstamped emitter still degrades to the old
 * behavior rather than dropping.
 */
export function emitStreamSentinel(
  mainWindow: BrowserWindow | null,
  phase: 'start' | 'end',
  envelope?: StreamEnvelope,
): void {
  if (!mainWindow) return;
  mainWindow.webContents.send('chat-stream', {
    type: phase === 'start' ? 'stream:start' : 'stream:end',
    ...envelope,
  });
}

/**
 * Signal the renderer that history compaction is running (it adds latency
 * before the main stream begins). Drives the "compacting…" indicator.
 */
export function emitCompaction(mainWindow: BrowserWindow | null, phase: 'start' | 'end', envelope?: StreamEnvelope): void {
  if (mainWindow) {
    mainWindow.webContents.send('chat-stream', {
      type: phase === 'start' ? 'compaction-start' : 'compaction-end',
      ...envelope,
    });
  }
}
