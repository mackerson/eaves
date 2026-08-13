/**
 * The one place stored conversation rows become a provider request.
 *
 * Three surfaces replay history — the chat turn, the channel turn, and the
 * approval resume — and each projects rows differently (SDK shape, prose,
 * or a hybrid). What they must NOT differ on is everything after that:
 * repair, compaction, windowing, and the invariants the provider enforces.
 * Divergence there is how a conversation reaches a state where every turn
 * 400s and no retry clears it.
 *
 * Pipeline:
 *   repair → compact → window → repair → assert
 *
 * The second repair is not redundant: the window cut is token-based and can
 * land between a tool-call and its result.
 *
 * `assertReplayInvariants` is the part that earns its keep long-term. The
 * repair passes fix what we know about; the assertion catches what we don't,
 * turning a silent provider 400 into a logged violation (and a hard failure
 * in development, where someone is watching).
 */

import type { Agent } from '../types';
import { sanitizeResponseMessagesForReplay } from '../utils/sanitizeResponseMessages';
import { maybeCompactHistory, type CompactableMessage } from './compaction';
import { windowMessages, type ContextBudget } from './contextBudget';
import { logger } from './logger';

interface ContentPart {
  type?: string;
  text?: string;
  toolCallId?: string;
  [k: string]: unknown;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

export interface AssembleReplayOptions {
  agent: Agent;
  /** Chat or channel id — compaction keys its stored summary on this. */
  containerId: string;
  budget: ContextBudget;
  /** Rows already projected to messages by the calling surface. */
  messages: unknown[];
  /**
   * Tool-calls that are allowed to be unanswered — the resume path sends the
   * approved-but-not-yet-executed call alongside its approval-response, and
   * the SDK resolves it. Exempt from the adjacency invariant.
   */
  preserveCallIds?: Set<string>;
  onCompacting?: (phase: 'start' | 'end') => void;
  /** Names the calling surface in violation logs (e.g. 'chat', 'channel'). */
  source: string;
}

export interface AssembledReplay {
  messages: unknown[];
  /** Compaction summary, when history was summarized. Callers append it to the system prompt. */
  summary?: string;
  /** Invariant violations that survived repair — empty on every healthy turn. */
  violations: string[];
}

export async function assembleReplayHistory(opts: AssembleReplayOptions): Promise<AssembledReplay> {
  const { agent, containerId, budget, messages, preserveCallIds, onCompacting, source } = opts;

  const repaired = sanitizeResponseMessagesForReplay(messages, preserveCallIds);

  const compacted = await maybeCompactHistory({
    agent,
    channelId: containerId,
    messages: repaired as CompactableMessage[],
    messageBudget: budget.messageBudget,
    onCompacting,
  });

  const windowed = sanitizeResponseMessagesForReplay(
    windowMessages(
      compacted.messages as Array<{ content: string | unknown[]; toolCalls?: unknown[] }>,
      budget.messageBudget,
    ),
    preserveCallIds,
  );

  const violations = assertReplayInvariants(windowed, { preserveCallIds, source, containerId });

  return { messages: windowed, summary: compacted.summary, violations };
}

/**
 * Check the message array against the rules the provider enforces. Returns
 * the violations it found (empty is the healthy case) after logging them —
 * and throws in development, where a wedged conversation is a bug worth
 * stopping for rather than a 400 to decipher from a log days later.
 */
export function assertReplayInvariants(
  messages: unknown[],
  ctx: { preserveCallIds?: Set<string>; source: string; containerId?: string },
): string[] {
  const violations = findReplayViolations(messages, ctx.preserveCallIds);
  if (violations.length === 0) return violations;

  logger.error('[replayHistory] assembled history violates provider invariants', {
    source: ctx.source,
    containerId: ctx.containerId,
    messageCount: messages.length,
    violations,
  });

  if (isDevelopment()) {
    throw new Error(
      `[replayHistory] ${ctx.source}: assembled history violates provider invariants — ${violations.join('; ')}`,
    );
  }
  return violations;
}

/**
 * The provider-side rules, stated once:
 *  - no empty text (Anthropic: "text content blocks must be non-empty")
 *  - every tool_use is answered in the very next message
 *  - every tool_result answers a call in the message right before it
 */
export function findReplayViolations(
  messages: unknown[],
  preserveCallIds: Set<string> = new Set(),
): string[] {
  const violations: string[] = [];
  const list = messages as MessageLike[];

  list.forEach((message, index) => {
    const content = message?.content;

    if (typeof content === 'string') {
      if (content.trim().length === 0) violations.push(`[${index}] ${message?.role}: empty content`);
      return;
    }
    if (!Array.isArray(content)) return;

    const parts = content as ContentPart[];
    for (const part of parts) {
      if (part?.type === 'text' && (typeof part.text !== 'string' || part.text.trim().length === 0)) {
        violations.push(`[${index}] ${message?.role}: empty text part`);
      }
    }

    if (message?.role === 'assistant') {
      const callIds = parts
        .filter(p => p?.type === 'tool-call' && typeof p.toolCallId === 'string')
        .map(p => p.toolCallId as string)
        .filter(id => !preserveCallIds.has(id));
      if (callIds.length > 0) {
        const answered = resultIdsOf(list[index + 1]);
        const unanswered = callIds.filter(id => !answered.has(id));
        if (unanswered.length > 0) {
          violations.push(`[${index}] tool-call unanswered by the next message: ${unanswered.join(', ')}`);
        }
      }
    }

    if (message?.role === 'tool') {
      const callIds = callIdsOf(list[index - 1]);
      const orphans = [...resultIdsOf(message)].filter(id => !callIds.has(id));
      if (orphans.length > 0) {
        violations.push(`[${index}] tool-result with no call in the previous message: ${orphans.join(', ')}`);
      }
    }
  });

  return violations;
}

function callIdsOf(message: MessageLike | undefined): Set<string> {
  const ids = new Set<string>();
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return ids;
  for (const part of message.content as ContentPart[]) {
    if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') ids.add(part.toolCallId);
  }
  return ids;
}

function resultIdsOf(message: MessageLike | undefined): Set<string> {
  const ids = new Set<string>();
  if (message?.role !== 'tool' || !Array.isArray(message.content)) return ids;
  for (const part of message.content as ContentPart[]) {
    if ((part?.type === 'tool-result' || part?.type === 'tool-error') && typeof part.toolCallId === 'string') {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Electron's `app` isn't reachable from every context that replays history
 * (tests, workers), so fall back to NODE_ENV rather than assuming dev.
 */
function isDevelopment(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (typeof app?.isPackaged === 'boolean') return !app.isPackaged;
  } catch {
    /* not in an Electron main context */
  }
  return process.env.NODE_ENV === 'development';
}
