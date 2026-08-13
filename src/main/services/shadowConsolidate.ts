import { getMemoryBlockRepository } from '../repositories';
import { getServiceRegistry } from './ServiceRegistry';
import { getLogger } from './logger';

const logger = getLogger();

/**
 * "Dreaming" consolidation — the sink for the shadow pipeline
 * (`ShadowService.ts` feeds this). A shadow observes a
 * conversation segment and emits a JSON dream object; we consolidate it into
 * the target agent's memory: the `current_focus` core block (running summary)
 * and durable facts into the archival memory-backend. No human gate — the
 * Memory view is the correction surface.
 */

export interface DreamFact { key: string; value: string; description?: string; tags?: string[] }
export interface DreamOutput { focus: string; facts: DreamFact[] }

/** Parse the shadow's response into a dream object. Returns null when there's
 *  nothing usable (non-JSON, or empty focus + no facts) — normal for custom
 *  shadows that act via tools instead. */
export function parseDreamOutput(response: string): DreamOutput | null {
  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    const focus = typeof parsed.focus === 'string' ? parsed.focus.trim() : '';
    const rawFacts = Array.isArray(parsed.facts) ? parsed.facts : [];
    const facts: DreamFact[] = rawFacts
      .filter((f): f is Record<string, unknown> =>
        !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).key === 'string' && typeof (f as Record<string, unknown>).value === 'string')
      .map(f => ({
        key: String(f.key).slice(0, 200),
        value: String(f.value),
        description: typeof f.description === 'string' ? f.description.slice(0, 200) : undefined,
        tags: Array.isArray(f.tags) ? f.tags.filter(t => typeof t === 'string').slice(0, 10) as string[] : undefined,
      }));

    if (!focus && facts.length === 0) return null;
    return { focus, facts };
  } catch {
    return null;
  }
}

/** Write a parsed dream into memory: current_focus block + archival facts. */
export async function consolidateDream(
  targetAgentId: string,
  dream: DreamOutput,
): Promise<{ focusUpdated: boolean; factsStored: number }> {
  let focusUpdated = false;
  if (dream.focus) {
    getMemoryBlockRepository().setValue(targetAgentId, 'current_focus', dream.focus);
    focusUpdated = true;
  }

  let factsStored = 0;
  const registry = getServiceRegistry();
  if (dream.facts.length > 0 && registry.hasProviders('memory-backend')) {
    for (const f of dream.facts) {
      try {
        await registry.call('memory-backend', 'store', {
          key: f.key,
          value: f.value,
          metadata: { description: f.description, tags: f.tags, source: 'shadow-dream', agentId: targetAgentId },
        });
        factsStored++;
      } catch (err) {
        logger.debug('[Shadow] dream fact store failed', err);
      }
    }
  }

  return { focusUpdated, factsStored };
}
