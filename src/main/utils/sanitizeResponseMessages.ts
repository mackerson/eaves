/**
 * Repair the FLATTENED SDK ResponseMessage[] array we're about to send to
 * streamText so it survives both validators in front of it:
 *  1. The AI SDK's `convertToLanguageModelPrompt` rejects assistant
 *     tool-calls without a matching tool-result → MissingToolResultsError.
 *  2. Anthropic's `/v1/messages` rejects tool_result blocks whose
 *     tool_use_id has no matching tool_use in the immediately-preceding
 *     assistant message, tool_use blocks whose results don't come in the
 *     very next message, and text blocks that are empty → 400.
 *
 * Three passes, in order:
 *  A. Balance   — drop results with no call, and approval-requests whose
 *                 approval is moot.
 *  B. Adjacency — move each result up against the assistant message that made
 *                 the call, and answer calls nothing ever answered.
 *  C. Emptiness — drop empty text parts and messages left with nothing.
 *
 * All three are cross-message: a persisted call/result pair can span two of
 * our chat-message rows (the original turn persists the call, the resume
 * continuation persists the result), and per-message sanitizing breaks the
 * linkage from either side. Caller flattens responseMessages across all
 * rows first, then runs this once on the full array.
 *
 * `preserveCallIds` keeps a specific toolCallId's tool-call alive even if
 * it's dangling — used by the resume path, which intentionally sends an
 * unresolved tool-call paired with a tool-approval-response.
 */

interface AssistantContentPart {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  [k: string]: unknown;
}

interface ToolContentPart {
  type?: string;
  toolCallId?: string;
  approvalId?: string;
  output?: unknown;
  [k: string]: unknown;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

export function sanitizeResponseMessagesForReplay(
  messages: unknown[],
  preserveCallIds: Set<string> = new Set(),
): unknown[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // Every call id an assistant message actually made. A result naming
  // anything else is an orphan we can't place — no call to attach it to, and
  // no way to invent one.
  const assistantCallIds = new Set<string>();
  for (const m of messages as MessageLike[]) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content as AssistantContentPart[]) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        assistantCallIds.add(part.toolCallId);
      }
    }
  }

  const balanced: MessageLike[] = [];
  for (const m of messages as MessageLike[]) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      const filtered: AssistantContentPart[] = [];
      for (const part of m.content as AssistantContentPart[]) {
        // An unresolved call keeps its tool-call part — pass B answers it with
        // a synthetic failure result, so the model can see that it tried and
        // what became of it. Its tool-approval-request goes, though: the
        // approval is moot once the call is being answered, and a lone
        // approval-request still makes the SDK demand a tool-result.
        // preserveCallIds (resume path) keeps a genuinely-pending approval
        // intact — request part included — because the appended
        // approval-response is what resolves it.
        if (part?.type === 'tool-approval-request') {
          if (typeof part.toolCallId === 'string' && preserveCallIds.has(part.toolCallId)) {
            filtered.push(part);
          }
          continue;
        }
        filtered.push(part);
      }
      // Skip the assistant message entirely if filtering left it empty.
      if (filtered.length === 0) continue;
      balanced.push({ ...m, content: filtered });
      continue;
    }

    if (m?.role === 'tool' && Array.isArray(m.content)) {
      const filtered = (m.content as ToolContentPart[]).filter(p => {
        if (p?.type === 'tool-result' || p?.type === 'tool-error') {
          // Drop orphan results — Anthropic rejects tool_result blocks
          // whose tool_use_id wasn't on the previous assistant message.
          return typeof p.toolCallId === 'string' && assistantCallIds.has(p.toolCallId);
        }
        // approval-response parts: keep — they reference approvalId, not
        // toolCallId, and the resume path needs them to stay intact.
        return true;
      });
      if (filtered.length === 0) continue;
      balanced.push({ ...m, content: filtered });
      continue;
    }

    balanced.push(m);
  }

  return dropEmptyContent(realignToolResults(balanced, preserveCallIds));
}

/**
 * Pass B — put every tool-result immediately after the assistant message that
 * called it.
 *
 * Anthropic requires the message following a tool_use to carry a tool_result
 * for EVERY tool_use in it. Parallel tool calls that each need approval break
 * that: the user decides them one at a time, each resume runs one tool and
 * persists its result in its own message row, so the flattened history reads
 *
 *   assistant[call A, call B] → tool[result A] → assistant[…] → tool[result B]
 *
 * and the provider rejects it on call B. Pass A can't see this — both calls
 * are resolved *somewhere*, just not adjacently. So gather each assistant
 * message's results, wherever they were persisted, into one tool message
 * right behind it. Results are position-independent, so moving them is safe;
 * only the pairing is load-bearing.
 */
function realignToolResults(messages: MessageLike[], preserveCallIds: Set<string>): MessageLike[] {
  // Index every result part by call id, then hand it to the first assistant
  // message that claims it. `claimed` keeps a duplicate result (same id
  // persisted twice across rows) from being emitted under two assistants.
  const resultForCall = new Map<string, ToolContentPart>();
  for (const m of messages) {
    if (m?.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content as ToolContentPart[]) {
      if (
        (part?.type === 'tool-result' || part?.type === 'tool-error') &&
        typeof part.toolCallId === 'string' &&
        !resultForCall.has(part.toolCallId)
      ) {
        resultForCall.set(part.toolCallId, part);
      }
    }
  }
  const claimed = new Set<string>();
  const out: MessageLike[] = [];
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      out.push(m);
      const results: ToolContentPart[] = [];
      for (const part of m.content as AssistantContentPart[]) {
        if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue;
        if (preserveCallIds.has(part.toolCallId)) continue;
        const result = resultForCall.get(part.toolCallId);
        if (result && !claimed.has(part.toolCallId)) {
          claimed.add(part.toolCallId);
          results.push(result);
        } else if (!result) {
          // Never answered — the turn died before the tool ran, or the
          // approval it was waiting on was overtaken. Dropping the call would
          // satisfy the provider but leave the model believing it never tried;
          // answering it keeps the attempt in the conversation and lets the
          // model decide what to do about it.
          results.push(incompleteCallResult(part));
        }
      }
      if (results.length > 0) out.push({ role: 'tool', content: results });
      continue;
    }

    if (m?.role === 'tool' && Array.isArray(m.content)) {
      // Whatever is left after the assistants took their results — in
      // practice only tool-approval-response parts, which bind by approvalId
      // and must keep their original position.
      const rest = (m.content as ToolContentPart[]).filter(
        p => p?.type !== 'tool-result' && p?.type !== 'tool-error',
      );
      if (rest.length > 0) out.push({ ...m, content: rest });
      continue;
    }

    out.push(m);
  }
  return out;
}

/**
 * Stand in for a result the tool never produced.
 *
 * Worded as the app reporting, not as the tool's own output: the model must
 * not read this as something `edit_file` said.
 *
 * Says the outcome is UNKNOWN, never that nothing ran. What we actually know
 * is that no result was recorded — and a call can execute and have its result
 * lost when the turn dies in between. Claiming it never ran reads as licence
 * to redo it, which is a double-apply on anything with side effects (observed:
 * a file edit that had landed was replayed because the notice said it hadn't).
 *
 * Deliberately does not say whether to retry — the same shape covers a
 * transient stream failure and an approval the user walked away from, and
 * those want opposite responses.
 */
function incompleteCallResult(call: AssistantContentPart): ToolContentPart {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: 'error-text',
      value:
        'No result was recorded for this tool call — the turn ended before one came back ' +
        '(interrupted request, or a pending approval overtaken by a newer message). ' +
        'Reported by Enclave, not by the tool. Whether the call ran is unknown: it may have ' +
        'completed with its result lost. Check the current state before repeating anything ' +
        'that writes, edits, or sends.',
    },
  };
}

/**
 * Pass C — Anthropic rejects empty text blocks ("text content blocks must be
 * non-empty"), and our own error rows persist exactly that: a failed turn
 * saves a message whose only contentBlock is a system error, which replays as
 * an assistant message with empty content. One failure then poisons every
 * later turn in that conversation — including the retry meant to recover it —
 * so the thread wedges permanently. Drop those instead of replaying them.
 */
function dropEmptyContent(messages: MessageLike[]): MessageLike[] {
  const out: MessageLike[] = [];
  for (const m of messages) {
    if (typeof m?.content === 'string') {
      if (m.content.trim().length === 0) continue;
      out.push(m);
      continue;
    }

    if (Array.isArray(m?.content)) {
      const parts = (m.content as AssistantContentPart[]).filter(
        p => !(p?.type === 'text' && (typeof p.text !== 'string' || p.text.trim().length === 0)),
      );
      if (parts.length === 0) continue;
      out.push(parts.length === (m.content as unknown[]).length ? m : { ...m, content: parts });
      continue;
    }

    out.push(m);
  }
  return out;
}
