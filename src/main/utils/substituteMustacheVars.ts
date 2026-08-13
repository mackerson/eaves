import type { Agent } from '../../shared/types';

/**
 * Replace mustache-style placeholders in `text` with the agent's identity
 * fields (and any custom variables from `agent.contextVariables`).
 *
 * Used by both the greeting seed and the system-prompt builder so a
 * character-card agent's prompts/greetings render correctly no matter
 * which path produces them. Any path that skips this helper ships prompts
 * like "Scenario: {{user}} and {{agent}} are looking for a quest." to the
 * model verbatim, so every new prompt-producing path has to call it.
 *
 * Built-in keys (with the case variants character cards use):
 *   {{user}} / {{User}}    → userName
 *   {{char}} / {{Char}}    → agent.name (character-card alias)
 *   {{agent}} / {{Agent}}  → agent.name
 *
 * Custom keys from `agent.contextVariables` override built-ins on conflict.
 */
export function substituteMustacheVars(text: string, agent: Agent, userName: string): string {
  if (!text) return text;

  const vars: Record<string, string> = {
    user: userName,
    User: userName,
    char: agent.name,
    Char: agent.name,
    agent: agent.name,
    Agent: agent.name,
    ...(agent.contextVariables ?? {}),
  };

  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value),
    text,
  );
}
