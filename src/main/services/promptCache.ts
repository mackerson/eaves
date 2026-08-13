import type { Tool } from 'ai';

/**
 * Prompt-cache breakpoints.
 *
 * Tool schemas dominate the prompt: a measured turn sent 44 tools = ~7,400
 * tokens against a 151-token system prompt, and every step of a tool chain
 * resends the whole block. Caching it is the one lever that cuts that without
 * changing what the model can reach or how many steps it takes.
 *
 * There is no provider-neutral way to ask for this, so this is deliberately a
 * per-provider table rather than a single switch:
 *
 *   anthropic   explicit `cache_control` breakpoints — what this module sets
 *   openai      automatic and server-side; a client parameter would be wrong
 *   ollama etc. local, nothing to cache
 *   openrouter  depends on the upstream backend it routes to, which we don't
 *               know at request time (see the sticky-provider pin in ai.ts).
 *               Left alone until measured rather than guessed at.
 *
 * Caching is a *prefix* match and tools render before system and messages, so
 * a single breakpoint on the last tool covers the entire tool block. Anthropic
 * allows at most 4 breakpoints per request; spending one here leaves room for
 * conversation-prefix breakpoints later.
 */

/** Providers whose tool schemas are cached by a breakpoint on the tool itself. */
const EXPLICIT_TOOL_CACHE_PROVIDERS = new Set(['anthropic']);

export function supportsToolCacheBreakpoint(provider: string): boolean {
  return EXPLICIT_TOOL_CACHE_PROVIDERS.has(provider);
}

/**
 * Providers that take the breakpoint on the system message instead.
 *
 * OpenRouter's provider serializes a tool as `{type, function:{name,
 * description, parameters}}` and reads only `eager_input_streaming` from its
 * providerOptions — a tool-level `cache_control` is silently dropped, no error
 * and no effect. It does honor `cache_control` on system and user messages.
 *
 * That still gets us the tool block: Anthropic renders tools BEFORE system, so
 * a breakpoint at the end of system covers everything ahead of it — tools
 * included. Costs nothing extra and reaches the same bytes.
 *
 * The trade is that the cached span now includes the system prompt, so
 * anything volatile in there (a timestamp, a per-turn memory block) breaks the
 * hit that tools alone would have kept. Measure rather than assume.
 */
const SYSTEM_CACHE_PROVIDERS = new Set(['openrouter']);

export function supportsSystemCacheBreakpoint(provider: string): boolean {
  return SYSTEM_CACHE_PROVIDERS.has(provider);
}

/** providerOptions marking a cache breakpoint, understood by both providers. */
export const CACHE_BREAKPOINT_PROVIDER_OPTIONS = {
  anthropic: { cacheControl: { type: 'ephemeral' as const } },
};

/**
 * Return `tools` with a cache breakpoint on its last entry, or the original
 * object when the provider doesn't take one.
 *
 * Never mutates the input: the toolset is assembled per turn but individual
 * tool objects are shared (the builtin table is a module-level literal), so
 * mutating one would leak a breakpoint into every other agent and provider.
 *
 * Key order is the cache's identity — the block only hits if the bytes match
 * the previous turn. Insertion order out of buildToolset is stable for a given
 * agent, so the order is preserved here rather than sorted; re-sorting would
 * change which tool the model sees first for no cache benefit.
 *
 * `activeNames` matters more than it looks. The SDK drops any registered tool
 * missing from `activeTools` before serializing (`prepareToolsAndToolChoice`),
 * so marking a tool that will not be sent silently ships a tools block with no
 * breakpoint at all — losing the whole cache discount with no error anywhere.
 * Pass the active set so the breakpoint lands on the last tool that actually
 * goes on the wire.
 */
export function withToolCacheBreakpoint(
  tools: Record<string, Tool> | undefined,
  provider: string,
  activeNames?: string[],
): Record<string, Tool> | undefined {
  if (!tools) return tools;
  if (!supportsToolCacheBreakpoint(provider)) return tools;

  const active = activeNames ? new Set(activeNames) : undefined;
  const names = Object.keys(tools).filter(name => !active || active.has(name));
  if (names.length === 0) return tools;

  const lastName = names[names.length - 1];
  const lastTool = tools[lastName] as Tool & { providerOptions?: Record<string, unknown> };

  return {
    ...tools,
    [lastName]: {
      ...lastTool,
      providerOptions: {
        ...(lastTool.providerOptions ?? {}),
        anthropic: {
          ...((lastTool.providerOptions?.anthropic as Record<string, unknown>) ?? {}),
          cacheControl: { type: 'ephemeral' },
        },
      },
    } as Tool,
  };
}

/**
 * Providers that honor `cache_control` on a conversation message.
 *
 * Both do. This is the standard multi-turn pattern: mark the last message of
 * the turn you just appended, and the next request reuses the whole prior
 * conversation as a cached prefix. The breakpoint walks forward each turn.
 *
 * Worth knowing what sits between this and the tool block: the system prompt,
 * which carries the agent's core-memory blocks and the compaction summary.
 * Both change during normal operation, and a prefix match means a change there
 * invalidates every message after it. So this breakpoint pays off across a run
 * of turns that don't touch memory, and resets when one does — which is also
 * why Anthropic's tool breakpoint is placed BEFORE system rather than after:
 * the 7.4k tool block stays warm through a memory write, the history doesn't.
 */
const MESSAGE_CACHE_PROVIDERS = new Set(['anthropic', 'openrouter']);

export function supportsMessageCacheBreakpoint(provider: string): boolean {
  return MESSAGE_CACHE_PROVIDERS.has(provider);
}

/**
 * Return `messages` with a cache breakpoint on the last entry. Never mutates —
 * callers pass arrays assembled from persisted rows that other code still holds.
 */
export function withMessageCacheBreakpoint<T extends object>(
  messages: T[],
  provider: string,
): T[] {
  if (!supportsMessageCacheBreakpoint(provider)) return messages;
  if (messages.length === 0) return messages;

  const out = messages.slice();
  const last = out[out.length - 1] as T & { providerOptions?: Record<string, unknown> };
  out[out.length - 1] = {
    ...last,
    providerOptions: { ...(last.providerOptions ?? {}), ...CACHE_BREAKPOINT_PROVIDER_OPTIONS },
  } as T;
  return out;
}
