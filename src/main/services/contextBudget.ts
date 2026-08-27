import { getContextWindow } from '../../shared/pricing';
import { DEFAULT_MAX_OUTPUT_TOKENS, RESOLVED_MAX_OUTPUT_CEILING } from '../../shared/providers';
import { getCachedModelContext } from './modelContextCache';
import { logger } from './logger';
import type { Agent } from '../types';

/**
 * Context Budget System
 *
 * Manages token allocation for models with limited context windows.
 * Estimates token counts, allocates budgets for system prompt tiers
 * and message history, and provides message windowing.
 */

// Rough token estimation: ~4 chars per token for English text.
// Conservative (overestimates) to avoid overflowing small context windows.
const CHARS_PER_TOKEN = 3.5;

/**
 * Per-image flat cost. Real bill varies by provider/resolution (Anthropic
 * ~85-1500, OpenAI ~85-2000) — pick the high end of the typical range so
 * we err toward keeping fewer messages than too many.
 */
const IMAGE_TOKEN_COST = 1500;

/** Estimate token count from a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface MaybePart {
  type?: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  image?: unknown;
  data?: unknown;
  toolName?: string;
  approvalId?: string;
  reason?: string;
}

/**
 * Estimate the token cost of a single message's content payload.
 *
 * Why not `JSON.stringify(content)`? Two reasons:
 *   1. Multi-part content (the SDK's ResponseMessages shape) is an array. The
 *      stringify includes every key name (`"type":"text","text":"..."`), so
 *      billable text gets ~15% padding from JSON.
 *   2. Image / file-data parts contain base64 blobs. A 100 KB inline image
 *      stringifies to ~30,000 chars; the actual model bill is ~85-1500 tokens.
 *      Stringify overcounts by 30x and triggers needless windowing.
 *
 * Walk the structure and sum semantic content: text parts → estimateTokens(text);
 * media parts → flat IMAGE_TOKEN_COST; tool-call/result parts → text-equivalent
 * of their input/output (recursively for content arrays).
 */
function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) {
    // Object content (e.g. a single ContentPart) — fall through to part walker.
    return estimatePartTokens(content as MaybePart);
  }
  let total = 0;
  for (const part of content) total += estimatePartTokens(part as MaybePart);
  return total;
}

function estimatePartTokens(part: MaybePart): number {
  if (!part || typeof part !== 'object') return 0;
  switch (part.type) {
    case 'text':
      return estimateTokens(typeof part.text === 'string' ? part.text : '');
    case 'image':
    case 'image-data':
    case 'image-url':
    case 'image-file-id':
    case 'file':
    case 'file-data':
    case 'file-url':
    case 'file-id':
    case 'media':
      return IMAGE_TOKEN_COST;
    case 'tool-call':
      // Input is a small JSON object — count keys + values flatly.
      return estimateTokens(safeStringify(part.input)) + estimateTokens(part.toolName ?? '');
    case 'tool-result':
      return estimateToolResultOutput(part.output) + estimateTokens(part.toolName ?? '');
    case 'tool-approval-request':
    case 'tool-approval-response':
      return estimateTokens(part.approvalId ?? '') + estimateTokens(part.reason ?? '');
    case 'reasoning':
      return estimateTokens(typeof part.text === 'string' ? part.text : '');
    default: {
      // Unknown part — fall back to safe stringify of just the part's primitives
      // so we don't recurse into nested base64 blobs.
      const flat = part.text ?? part.content ?? part.data ?? part.input ?? part.output ?? '';
      return estimateTokens(safeStringify(flat));
    }
  }
}

/**
 * An SDK tool-result `output` is a tagged wrapper, not a content part:
 *   { type: 'text' | 'error-text', value: string }
 *   { type: 'json' | 'error-json', value: JSONValue }
 *   { type: 'content', value: Array<{ type: 'text' } | { type: 'media' }> }
 * The generic part-walker's fallback keys (text/content/data/…) miss `value`,
 * so without unwrapping it here a tool result scores ~0 tokens — a giant output
 * (e.g. an 11KB list_tools result) sails past the budget uncounted, compaction
 * and windowing never fire, and a small local context window overflows with a
 * server 400.
 */
function estimateToolResultOutput(output: unknown): number {
  if (output && typeof output === 'object' && !Array.isArray(output) && 'value' in output) {
    const { type, value } = output as { type?: string; value?: unknown };
    if (type === 'content' && Array.isArray(value)) {
      let total = 0;
      for (const item of value) {
        const it = item as MaybePart;
        total += it?.type === 'media'
          ? IMAGE_TOKEN_COST
          : estimateTokens(typeof it?.text === 'string' ? it.text : safeStringify(it));
      }
      return total;
    }
    return estimateTokens(typeof value === 'string' ? value : safeStringify(value));
  }
  // Untagged shapes (raw string, content-part arrays) — generic walker.
  return estimateContentTokens(output);
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; }
  catch { return String(value); }
}

interface MaybeMessage {
  content?: unknown;
  toolCalls?: unknown[];
}

/**
 * Estimate the token cost of a single message — content + the sidecar
 * `toolCalls` array that some message shapes carry alongside content
 * instead of as tool-call content parts. Exported for test coverage
 * and so the windowing call sites can reuse the same math when they want
 * to log per-message budget details.
 */
export function estimateMessageTokens(msg: MaybeMessage): number {
  let total = estimateContentTokens(msg.content);
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) total += estimatePartTokens({ type: 'tool-call', ...(tc as MaybePart) });
  }
  return total;
}

/** Size class determines how aggressively we trim. */
export type ModelSizeClass = 'tiny' | 'small' | 'medium' | 'large';

export function getModelSizeClass(contextWindow: number): ModelSizeClass {
  if (contextWindow <= 4096) return 'tiny';
  if (contextWindow <= 16384) return 'small';
  if (contextWindow <= 32768) return 'medium';
  return 'large';
}

export interface ResolveContextOptions {
  /**
   * Endpoint the caller is targeting (for local providers, after credential
   * resolution). Used to scope the model-context cache lookup so a baseURL
   * change or multi-host setup doesn't serve another instance's window.
   */
  endpoint?: string;
}

/**
 * Resolve the effective context window for an agent's model.
 * Priority: agent override (clamped to detected loaded) → detected → known
 * model table → provider-based default.
 */
export function resolveContextWindow(agent: Agent, opts: ResolveContextOptions = {}): number {
  const detected = getCachedModelContext(agent.provider, agent.model, opts.endpoint);

  // 1. Agent-level override (user configured). Clamp against the detected
  //    loaded window when we have one — sending past `loaded_context_length`
  //    makes the runtime reject with n_keep >= n_ctx, so the override can
  //    never usefully exceed what the server actually allocated.
  if (agent.contextWindow && agent.contextWindow > 0) {
    if (detected?.loadedContextLength && agent.contextWindow > detected.loadedContextLength) {
      return detected.loadedContextLength;
    }
    return agent.contextWindow;
  }

  // 2. Live-detected window for local models (LM Studio / Ollama). Warmed by
  //    callers before this runs and by the agent editor; beats the static
  //    table because a local server's actual window is ground truth.
  if (detected?.contextWindow) return detected.contextWindow;

  // 3. Known model lookup
  const known = getContextWindow(agent.model);
  if (known) return known;

  // 4. Provider-based defaults for unknown models
  switch (agent.provider) {
    case 'anthropic': return 200_000;
    case 'openai': return 128_000;
    case 'google': return 1_048_576;
    // OpenRouter routes to many backends — pick a sane mid-tier default;
    // user can override on the agent if their chosen model has more.
    case 'openrouter': return 128_000;
    case 'ollama': return 4_096; // Conservative default for local models
    case 'lmstudio': return 4_096;
    default: return 4_096;
  }
}

/**
 * Resolve how many output tokens this turn may actually produce.
 *
 * This used to be `agent.maxOutputTokens || 4096`, written out twice — once
 * here as the budget's `outputReserve` and once in ai.ts as the value actually
 * sent — and the two were free to disagree, which they did: the budget would
 * reserve 2048 for a small local model while the request still asked for 4096.
 * One function, both callers.
 *
 * Priority mirrors `resolveContextWindow`, for the same reason: the user's
 * explicit number wins, then what the provider says about *this* model, then a
 * flat default.
 *
 * 1. **Agent override.** Deliberate, so it is honoured as written and only
 *    clamped against the context window (asking for more output than the whole
 *    window is not a request any provider can serve).
 * 2. **Provider-reported.** OpenRouter publishes `max_completion_tokens` for
 *    nearly every model it routes. Capped at RESOLVED_MAX_OUTPUT_CEILING —
 *    a blank field should fix the clipping, not quietly authorise a 64k reply.
 * 3. **Default.** The historical 4096.
 *
 * The window clamp applies only when the window is *known*. A local provider
 * whose model has not JIT-loaded yet reports nothing, and the fallback we
 * substitute (4096) is a guess — halving an output cap on the strength of a
 * guess is how the first message to a cold LM Studio came back truncated.
 */
export function resolveMaxOutputTokens(agent: Agent, opts: ResolveContextOptions = {}): number {
  const windowKnown = isContextWindowKnown(agent, opts);
  const contextWindow = resolveContextWindow(agent, opts);
  // Leave room for at least a token of input; a cap equal to the whole window
  // cannot be satisfied.
  const windowCeiling = windowKnown ? Math.floor(contextWindow * 0.75) : Infinity;

  if (agent.maxOutputTokens && agent.maxOutputTokens > 0) {
    return Math.max(1, Math.min(agent.maxOutputTokens, windowCeiling));
  }

  const detected = getCachedModelContext(agent.provider, agent.model, opts.endpoint);
  if (detected?.maxOutputTokens) {
    return Math.max(
      1,
      Math.min(detected.maxOutputTokens, RESOLVED_MAX_OUTPUT_CEILING, windowCeiling),
    );
  }

  return Math.max(1, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, windowCeiling));
}

/**
 * Whether `resolveContextWindow` is about to return something real or a
 * provider-shaped guess. Only the first three branches are knowledge; the
 * `switch` at the end is a fallback, and callers that would penalise a small
 * window need to be able to tell the difference.
 */
export function isContextWindowKnown(agent: Agent, opts: ResolveContextOptions = {}): boolean {
  if (agent.contextWindow && agent.contextWindow > 0) return true;
  if (getCachedModelContext(agent.provider, agent.model, opts.endpoint)?.contextWindow) return true;
  return !!getContextWindow(agent.model);
}

export interface ContextBudget {
  /** Total context window in tokens */
  contextWindow: number;
  /** Tokens reserved for model output */
  outputReserve: number;
  /** Tokens available for input (system prompt + messages) */
  inputBudget: number;
  /** Max tokens for system prompt */
  systemPromptBudget: number;
  /** Max tokens for message history */
  messageBudget: number;
  /** Model size classification */
  sizeClass: ModelSizeClass;
  /** Whether tools should be included in the request */
  includeTools: boolean;
}

/**
 * Warm the live context-window cache, then compute this turn's budget.
 *
 * Every turn path needs the same four lines in the same order, and the order
 * matters: without the detection pass first, a local provider falls back to the
 * conservative 4096 default, which classifies as 'tiny' and trims the agent
 * down to the discovery tools — on a server that may actually have a 128k
 * window loaded. Threading `endpoint` through both the warm and the budget
 * scopes the cache hit to this exact server, so a different baseURL or a
 * multi-host setup can't serve another instance's window.
 *
 * Detection is cached and best-effort; a failure degrades to the static table
 * rather than blocking the turn.
 */
export async function resolveTurnBudget(agent: Agent): Promise<ContextBudget> {
  const { detectModelContext, resolveDetectEndpoint } = await import('./modelContext');
  const endpoint = resolveDetectEndpoint(agent.provider);
  await detectModelContext(agent.provider, agent.model).catch(() => null);
  return computeContextBudget(agent, { endpoint });
}

/**
 * Compute token budgets for a request.
 * Allocates output reserve, then splits remaining between system prompt and messages.
 */
export function computeContextBudget(agent: Agent, opts: ResolveContextOptions = {}): ContextBudget {
  const contextWindow = resolveContextWindow(agent, opts);
  const sizeClass = getModelSizeClass(contextWindow);

  // The same number the request will actually send — see resolveMaxOutputTokens.
  // Computing it twice is how the reserve and the request came to disagree.
  const maxOutputTokens = resolveMaxOutputTokens(agent, opts);

  // Reserve output tokens (capped at 50% of context for tiny models). Only
  // when the window is genuinely known to be tiny: a cold local server reports
  // nothing and gets the 4096 fallback, and halving a cap on that basis
  // truncated the first message of every session.
  const outputReserve = sizeClass === 'tiny' && isContextWindowKnown(agent, opts)
    ? Math.min(maxOutputTokens, Math.floor(contextWindow * 0.5))
    : maxOutputTokens;

  // Cap the *budgeted* input independently of the raw window. Ultra-large
  // windows (1M–2.5M) otherwise let history grow to hundreds of thousands of
  // tokens before it crosses budget and compaction fires — so an expensive
  // model silently re-sends an ever-growing transcript every turn, which is how
  // a 2.5M-window model quietly runs up a large bill. Models with normal
  // windows (≤ this cap) are unaffected. Tunable: raise for longer working
  // context, lower to compact sooner / spend less.
  const MAX_BUDGETED_INPUT_TOKENS = 256_000;
  const inputBudget = Math.min(contextWindow - outputReserve, MAX_BUDGETED_INPUT_TOKENS);

  // Split input budget between system prompt and messages based on size class
  let systemPromptRatio: number;
  switch (sizeClass) {
    case 'tiny': systemPromptRatio = 0.3; break;   // 30% system, 70% messages
    case 'small': systemPromptRatio = 0.35; break;  // 35% system, 65% messages
    case 'medium': systemPromptRatio = 0.4; break;   // 40% system, 60% messages
    case 'large': systemPromptRatio = 0.5; break;    // 50% system, 50% messages (generous)
  }

  const systemPromptBudget = Math.floor(inputBudget * systemPromptRatio);
  const messageBudget = inputBudget - systemPromptBudget;

  // Only include tools for models with enough headroom
  // Tools can easily consume 1000+ tokens for schema definitions
  const includeTools = sizeClass !== 'tiny';

  logger.debug('[ContextBudget] Computed budget', {
    model: agent.model,
    provider: agent.provider,
    contextWindow,
    sizeClass,
    outputReserve,
    inputBudget,
    systemPromptBudget,
    messageBudget,
    includeTools,
  });

  return {
    contextWindow,
    outputReserve,
    inputBudget,
    systemPromptBudget,
    messageBudget,
    sizeClass,
    includeTools,
  };
}

/**
 * Trim message history to fit within a token budget.
 * Removes oldest messages first, always keeping the most recent message.
 */
export function windowMessages<T extends { content: string | unknown[]; toolCalls?: unknown[] }>(
  messages: T[],
  tokenBudget: number,
): T[] {
  if (messages.length === 0) return messages;

  // Estimate tokens per message using the part-walker (not JSON.stringify) so
  // images and tool-result media don't blow up the count by 30x.
  const messageSizes = messages.map(msg => estimateMessageTokens(msg));

  const totalTokens = messageSizes.reduce((sum, size) => sum + size, 0);

  // If everything fits, return as-is
  if (totalTokens <= tokenBudget) return messages;

  logger.info('[ContextBudget] Windowing messages to fit budget', {
    originalCount: messages.length,
    totalTokens,
    tokenBudget,
  });

  // Keep messages from the end until we exceed the budget
  const result: T[] = [];
  let usedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = messageSizes[i];
    if (usedTokens + msgTokens > tokenBudget && result.length > 0) {
      // We can't fit this message; stop here
      break;
    }
    result.unshift(messages[i]);
    usedTokens += msgTokens;
  }

  logger.info('[ContextBudget] Message windowing complete', {
    originalCount: messages.length,
    keptCount: result.length,
    trimmedCount: messages.length - result.length,
    estimatedTokens: usedTokens,
  });

  return result;
}
