/**
 * The human-readable text a workflow node produced, if it produced any.
 *
 * Shared because two callers have to agree on it: `${node-id}` interpolation
 * in a sink node's content, and the summary a routine delivers to a note or a
 * task. If they disagreed, the text a user previewed in the editor would not
 * be the text that turned up in their notes.
 *
 * Node results are objects — an agent node returns `{ response, agentId, … }`
 * — so the useful string is one field down, and which field depends on the
 * node type.
 */

/** Result fields that carry a node's own output, most specific first. */
const TEXT_KEYS = ['response', 'content', 'text', 'output', 'result'];

export function textFromResult(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of TEXT_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  // A marker node ({ passed: true }) carries no result; delivering it would
  // post noise in place of an answer.
  if (record.passed === true) return '';

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}
