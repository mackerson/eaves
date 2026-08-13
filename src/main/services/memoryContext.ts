import { getMemoryBlockRepository } from '../repositories';
import { getServiceRegistry } from './ServiceRegistry';
import { logger } from './logger';

/**
 * Assemble the agent memory context injected at session start:
 * always-in-context core-memory
 * blocks the agent edits, plus a bounded manifest of the archival store so it
 * knows what it can `search_memories` for. Replaces the old raw
 * `list('agent:{id}:*')` dump.
 */
const MANIFEST_LIMIT = 60;

export async function buildMemoryContext(agentId: string): Promise<string> {
  // Core-memory blocks (seed defaults for a new agent so it has structure).
  const blockRepo = getMemoryBlockRepository();
  blockRepo.ensureDefaults(agentId);
  const blocks = blockRepo.getByAgent(agentId);

  let core = '\n\n## Core memory (kept current by you — edit with core_memory_replace / core_memory_append)';
  for (const b of blocks) {
    const body = b.value.trim() || (b.description ? `(empty — ${b.description})` : '(empty)');
    core += `\n### ${b.label}\n${body}`;
  }

  // Manifest: keys + tags + description from the active backend (no values).
  let manifest = '';
  const serviceRegistry = getServiceRegistry();
  if (serviceRegistry.hasProviders('memory-backend')) {
    try {
      const result = await serviceRegistry.call<{
        success: boolean;
        memories?: Array<{ key: string; metadata?: { tags?: string[]; description?: string } }>;
        total?: number;
      }>('memory-backend', 'list', undefined, { limit: MANIFEST_LIMIT });
      const mems = result?.success ? result.memories ?? [] : [];
      if (mems.length > 0) {
        const lines = mems.map(m => {
          const tags = m.metadata?.tags?.length ? ` [${m.metadata.tags.join(', ')}]` : '';
          const desc = m.metadata?.description ? ` — ${m.metadata.description}` : '';
          return `- ${m.key}${tags}${desc}`;
        });
        const total = result?.total ?? mems.length;
        const more = total > mems.length ? `\n… and ${total - mems.length} more (${total} total)` : `\n(${total} stored)`;
        manifest = `\n\n## Memory index (search_memories to pull full content; store_memory to add)\n${lines.join('\n')}${more}`;
      }
    } catch (error) {
      logger.debug('[buildMemoryContext] manifest list failed:', error);
    }
  }

  return core + manifest;
}
