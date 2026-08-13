/**
 * Runtime tool inventory — enumerates the tools actually available to agents,
 * tagged by source, with an approximate per-turn schema token cost.
 *
 * This is the non-spawning subset of what `buildToolset` assembles: built-in +
 * agent-scoped (channel) tools, plus tools registered by loaded plugins. It
 * deliberately does NOT include MCP-server tools — enumerating those means
 * connecting to (spawning) the servers, which is too heavy for an editor-time
 * query. MCP is surfaced by configured server instead (Connections section).
 *
 * Token cost uses the same char-based heuristic (`estimateTokens`) the context
 * budgeter uses, over the tool's name + description + input-schema field names
 * and their descriptions — the dominant token contributors. It's an estimate,
 * labelled as such in the UI; it is never presented as exact.
 */

import { builtinTools } from './builtinTools';
import { createChannelTools } from './channelTools';
import { createTranscriptTools } from './transcriptTools';
import { getSandboxedPluginManager } from './sandbox';
import { estimateTokens } from './contextBudget';
import type { ToolInventoryEntry } from '../../shared/toolCatalog';
import { logger } from './logger';

/**
 * Approximate the tokens a tool definition contributes to a request. Reads the
 * name, description, and (from the Zod input schema's `.shape`, present on both
 * v3 and v4 object schemas) each field's name, description, and type — the
 * text that actually rides along. Nested schemas are under-counted; this is a
 * proportional estimate, not the exact wire size.
 */
function sizeTool(name: string, def: unknown): number {
  const d = def as { description?: unknown; inputSchema?: any; parameters?: any };
  const parts: string[] = [name];
  if (typeof d?.description === 'string') parts.push(d.description);

  const schema = d?.inputSchema ?? d?.parameters;
  const shape = schema?.shape;
  if (shape && typeof shape === 'object') {
    for (const [field, zt] of Object.entries<any>(shape)) {
      parts.push(field);
      const desc = zt?.description ?? zt?._def?.description;
      if (typeof desc === 'string') parts.push(desc);
      const typeName = zt?._def?.typeName ?? zt?._def?.type;
      if (typeName) parts.push(String(typeName));
    }
  }
  return estimateTokens(parts.join(' '));
}

/**
 * Enumerate available tools with source + token estimate. Cheap and
 * side-effect-free — safe to call whenever the editor opens.
 */
export function getToolInventory(): ToolInventoryEntry[] {
  const entries: ToolInventoryEntry[] = [];

  // Built-in + agent-scoped channel tools. Schemas are identical regardless of
  // agent/channel, so placeholder ids are fine for enumeration.
  const channelTools = createChannelTools('__inventory__', '');
  const transcriptTools = createTranscriptTools('__inventory__');
  const builtin: Record<string, unknown> = { ...builtinTools, ...channelTools, ...transcriptTools };
  for (const [name, def] of Object.entries(builtin)) {
    const description = (def as { description?: unknown })?.description;
    entries.push({
      name,
      description: typeof description === 'string' ? description : '',
      source: 'builtin',
      estTokens: sizeTool(name, def),
    });
  }

  // Tools registered by currently-loaded plugins. No spawning — just the live map.
  try {
    const pluginTools = getSandboxedPluginManager().getRegisteredTools();
    for (const [name, def] of Object.entries(pluginTools)) {
      if (builtin[name]) continue; // built-in wins on conflict (mirrors buildToolset)
      const description = (def as { description?: unknown })?.description;
      entries.push({
        name,
        description: typeof description === 'string' ? description : '',
        source: 'plugin',
        estTokens: sizeTool(name, def),
      });
    }
  } catch (err) {
    logger.warn('[toolInventory] plugin tools unavailable', { err: String(err) });
  }

  return entries;
}
