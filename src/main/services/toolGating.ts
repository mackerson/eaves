import type { Tool } from 'ai';
import { logger } from './logger';

/**
 * Strip tools that require human approval from a toolset.
 *
 * Routines, shadow-agent flushes, workflow agent nodes, note-summarization
 * passes, and other non-interactive contexts run with no human present —
 * an approval-required tool would emit a tool-approval-request that nobody
 * is there to click, and the message would sit in PendingApprovalRegistry
 * forever blocking the workflow. Gate by removing the tool from the toolset
 * before streamText sees it; the model never knows it was an option.
 *
 * Today every non-interactive caller passes `tools` as undefined, so this
 * is a defensive no-op. The point is the contract: if/when someone wires
 * tools into a routine path, the filter saves them from a hung workflow.
 */
export function stripApprovalRequiredTools(
  tools: Record<string, Tool> | undefined,
  context: string,
): Record<string, Tool> | undefined {
  if (!tools) return tools;

  const stripped: string[] = [];
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    // needsApproval can be `true`, `false`, or a function. Conservative:
    // strip on any truthy non-false value, since a function predicate
    // *could* return true and we have no human to handle it.
    const na = (tool as { needsApproval?: unknown })?.needsApproval;
    if (na === true || typeof na === 'function') {
      stripped.push(name);
      continue;
    }
    out[name] = tool;
  }

  if (stripped.length > 0) {
    logger.warn(
      `[toolGating] Stripped ${stripped.length} approval-required tool(s) from non-interactive ${context}`,
      { tools: stripped },
    );
  }

  return out;
}
