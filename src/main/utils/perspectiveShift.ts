/**
 * Rewrite channel messages from the perspective of the responding agent.
 *
 * Problem: all agent messages arrive as role:'assistant', so the LLM thinks
 * every agent message is its own prior response. Other agents' words are
 * invisible or confusing.
 *
 * Solution: perspective-shift the history so that:
 *   - The responding agent's messages stay as 'assistant'
 *   - Other agents' messages become 'user' with a [Name]: prefix
 *   - Human messages become 'user' with a [Name]: prefix
 *   - Consecutive same-role messages are merged (Claude API requires alternating roles)
 *
 * Tool-call awareness: when the responding agent's own past message carries
 * `responseMessages` (AI SDK shape from a prior turn), extract the tool calls
 * and results into a text summary appended to the assistant content. We can't
 * carry SDK ContentPart arrays through the merge step — multi-agent channels
 * are fundamentally a text-flattening operation — but the agent at least sees
 * a record of its own past tool use instead of pretending it did nothing.
 */

interface ResponseMessageLike {
  role?: string;
  content?: unknown;
}

interface ToolCallPart {
  type: 'tool-call';
  toolName?: string;
  input?: unknown;
}

interface ToolResultPart {
  type: 'tool-result';
  toolName?: string;
  output?: unknown;
}

function summarizeToolUseFromResponseMessages(responseMessages: unknown[]): string {
  if (!Array.isArray(responseMessages) || responseMessages.length === 0) return '';
  const lines: string[] = [];
  for (const m of responseMessages as ResponseMessageLike[]) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<ToolCallPart | ToolResultPart>) {
      if (part?.type === 'tool-call') {
        const args = (() => { try { return JSON.stringify(part.input); } catch { return '{}'; } })();
        lines.push(`[tool-call] ${part.toolName ?? 'unknown'}(${args})`);
      } else if (part?.type === 'tool-result') {
        const output = (() => { try { return JSON.stringify(part.output); } catch { return String(part.output); } })();
        const truncated = output.length > 800 ? output.slice(0, 800) + '…' : output;
        lines.push(`[tool-result] ${part.toolName ?? 'unknown'} → ${truncated}`);
      }
    }
  }
  return lines.length > 0 ? `\n\n[Prior tool use this turn:\n${lines.join('\n')}\n]` : '';
}

export function perspectiveShiftMessages(messages: any[], respondingAgentId: string): any[] {
  // A turn that failed mid-stream persists with empty content (the error lives
  // in a system contentBlock). Replaying it produces an empty text block —
  // which providers reject — or, for another participant, a bare "[Name]: ".
  // Drop those rows before shifting: one failed turn must not wedge every
  // later turn in the channel.
  const carriesContent = (msg: any): boolean =>
    (typeof msg?.content === 'string' && msg.content.trim().length > 0) ||
    (Array.isArray(msg?.responseMessages) && msg.responseMessages.length > 0);

  const shifted = messages.filter(carriesContent).map(msg => {
    const senderType = msg.metadata?.senderType;
    const displayName = msg.metadata?.displayName || 'Unknown';
    const isCurrentAgent = senderType === 'agent' && msg.name === `agent_${respondingAgentId}`;

    if (isCurrentAgent) {
      // This agent's own prior responses — keep as assistant, no prefix.
      // Append a text summary of any tool calls/results from this turn so
      // the model can see what it already did before it generates next.
      const toolSummary = summarizeToolUseFromResponseMessages(msg.responseMessages || []);
      const content = typeof msg.content === 'string' ? msg.content : '';
      return {
        role: 'assistant' as const,
        content: content + toolSummary,
        toolCalls: msg.toolCalls,
      };
    }

    if (senderType === 'agent') {
      // Another agent's message — demote to user role, prefix with name
      // toolCalls are stripped since they belong to the other agent's execution context
      return { role: 'user' as const, content: `[${displayName}]: ${msg.content}` };
    }

    // Human message — prefix with name for multi-participant clarity
    return { role: 'user' as const, content: `[${displayName}]: ${msg.content}` };
  });

  // A tools-only turn (responseMessages but no prose) still shifts to empty
  // text — same rejection. Drop after shifting, before the merge, so the
  // alternating-role pass sees a clean list.
  const nonEmpty = shifted.filter(msg => typeof msg.content === 'string' && msg.content.trim().length > 0);

  // Merge consecutive same-role messages (Claude API requires alternating user/assistant)
  const merged: any[] = [];
  for (const msg of nonEmpty) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = `${prev.content}\n\n${msg.content}`;
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}
