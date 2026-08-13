/**
 * System-prompt templating.
 *
 * When an agent defines a `promptTemplate`, buildSystemPrompt renders it
 * instead of the hardcoded tier scaffolding — letting the author control
 * exactly what context the model sees (and strip what a small model doesn't
 * need, e.g. project name or participant list). The persona text the user
 * writes in the System Prompt field is itself available as {{systemPrompt}}.
 */

export interface PromptTemplateVariable {
  name: string;
  description: string;
}

/** Variables resolved by buildSystemPrompt and documented in the editor. */
export const PROMPT_TEMPLATE_VARIABLES: PromptTemplateVariable[] = [
  { name: 'systemPrompt', description: "The agent's persona/instructions (System Prompt field)" },
  { name: 'agent', description: 'Agent name (alias: {{char}})' },
  { name: 'user', description: "The user's display name" },
  { name: 'project', description: 'Current project name' },
  { name: 'participants', description: 'Humans/agents in the conversation' },
  { name: 'tools', description: 'Tool inventory summary (built-in / MCP / total)' },
  { name: 'folders', description: 'User-attached project folders' },
  { name: 'tasks', description: 'Active task & note counts' },
  { name: 'memories', description: 'Approved facts from past conversations' },
  { name: 'participantNote', description: 'Channel-behavior note (respondTo / verbosity) for channel turns' },
  { name: 'roleplayNote', description: 'In-character / scenario scaffolding for roleplay agents' },
];

/**
 * Default template — reproduces the hardcoded tier scaffolding's output for
 * the common case, so adopting a template changes nothing until it's edited.
 * A starting point authors trim down (e.g. drop {{project}}/{{participants}}
 * for a focused tiny-model task) or extend with {{tools}}/{{memories}}/etc.
 */
export const DEFAULT_PROMPT_TEMPLATE = `{{systemPrompt}}

You are {{agent}}. The user's name is {{user}}.

{{roleplayNote}}

{{participantNote}}

Project: {{project}}

Conversation Participants:
{{participants}}`;

const TEMPLATE_VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Substitute the known prompt variables. Unknown `{{tokens}}` are left intact
 * so the caller's mustache pass (agent.contextVariables, {{char}}, etc.) can
 * still resolve them. Collapses the blank lines that empty variables leave
 * behind so a trimmed template stays tidy.
 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  const substituted = template.replace(TEMPLATE_VAR_RE, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
  return substituted.replace(/\n{3,}/g, '\n\n').trim();
}
