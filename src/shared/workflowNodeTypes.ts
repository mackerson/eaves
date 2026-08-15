/**
 * Canonical workflow node types — single source of truth for frontend + backend.
 *
 * Agents are constrained to this list via zod enum in the create_workflow /
 * update_workflow tool schemas. The React Flow node registry uses these names
 * directly. The executor switches on `node.type` against these values.
 */

export const WORKFLOW_NODE_TYPES = [
  'code',
  'http',
  'agent',
  'conditional',
  'delay',
  'loop',
  'break',
  'webscraper',
  'start',
  'end',
  'action',
  // Sinks. Every other node type computes; without these a workflow could
  // reason its way to an answer and then have nowhere to put it, which left
  // scheduled routines writing into a run record nobody reads.
  //
  // Posting to a channel is deliberately absent: the `messages` CHECK admits
  // only 'human' and 'agent', so a workflow has no honest sender to write as.
  // Offering the node before that is fixed would just move the dead end from
  // "no output exists" to "the output fails at 9am".
  'note',
  'task',
] as const;

export type WorkflowNodeType = typeof WORKFLOW_NODE_TYPES[number];

export function isWorkflowNodeType(raw: unknown): raw is WorkflowNodeType {
  return typeof raw === 'string' && (WORKFLOW_NODE_TYPES as readonly string[]).includes(raw);
}

/**
 * The per-type `data` grammar, as data rather than prose.
 *
 * This used to live only in `create_workflow`'s tool description, which meant
 * ~1.8KB of grammar shipped on every request of every turn whether or not the
 * agent was building a workflow. Structuring it lets one source generate three
 * things: the on-demand documentation `get_tool_info` returns, the create-time
 * validation message a wrong graph gets back, and the field list the editor can
 * show. The fields mirror what `WorkflowExecutor` actually reads — when a
 * handler changes, change this with it.
 */
export interface NodeFieldSpec {
  name: string;
  /** Shape as the model should read it, e.g. `"GET"|"POST"` or `number (ms)`. */
  type: string;
  required?: boolean;
  note?: string;
}

export interface NodeTypeSpec {
  summary: string;
  fields: NodeFieldSpec[];
}

export const WORKFLOW_NODE_SPECS: Record<WorkflowNodeType, NodeTypeSpec> = {
  start: { summary: 'entry marker', fields: [] },
  end: { summary: 'exit marker', fields: [] },
  action: { summary: 'pass-through marker; data is free-form', fields: [] },
  code: {
    summary: 'run a script in a subprocess',
    fields: [
      { name: 'code', type: 'string', required: true },
      { name: 'language', type: '"javascript"|"python"|"shell"', note: 'default javascript' },
      { name: 'timeout', type: 'number (ms)', note: 'default 30000, floored at 1000' },
    ],
  },
  agent: {
    summary: 'call another agent to generate text',
    fields: [
      { name: 'prompt', type: 'string', required: true },
      { name: 'agentId', type: 'string' },
      { name: 'systemPromptOverride', type: 'string' },
      { name: 'temperature', type: 'number' },
      { name: 'maxTokens', type: 'number' },
    ],
  },
  http: {
    summary: 'HTTP request',
    fields: [
      { name: 'url', type: 'string', required: true },
      { name: 'method', type: '"GET"|"POST"|"PUT"|"DELETE"|"PATCH"', note: 'default GET' },
      { name: 'headers', type: 'object' },
      { name: 'body', type: 'string', note: 'ignored on GET' },
    ],
  },
  conditional: {
    summary: 'branch on a value; wire the branches with sourceHandle "true"/"false"',
    fields: [
      { name: 'condition', type: 'string', required: true, note: 'the left-hand value, usually a ${node-id} reference' },
      { name: 'operator', type: '"equals"|"notEquals"|"contains"|"greaterThan"|"lessThan"', required: true },
      { name: 'value', type: 'string', note: 'the right-hand value' },
    ],
  },
  delay: {
    summary: 'wait',
    fields: [
      { name: 'duration', type: 'number', note: 'default 5' },
      { name: 'unit', type: '"seconds"|"minutes"|"hours"', note: 'default seconds' },
    ],
  },
  loop: {
    summary: 'iterate over a collection; wire the body with sourceHandle "body"',
    fields: [
      { name: 'collection', type: 'string', required: true, note: 'must resolve to an array' },
      { name: 'variable', type: 'string', note: 'default "item"' },
      { name: 'maxIterations', type: 'number' },
      { name: 'collectResults', type: 'boolean', note: 'default true' },
    ],
  },
  break: {
    summary: 'exit the enclosing loop',
    fields: [
      { name: 'condition', type: 'string', note: 'breaks unconditionally when omitted' },
      { name: 'label', type: 'string' },
    ],
  },
  webscraper: {
    summary: 'fetch a URL and extract from it',
    fields: [
      { name: 'url', type: 'string', required: true },
      { name: 'selector', type: 'string' },
      { name: 'timeout', type: 'number (ms)', note: 'default 10000' },
    ],
  },
  note: {
    summary: 'save a note in the project',
    fields: [
      { name: 'content', type: 'string', required: true, note: 'supports ${node-id} references' },
    ],
  },
  task: {
    summary: 'create a task in the project',
    fields: [
      { name: 'content', type: 'string', required: true, note: 'supports ${node-id} references' },
    ],
  },
};

/** One line of the node-type reference, e.g. ``code : run a script… data: { … }``. */
export function describeNodeType(type: WorkflowNodeType): string {
  const spec = WORKFLOW_NODE_SPECS[type];
  const fields = spec.fields
    .map(f => `${f.name}${f.required ? '' : '?'}: ${f.type}${f.note ? ` (${f.note})` : ''}`)
    .join(', ');
  return `${type.padEnd(11)}: ${spec.summary}. data: {${fields ? ` ${fields} ` : ''}}`;
}

/**
 * Validate one node's `data` against its type's required fields.
 * Returns null when valid, or a message that names what is missing *and*
 * restates the whole shape — so a rejected call carries its own correction
 * rather than needing the grammar to have been in context all along.
 */
export function validateNodeData(
  type: WorkflowNodeType,
  data: Record<string, unknown> | undefined
): string | null {
  const missing = WORKFLOW_NODE_SPECS[type].fields
    .filter(f => f.required)
    .filter(f => data?.[f.name] === undefined || data[f.name] === '')
    .map(f => f.name);
  if (missing.length === 0) return null;
  return `${type} node is missing required data ${missing.map(m => `\`${m}\``).join(', ')}. Required shape — ${describeNodeType(type)}`;
}
