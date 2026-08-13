/**
 * Map raw AI SDK failures to messages a user can act on.
 *
 * The Vercel AI SDK wraps transport failures as RetryError → APICallError
 * chains whose messages ("Cannot connect to API: ") name neither the
 * endpoint nor the likely fix. Local providers (LM Studio, Ollama) make
 * this the most common failure mode: the server simply isn't running.
 */

const PROVIDER_HINTS: Record<string, string> = {
  lmstudio: 'Make sure LM Studio is running and the server is started.',
  ollama: 'Make sure Ollama is running.',
  // Cloud providers can't be "started" — for these the local end is what's
  // usually at fault, and telling someone to start Anthropic's server is worse
  // than saying nothing.
  anthropic: 'Check your internet connection.',
  openai: 'Check your internet connection.',
  google: 'Check your internet connection.',
  openrouter: 'Check your internet connection.',
};

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH']);

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  cause?: unknown;
  lastError?: unknown;
  url?: string;
  errors?: unknown[];
}

/** Walk cause/lastError/AggregateError chains looking for a connection-level failure. */
function findConnectionFailure(error: unknown, depth = 0): { code?: string; url?: string } | null {
  if (!error || typeof error !== 'object' || depth > 6) return null;
  const err = error as ErrorLike;

  if (err.code && CONNECTION_ERROR_CODES.has(err.code)) return { code: err.code, url: err.url };

  // Descend before the message heuristic: wrapper errors (RetryError) repeat
  // the "Cannot connect" text but only the inner APICallError carries the URL.
  for (const next of [err.lastError, err.cause, ...(Array.isArray(err.errors) ? err.errors : [])]) {
    const found = findConnectionFailure(next, depth + 1);
    if (found) return { ...found, url: found.url || err.url };
  }

  if (typeof err.message === 'string' && (err.message.includes('Cannot connect to API') || err.message.includes('fetch failed'))) {
    return { url: err.url };
  }
  return null;
}

function endpointOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when the failure is transport-level (server down/unreachable) rather than an API/tool error. */
export function isConnectionError(error: unknown): boolean {
  return findConnectionFailure(error) !== null;
}

/** The diagnostic half of a provider failure — everything you'd actually read. */
export interface ProviderErrorSummary {
  name?: string;
  message?: string;
  /** RetryError's reason, e.g. 'maxRetriesExceeded'. */
  reason?: string;
  /** How many attempts the SDK made before giving up. */
  attempts?: number;
  status?: number;
  code?: string;
  url?: string;
  /** The provider's own error body, capped — it names the real cause. */
  responseBody?: string;
}

/** Provider error bodies are the useful part of a 4xx; they are also unbounded. */
const RESPONSE_BODY_CAP = 500;

/**
 * Compact a provider failure down to what a log should hold.
 *
 * The AI SDK's APICallError carries `requestBodyValues` — the entire outgoing
 * request. Logging the error object therefore wrote the system prompt (core
 * memory blocks included), every message in the conversation, and every tool
 * schema to a plaintext file, once per retry attempt: one failed turn against
 * a 4-tool agent produced 22 KB across 538 lines, and a real agent's toolset is
 * an order of magnitude larger. That is both unreadable and the wrong place for
 * conversation content to live, since logs are what people attach to bug
 * reports.
 *
 * Everything here is about the *call*, never its payload.
 */
export function summarizeProviderError(error: unknown): ProviderErrorSummary {
  const summary: ProviderErrorSummary = {};
  if (!error || typeof error !== 'object') {
    return { message: typeof error === 'string' ? error : 'Unknown error' };
  }

  const top = error as ErrorLike & { reason?: string; statusCode?: number; responseBody?: string };
  if (top.name) summary.name = top.name;
  if (top.message) summary.message = top.message;
  if (typeof top.reason === 'string') summary.reason = top.reason;
  if (Array.isArray(top.errors) && top.errors.length > 0) summary.attempts = top.errors.length;

  // The transport details live on the innermost APICallError, not the wrapper.
  const inner = findApiCallError(error) ?? top;
  const detail = inner as ErrorLike & { statusCode?: number; responseBody?: string };
  if (typeof detail.statusCode === 'number') summary.status = detail.statusCode;
  if (detail.url) summary.url = detail.url;
  if (typeof detail.responseBody === 'string' && detail.responseBody.trim()) {
    summary.responseBody = detail.responseBody.length > RESPONSE_BODY_CAP
      ? `${detail.responseBody.slice(0, RESPONSE_BODY_CAP)}… [truncated]`
      : detail.responseBody;
  }

  const connection = findConnectionFailure(error);
  if (connection?.code) summary.code = connection.code;
  if (!summary.url && connection?.url) summary.url = connection.url;

  return summary;
}

/** First node in the chain carrying transport detail (url/status/body). */
function findApiCallError(error: unknown, depth = 0): ErrorLike | null {
  if (!error || typeof error !== 'object' || depth > 6) return null;
  const err = error as ErrorLike & { statusCode?: number; responseBody?: string };
  if (err.url || typeof err.statusCode === 'number' || typeof err.responseBody === 'string') return err;

  for (const next of [err.lastError, err.cause, ...(Array.isArray(err.errors) ? err.errors : [])]) {
    const found = findApiCallError(next, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Human-readable message for an AI call failure. Connection-level failures
 * are rewritten to name the endpoint and provider fix; anything else falls
 * through to the original error message.
 *
 * `fallbackEndpoint` names the server when the error itself doesn't. A bare
 * `TypeError: fetch failed` from undici carries the refusal in `cause.code`
 * and nothing else, so a caller that already knows which URL it dialled should
 * pass it — otherwise the message can only say "the model server", which is
 * unhelpful precisely when someone has several configured.
 */
export function friendlyAIErrorMessage(error: unknown, provider?: string, fallbackEndpoint?: string): string {
  const failure = findConnectionFailure(error);
  if (failure) {
    const endpoint = endpointOf(failure.url) ?? endpointOf(fallbackEndpoint);
    const hint = (provider && PROVIDER_HINTS[provider]) || 'Check that the model server is running and reachable.';
    return `Cannot reach the model server${endpoint ? ` at ${endpoint}` : ''}. ${hint}`;
  }
  const message = (error as ErrorLike | null | undefined)?.message;
  if (typeof message === 'string' && message.trim()) return message;
  return 'Unknown error occurred';
}
