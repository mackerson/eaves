import { getAgentRepository, getSettingsRepository } from '../repositories';
import type { Agent } from '../types';

/**
 * Resolve the agent used for background/utility work (chat title generation,
 * note metadata, workflow agent-node fallback, etc.).
 *
 * Fallback chain:
 *   1. `settings.systemAgentId` — user's explicit pick
 *   2. `settings.defaultAgentId` — the chat-facing default (good-enough fallback)
 *   3. First agent in the DB — last resort so a fresh install still functions
 *
 * Returns `null` only when no agents exist at all. Callers should treat that
 * as a configuration error, not a transient miss.
 */
export function resolveSystemAgent(): Agent | null {
  const settings = getSettingsRepository().get();
  const agentRepo = getAgentRepository();

  if (settings.systemAgentId) {
    const pinned = agentRepo.getById(settings.systemAgentId);
    if (pinned) return pinned;
  }

  if (settings.defaultAgentId) {
    const fallback = agentRepo.getById(settings.defaultAgentId);
    if (fallback) return fallback;
  }

  const all = agentRepo.getAll();
  return all[0] ?? null;
}
