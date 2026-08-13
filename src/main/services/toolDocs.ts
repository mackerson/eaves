import { WORKFLOW_NODE_TYPES, describeNodeType } from '../../shared/workflowNodeTypes';

/**
 * Long-form tool documentation that is deliberately NOT on the wire.
 *
 * A tool's `description` is resent verbatim on every step of every turn, for
 * every agent, whether or not the tool is ever called. Measured on a small
 * turn, tool schemas were ~88% of its input, and the handful of tools with
 * tutorial-length descriptions
 * (`create_workflow`'s node grammar, `create_routine`'s cron primer,
 * `execute_code`'s rule list) accounted for most of it.
 *
 * So the descriptions keep only what a model needs to decide *whether* to call
 * the tool and to get a simple call right; the reference material a model needs
 * only while actually using the tool lives here and is served on demand by
 * `get_tool_info`. Two things keep that from being a silent downgrade:
 *
 *  1. Each trimmed description ends with an explicit pointer to `get_tool_info`.
 *  2. The tools validate at call time and their errors restate the shape — see
 *     `validateNodeData`. A wrong call teaches the correction; it doesn't just
 *     fail.
 */

const CRON_DOC = `Cron schedule format: "minute hour dayOfMonth month dayOfWeek".

Examples:
- "0 9 * * *"    every day at 9:00 AM
- "0 9 * * 1-5"  weekdays at 9:00 AM
- "0 */6 * * *"  every 6 hours
- "30 8 1 * *"   8:30 AM on the 1st of each month
- "0 0 * * 0"    midnight every Sunday`;

const WORKFLOW_DOC = `Every node needs \`data.label\` — a short name for the step, shown on the node in the editor. The per-type fields below are in addition to it; \`?\` marks optional.

Canonical node types and their \`data\` fields:
${WORKFLOW_NODE_TYPES.map(t => `- ${describeNodeType(t)}`).join('\n')}

Reference a previous node's output in any string field with \${node-id}. Inside a \`code\` node's script, previous outputs are also bound as \`context\`, \`data\` and \`input\`.

Do NOT invent node type names or data fields — unknown types are rejected, and unknown fields are ignored by the executor.`;

const EXECUTE_CODE_DOC = `Additional guidance:
- Prefer the dedicated file tools (read_file / edit_file / glob / grep) over writing programs to inspect or edit files; keep any script single-purpose.
- On Windows a Python interpreter is often absent — prefer JavaScript, or confirm Python is available before depending on it.
- For repeated work over the same data, save one script and reuse it instead of regenerating it each turn.`;

const TRANSCRIPT_SEARCH_DOC = `Scope: every conversation you are a participant in — channels, 1:1 chats and work sessions alike — whether or not the message was addressed to you.

Matching is by WORD, not by meaning. There are no embeddings here, so a paraphrase of an idea will not find it. Search for terms that would literally appear in the conversation: a name, an identifier, an error string, a number. Each token is also matched as a prefix, so "deploy" finds "deployment".

Reading a hit:
- \`before\` / \`after\` are the messages surrounding it, for judging relevance.
- \`messageId\` is a location. Pass it to read_conversation_at for exact wording, or to summarize_conversation_at to condense a long stretch.

If a search returns nothing, list_my_conversations shows what is actually searchable before you guess again.

This is not the memory system. search_memories finds notes an agent chose to store; this finds what was said.`;

const TRANSCRIPT_SUMMARY_DOC = `Reads a wider window than read_conversation_at (25 messages either side by default, up to 100) and condenses it.

Give \`focus\` whenever you have one — "why we rejected the queue design" produces a far more useful result than an unfocused précis of the same messages.

It will decline and hand back the raw messages when summarizing would not pay for itself: when the stretch is short, when the same excerpt was already summarized this turn, or after several summaries in one turn. That is not an error — the reply carries \`summarized: false\`, a \`reason\`, and the messages themselves.

A summary is a condensed account, not a transcript. When exact wording matters, use read_conversation_at on the same messageId.`;

/**
 * Extended documentation by tool name. Absent means the tool's description is
 * already complete on its own.
 */
export const TOOL_DOCS: Record<string, string> = {
  create_workflow: WORKFLOW_DOC,
  update_workflow: WORKFLOW_DOC,
  create_routine: CRON_DOC,
  update_routine: CRON_DOC,
  execute_code: EXECUTE_CODE_DOC,
  search_conversations: TRANSCRIPT_SEARCH_DOC,
  read_conversation_at: TRANSCRIPT_SEARCH_DOC,
  summarize_conversation_at: TRANSCRIPT_SUMMARY_DOC,
};

/**
 * The tools whose wire description was actually shortened, as opposed to those
 * that merely gained extended docs (`update_routine` was already brief; it
 * shares the cron reference because a caller asking about it wants the same
 * examples). Each of these owes the model an explicit pointer to
 * `get_tool_info` — that promise is what the trim was made against.
 */
export const TRIMMED_TOOLS = [
  'create_workflow', 'update_workflow', 'create_routine', 'execute_code',
  'search_conversations', 'summarize_conversation_at',
] as const;

/**
 * The description plus its extended docs, for surfaces that serve one tool on
 * demand (`get_tool_info`, and `list_tools` in verbose mode).
 */
export function fullToolDescription(toolName: string, description: string): string {
  const extended = TOOL_DOCS[toolName];
  return extended ? `${description}\n\n${extended}` : description;
}
