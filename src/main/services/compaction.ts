import type { Agent } from '../types';
import { estimateMessageTokens } from './contextBudget';
import { resolveSystemAgent } from './systemAgent';
import { streamAIResponse } from './ai';
import { emitAgentSpend, trackUsage, createStreamMetrics } from './streamEventRouter';
import { getChannelRepository, getSettingsRepository } from '../repositories';
import { logger } from './logger';

/**
 * Conversation compaction.
 *
 * `windowMessages` alone is lossy — once history crosses budget it silently
 * DROPS the oldest turns. Compaction replaces that drop with a summary: when
 * history exceeds the message budget (or the user forces it), the turns that
 * wouldn't fit are summarized by the system agent into a running per-channel
 * summary, which the caller injects into the system prompt, while recent turns
 * stay verbatim. Net effect: the prompt shrinks without losing the gist of old
 * history.
 *
 * v1 regenerates the summary from the current aged set on each compaction turn
 * (correct + not-lossy, bounded by the history fetch cap). v2 optimization:
 * track summary_through_message_id and fold only freshly-aged turns, avoiding a
 * summary call on every over-budget turn.
 */

// Model-ready message shape (post perspective-shift): loose on purpose so all
// three assembly paths can pass their arrays without coupling to a concrete type.
export interface CompactableMessage {
  role?: string;
  content: string | unknown[];
  toolCalls?: unknown[];
  name?: string;
}

export interface CompactionResult<T extends CompactableMessage> {
  /** Keep-recent messages (the aged ones removed when compacted). */
  messages: T[];
  /** Running summary to inject into the system prompt, if any. */
  summary?: string;
  /** True when a (re)summarization ran this call. */
  didCompact: boolean;
}

export interface CompactOptions<T extends CompactableMessage> {
  agent: Agent;
  channelId: string;
  messages: T[];
  /** Token budget for the message history (from computeContextBudget). */
  messageBudget: number;
  /** Force compaction even if history is under budget (manual trigger). */
  force?: boolean;
  /** UI signal hook — invoked around the (latency-bearing) summarization call. */
  onCompacting?: (phase: 'start' | 'end') => void;
}

/** Fraction of the message budget kept verbatim as recent turns. */
const KEEP_RECENT_RATIO = 0.5;

const SUMMARY_SYSTEM_PROMPT = [
  'You compress conversation history into a running summary.',
  'You are given the older messages of a conversation (and possibly a prior summary of even-older messages).',
  'Produce an UPDATED, self-contained summary that preserves: key facts, decisions made, user preferences and instructions, names/identifiers, unresolved questions, and the current task state.',
  'This summary REPLACES the raw messages in the model\'s context, so it must carry everything a participant would need to continue coherently.',
  'Be concise and factual. Output ONLY the summary text — no preamble, no greeting, no meta commentary.',
].join(' ');

/** Render a model-ready message to plain text for the summarizer. */
function renderMessage(msg: CompactableMessage): string {
  const who = msg.name ? `${msg.name}` : (msg.role ?? 'message');
  let text: string;
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p.type === 'text' && typeof p.text === 'string' ? p.text : '';
      })
      .filter(Boolean)
      .join('\n');
  } else {
    text = '';
  }
  return `${who}: ${text}`.trim();
}

async function summarize(
  agent: Agent,
  priorSummary: string | undefined,
  aged: CompactableMessage[],
): Promise<string | null> {
  const systemAgent = resolveSystemAgent() ?? agent;
  const rendered = aged.map(renderMessage).filter(Boolean).join('\n\n');
  const userContent = priorSummary
    ? `PRIOR SUMMARY (of even-older messages):\n${priorSummary}\n\nOLDER MESSAGES TO FOLD IN:\n${rendered}`
    : `OLDER MESSAGES TO SUMMARIZE:\n${rendered}`;

  const memory = {
    settings: getSettingsRepository().get(),
    users: [], agents: [], projects: [], channels: [],
    currentProjectId: null, currentAgentId: null, currentChannelId: null, currentUserId: null,
  };

  let out = '';
  const compactionMetrics = createStreamMetrics();
  for await (const event of streamAIResponse(
    systemAgent,
    memory as never,
    [{ role: 'user', content: userContent }] as never,
    SUMMARY_SYSTEM_PROMPT,
    undefined, undefined, undefined, undefined,
    { nonInteractive: true, contextLabel: 'compaction' },
  )) {
    if (typeof event === 'string') out += event;
    else trackUsage(event, compactionMetrics);
  }
  // Compaction fires on its own schedule with no human watching and can be a
  // large call — exactly the spend that used to be invisible.
  emitAgentSpend(systemAgent, compactionMetrics, { kind: 'compaction' });
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Compact conversation history if it exceeds the budget (or when forced).
 * Returns the keep-recent messages plus a summary to inject into the system
 * prompt. When no compaction is needed, returns the messages unchanged.
 */
export async function maybeCompactHistory<T extends CompactableMessage>(
  opts: CompactOptions<T>,
): Promise<CompactionResult<T>> {
  const { agent, channelId, messages, messageBudget, force, onCompacting } = opts;
  if (messages.length === 0) return { messages, didCompact: false };

  // Per-agent control: 'off' disables compaction; 'manual' (v2) only compacts
  // on an explicit trigger — neither auto-compacts here. Default/undefined =
  // 'auto'. A manual force (v2 trigger) overrides the mode.
  if (!force && agent.compactionMode && agent.compactionMode !== 'auto') {
    return { messages, didCompact: false };
  }

  const channelRepo = getChannelRepository();
  const sizes = messages.map((m) => estimateMessageTokens(m as never));
  const total = sizes.reduce((a, b) => a + b, 0);

  // Under budget and not forced: every message is present, so no summary is
  // needed — and injecting a stored one would DUPLICATE messages still in the
  // array. Send as-is (this is the common path; no model call).
  if (total <= messageBudget && !force) {
    return { messages, didCompact: false };
  }

  // Over budget (or manual force): keep the newest turns that fit
  // KEEP_RECENT_RATIO of the budget verbatim; summarize everything older.
  const keepBudget = Math.max(1, Math.floor(messageBudget * KEEP_RECENT_RATIO));
  const keep: T[] = [];
  let keepTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (keepTokens + sizes[i] > keepBudget && keep.length > 0) break;
    keep.unshift(messages[i]);
    keepTokens += sizes[i];
  }
  const agedCount = messages.length - keep.length;

  // Everything fits the keep-recent window — nothing old enough to summarize.
  if (agedCount === 0) {
    return { messages, didCompact: false };
  }

  const aged = messages.slice(0, agedCount);
  onCompacting?.('start');
  try {
    logger.info('[Compaction] Summarizing aged history', {
      channelId, totalMessages: messages.length, agedCount, keptCount: keep.length,
      totalTokens: total, messageBudget,
    });
    // v1: regenerate from the current aged set (no prior-summary fold) so we
    // never double-count messages the summary already covers. (v2: track
    // summary_through_message_id and fold only freshly-aged turns.)
    const summary = await summarize(agent, undefined, aged);
    if (!summary) {
      // Summarization empty — fall back to full history and let windowMessages
      // bound it (its normal lossy drop). No summary injected.
      return { messages, didCompact: false };
    }
    // Persist for the manual trigger + UI. Marker id: newest kept message's
    // name if present (model messages lack DB ids).
    channelRepo.setContextSummary(channelId, summary, keep[0]?.name ?? 'compacted');
    return { messages: keep, summary, didCompact: true };
  } catch (err) {
    logger.warn('[Compaction] Summarization failed; sending history uncompacted', {
      channelId, error: err instanceof Error ? err.message : String(err),
    });
    return { messages, didCompact: false };
  } finally {
    onCompacting?.('end');
  }
}

/** System-prompt section wrapping the running summary. */
export function summarySection(summary: string): string {
  return `\n\n## Earlier conversation (summarized)\nThe conversation so far has been summarized to save context. Treat this as established history:\n${summary}`;
}
