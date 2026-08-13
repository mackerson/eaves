import type { Agent, Chat } from '../../shared/types';

/**
 * Builds the roleplay framing block injected into the system prompt for
 * agents with `archetype.type === 'roleplay'`. Returns undefined for any
 * other archetype so callers can pass the result through unchanged.
 *
 * The framing is intentionally minimal — the agent's own systemPrompt
 * carries the character itself; this just keeps the model in-character and
 * surfaces the user's per-chat persona when one is set.
 */
export function buildRoleplayNote(agent: Agent, chat?: Pick<Chat, 'userPersona'>): string | undefined {
  if (agent.archetype?.type !== 'roleplay') return undefined;

  const lines = [
    'This is a roleplay scene. Stay in character at all times.',
    'Do not break the fourth wall, refer to yourself as an AI or language model, or offer meta-commentary about the conversation. Respond as your character would, in their voice.',
  ];

  const persona = chat?.userPersona?.trim();
  if (persona) {
    lines.push(`The user is playing: ${persona}`);
  }

  return lines.join('\n');
}
