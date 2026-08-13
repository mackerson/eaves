/**
 * Provider adapters — main-process factories for creating SDK model instances
 * and fetching available models.
 *
 * Each adapter owns two concerns:
 * - createLanguageModel(): returns an AI SDK LanguageModel for a given model id
 *   and credentials. Called by chat streaming (ai.ts) and OOBE generate.
 * - fetchModels(): lists models callable by the caller's API key or endpoint.
 *   Called by the agent editor and OOBE provider validation.
 *
 * Consumers go through getProviderAdapter(id) and never touch @ai-sdk/* or raw
 * HTTP directly. That keeps provider-specific quirks contained here so adding
 * a new provider is one file change.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { logger } from './logger';
import { ProviderId, ModelCapabilities, ModelContextInfo, getProvider } from '../../shared/providers';
import { friendlyAIErrorMessage } from '../utils/aiErrors';

export interface FetchModelsResult {
  success: boolean;
  models?: string[];
  error?: string;
}

export interface CreateModelOptions {
  /** API key for cloud providers, or an endpoint URL for local providers. */
  apiKey?: string;
  /** Explicit base URL override (local providers only). */
  baseURL?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  createLanguageModel(modelId: string, opts: CreateModelOptions): LanguageModel;
  fetchModels(opts: CreateModelOptions): Promise<FetchModelsResult>;
  /**
   * Capabilities for a specific model. Falls through to the registry's
   * defaultCapabilities when an adapter has no special-case rules.
   */
  getCapabilities(modelId: string): ModelCapabilities;
  /**
   * Live-detect a model's context window from the provider's native API.
   * Only local providers (LM Studio, Ollama) expose this metadata; cloud
   * adapters omit the method and callers fall back to the known-model table /
   * provider default. Returns null when the model isn't found or unreachable.
   */
  detectContext?(modelId: string, opts: CreateModelOptions): Promise<ModelContextInfo | null>;
}

/** Resolve the provider's defaultCapabilities, with optimistic fallback. */
function defaultCapabilitiesFor(providerId: ProviderId): ModelCapabilities {
  const meta = getProvider(providerId);
  return meta?.defaultCapabilities ?? {
    temperature: true, topP: true, stopSequences: true,
    rawPrompt: false, maxOutputTokens: true, toolUse: true,
  };
}

// ─── Anthropic ────────────────────────────────────────────────────────────

// Anthropic's "reasoning-first" line (Opus 4.5+, Sonnet 4.5+ thinking-default
// variants, Haiku 4.5+) rejects `temperature` and `top_p` at the API. The
// SDK strips them when extended-thinking is explicitly enabled, but doesn't
// know which models default to thinking — so we maintain a regex here. When
// a future model breaks this rule, the SDK silently drops the param and the
// optimistic-default keeps the slider working; we tighten the rule on report.
function anthropicReasoningModel(modelId: string): boolean {
  return /^claude-(opus-4-[5-9]|sonnet-4-[5-9]|haiku-4-[5-9])/.test(modelId);
}

const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  createLanguageModel(modelId, { apiKey }) {
    if (!apiKey) throw new Error('Anthropic API key not set. Add it in Settings → Providers.');
    return createAnthropic({ apiKey })(modelId);
  },
  getCapabilities(modelId) {
    const base = defaultCapabilitiesFor('anthropic');
    if (anthropicReasoningModel(modelId)) {
      return { ...base, temperature: false, topP: false };
    }
    return base;
  },
  async fetchModels({ apiKey }) {
    if (!apiKey) return { success: false, error: 'Anthropic API key not configured. Add it in Settings → Providers.' };
    try {
      const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }
      const data = await response.json() as { data?: { id?: string }[] };
      const models = (data.data?.map(m => m.id).filter(Boolean) || []) as string[];
      return { success: true, models };
    } catch (error) {
      return fetchError('anthropic', error, 'https://api.anthropic.com');
    }
  },
};

// ─── OpenAI ───────────────────────────────────────────────────────────────

// o1/o3/o4-class models reject sampling params and stop sequences.
function openaiReasoningModel(modelId: string): boolean {
  return /^(o1|o3|o4)/.test(modelId);
}

const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  createLanguageModel(modelId, { apiKey }) {
    if (!apiKey) throw new Error('OpenAI API key not set. Add it in Settings → Providers.');
    return createOpenAI({ apiKey })(modelId);
  },
  getCapabilities(modelId) {
    const base = defaultCapabilitiesFor('openai');
    if (openaiReasoningModel(modelId)) {
      return { ...base, temperature: false, topP: false, stopSequences: false };
    }
    return base;
  },
  async fetchModels({ apiKey }) {
    if (!apiKey) return { success: false, error: 'OpenAI API key not configured. Add it in Settings → Providers.' };
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }
      const data = await response.json() as { data?: { id?: string }[] };
      const models = (data.data?.map(m => m.id).filter(Boolean) || []) as string[];
      return { success: true, models };
    } catch (error) {
      return fetchError('openai', error, 'https://api.openai.com');
    }
  },
};

// ─── Google ───────────────────────────────────────────────────────────────

const googleAdapter: ProviderAdapter = {
  id: 'google',
  createLanguageModel(modelId, { apiKey }) {
    if (!apiKey) throw new Error('Google API key not set. Add it in Settings → Providers.');
    return createGoogleGenerativeAI({ apiKey })(modelId);
  },
  getCapabilities() {
    // Gemini accepts the standard sampling params across all current models.
    return defaultCapabilitiesFor('google');
  },
  async fetchModels({ apiKey }) {
    if (!apiKey) return { success: false, error: 'Google API key not configured. Add it in Settings → Providers.' };
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }
      const data = await response.json() as { models?: { name?: string }[] };
      const models = (data.models
        ?.map(m => m.name?.replace('models/', '') || '')
        .filter(id => id.startsWith('gemini'))
        || []) as string[];
      return { success: true, models };
    } catch (error) {
      return fetchError('google', error, 'https://generativelanguage.googleapis.com');
    }
  },
};

// ─── OpenRouter (OpenAI-compatible aggregator) ────────────────────────────
//
// Sits in front of 200+ models from a dozen backends. We use the official
// @openrouter/ai-sdk-provider (not @ai-sdk/openai + baseURL) so we get the
// served upstream in providerMetadata.openrouter.provider — the signal the
// sticky-provider pinning in ai.ts reads to keep a conversation on one backend
// for prompt-cache continuity — plus real per-turn cost/cached-token accounting.
// `getCapabilities` consults a cached `supported_parameters` map populated
// by `fetchModels` — OpenRouter is uniquely structured to give us that
// per-model truth, so we use it instead of a regex like the native
// providers' reasoning-model matchers.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface OpenRouterModelMeta {
  id?: string;
  supported_parameters?: string[];
  // OpenRouter reports the model's max window at the top level and the window
  // the *default/served* provider actually allocates under `top_provider`.
  // With sticky-provider pinning on, the served window is what a request is
  // validated against, so prefer top_provider when present.
  context_length?: number;
  top_provider?: { context_length?: number };
}

const openrouterCapabilityCache = new Map<string, ModelCapabilities>();

function applyOpenRouterParams(modelId: string, supported: string[]): void {
  const base = defaultCapabilitiesFor('openrouter');
  const capabilities: ModelCapabilities = {
    ...base,
    temperature: supported.includes('temperature'),
    topP: supported.includes('top_p'),
    stopSequences: supported.includes('stop'),
    toolUse: supported.includes('tools') || supported.includes('tool_choice'),
    // maxOutputTokens: SDK uses `max_tokens` field; OpenRouter advertises it
    // for nearly every model that accepts any output cap, so default to true
    // unless the model explicitly omits the param.
    maxOutputTokens: supported.length === 0 ? base.maxOutputTokens : supported.includes('max_tokens'),
  };
  openrouterCapabilityCache.set(modelId, capabilities);
}

const openrouterAdapter: ProviderAdapter = {
  id: 'openrouter',
  createLanguageModel(modelId, { apiKey }) {
    if (!apiKey) throw new Error('OpenRouter API key not set. Add it in Settings → Providers.');
    // usage.include turns on OpenRouter usage accounting so responses carry
    // real cost + cached-token counts in providerMetadata.openrouter.usage
    // (no extra /generation call). .chat() pins the Chat Completions shape.
    return createOpenRouter({ apiKey }).chat(modelId, { usage: { include: true } });
  },
  getCapabilities(modelId) {
    return openrouterCapabilityCache.get(modelId) ?? defaultCapabilitiesFor('openrouter');
  },
  async fetchModels({ apiKey }) {
    if (!apiKey) return { success: false, error: 'OpenRouter API key not configured. Add it in Settings → Providers.' };
    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }
      const data = await response.json() as { data?: OpenRouterModelMeta[] };
      const ids: string[] = [];
      for (const m of data.data ?? []) {
        if (typeof m.id !== 'string') continue;
        ids.push(m.id);
        if (Array.isArray(m.supported_parameters)) {
          applyOpenRouterParams(m.id, m.supported_parameters);
        }
      }
      return { success: true, models: ids };
    } catch (error) {
      return fetchError('openrouter', error, 'https://openrouter.ai');
    }
  },
  // OpenRouter's /models payload already carries each model's context window —
  // `top_provider.context_length` (what the served backend allocates; the value
  // a sticky-pinned request is validated against) with the top-level
  // `context_length` (model max) as fallback. Without this the budget path has
  // no window for any of the 200+ OR models and falls back to a blanket 128k
  // default, which under-shoots large models (premature compaction) and
  // over-shoots small routes (provider 400 on overflow). Detected windows are
  // cached by the detectModelContext orchestrator (hit TTL, concurrent-probe
  // dedup), so this fetches at most once per model per few minutes.
  async detectContext(modelId, { apiKey }) {
    if (!apiKey) return null;
    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) return null;
      const data = await response.json() as { data?: OpenRouterModelMeta[] };
      const meta = (data.data ?? []).find(m => m.id === modelId);
      if (!meta) return null;
      const served = numericOrUndefined(meta.top_provider?.context_length);
      const max = numericOrUndefined(meta.context_length);
      const window = served ?? max;
      if (!window) return null;
      return { contextWindow: window, maxContextLength: max ?? window, source: 'openrouter-api' };
    } catch (error) {
      logger.debug('[providers] OpenRouter context detect failed', {
        modelId, error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
};

// ─── Ollama (via its OpenAI-compatible /v1 endpoint) ──────────────────────
//
// We dropped the dedicated ollama-ai-provider package during the AI SDK v6
// upgrade — its maintained v2 requires zod@4 in a way that cascaded poorly,
// and Ollama's built-in OpenAI-compatible endpoint works fine with
// createOpenAI. One fewer package to keep current. The /api/tags listing is
// still Ollama-native.

const OLLAMA_DEFAULT_ROOT = 'http://localhost:11434';

const ollamaAdapter: ProviderAdapter = {
  id: 'ollama',
  createLanguageModel(modelId, { apiKey, baseURL }) {
    const root = baseURL || apiKey || OLLAMA_DEFAULT_ROOT;
    // .chat() — Ollama's /v1 is Chat-Completions-shaped only; Responses API
    // (the v6 default) would 404 / 400 here.
    return createOpenAI({ baseURL: `${root}/v1`, apiKey: 'ollama' }).chat(modelId);
  },
  getCapabilities() {
    // Local models accept the full sampling toolkit through Ollama's
    // OpenAI-compatible adapter; tool-use depends on the underlying model
    // but most modern Llama/Qwen/Mistral checkpoints support it.
    return defaultCapabilitiesFor('ollama');
  },
  async fetchModels({ apiKey, baseURL }) {
    const root = baseURL || apiKey || OLLAMA_DEFAULT_ROOT;
    try {
      const response = await fetch(`${root}/api/tags`);
      if (!response.ok) {
        // Answering at all means it was reached — "cannot reach" would send
        // someone off to restart a server that is already up.
        return { success: false, error: `Ollama at ${root} answered HTTP ${response.status}. Check the endpoint in Settings → Providers.` };
      }
      const data = await response.json() as { models?: { name?: string }[] };
      const models = (data.models?.map(m => m.name).filter(Boolean) || []) as string[];
      if (models.length === 0) {
        return { success: false, error: `Ollama is running at ${root} but has no models installed. Pull one with \`ollama pull <model>\`.` };
      }
      return { success: true, models };
    } catch (error) {
      return fetchError('ollama', error, root);
    }
  },
  // Ollama's /api/show exposes the architecture's true context length under
  // model_info as `<arch>.context_length` (e.g. "gemma3.context_length").
  // It doesn't report the running num_ctx, so we surface max only.
  async detectContext(modelId, { apiKey, baseURL }) {
    const root = baseURL || apiKey || OLLAMA_DEFAULT_ROOT;
    try {
      const response = await fetch(`${root}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      if (!response.ok) return null;
      const data = await response.json() as { model_info?: Record<string, unknown> };
      const info = data.model_info ?? {};
      const ctxKey = Object.keys(info).find(k => k.endsWith('.context_length'));
      const max = ctxKey ? numericOrUndefined(info[ctxKey]) : undefined;
      if (!max) return null;
      return { contextWindow: max, maxContextLength: max, source: 'ollama-api' };
    } catch (error) {
      logger.debug('[providers] Ollama context detect failed', {
        modelId, error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
};

// ─── LM Studio (OpenAI-compatible) ────────────────────────────────────────

const lmstudioAdapter: ProviderAdapter = {
  id: 'lmstudio',
  createLanguageModel(modelId, { apiKey, baseURL }) {
    const endpoint = normalizeLmStudioUrl(baseURL || apiKey || 'http://localhost:1234/v1');
    // .chat() — LM Studio's /v1 mirrors Chat Completions only.
    return createOpenAI({ baseURL: endpoint, apiKey: 'lm-studio' }).chat(modelId);
  },
  getCapabilities() {
    return defaultCapabilitiesFor('lmstudio');
  },
  async fetchModels({ apiKey, baseURL }) {
    const endpoint = normalizeLmStudioUrl(baseURL || apiKey || 'http://localhost:1234/v1');
    try {
      const response = await fetch(`${endpoint}/models`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        return { success: false, error: `LM Studio at ${endpoint} answered HTTP ${response.status}. Check the endpoint in Settings → Providers.` };
      }
      const data = await response.json() as { data?: { id?: string }[] };
      const models = (data.data?.map(m => m.id).filter(Boolean) || []) as string[];
      if (models.length === 0) {
        // The server runs with nothing loaded — an empty dropdown and no
        // explanation is the same dead end as a failed fetch.
        return { success: false, error: `LM Studio is running at ${endpoint} but has no models loaded. Load one in LM Studio, then refresh.` };
      }
      return { success: true, models };
    } catch (error) {
      return fetchError('lmstudio', error, endpoint);
    }
  },
  // LM Studio's OpenAI-compat /v1/models only returns ids. Its *native* REST
  // API at /api/v0/models carries per-model context metadata, so we hit that.
  async detectContext(modelId, { apiKey, baseURL }) {
    const restRoot = lmStudioRestRoot(baseURL || apiKey || 'http://localhost:1234/v1');
    try {
      const response = await fetch(`${restRoot}/api/v0/models`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) return null;
      const data = await response.json() as { data?: LmStudioModelMeta[] };
      const entry = data.data?.find(m => m.id === modelId);
      if (!entry) return null;
      const max = numericOrUndefined(entry.max_context_length);
      const loaded = numericOrUndefined(entry.loaded_context_length);
      // Budget against what the server actually loaded — sending past it makes
      // LM Studio reject the whole request (n_keep >= n_ctx). `max` is the
      // model's capability, surfaced separately in the UI so the user knows to
      // raise the loader.
      //
      // A not-loaded model reports ONLY max_context_length. What the server
      // will allocate when it JIT-loads comes from LM Studio's per-model
      // context setting, which this API doesn't expose — so treat it as
      // unknown rather than trusting max. (Trusting max let a 256k-capable
      // model JIT-loaded at 8k get a ~130k message budget: no compaction, and
      // generation hit the real 8k wall mid-sentence.) The null is cached
      // under the short miss TTL, so the first request's JIT load reveals the
      // real window within seconds.
      if (!loaded && entry.state && entry.state !== 'loaded') return null;
      const contextWindow = loaded ?? max;
      if (!contextWindow) return null;
      return { contextWindow, maxContextLength: max, loadedContextLength: loaded, source: 'lmstudio-api' };
    } catch (error) {
      logger.debug('[providers] LM Studio context detect failed', {
        modelId, error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
};

interface LmStudioModelMeta {
  id?: string;
  state?: string; // 'loaded' | 'not-loaded'
  max_context_length?: number;
  loaded_context_length?: number;
}

function numericOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function normalizeLmStudioUrl(url: string): string {
  return url.endsWith('/v1') ? url : `${url}/v1`;
}

/** Strip a trailing `/v1` so we can reach LM Studio's native /api/v0 REST API. */
function lmStudioRestRoot(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

/**
 * Model-listing failure, in words the user can act on.
 *
 * This returned `error.message` raw, which for an unreachable server is the
 * undici string "fetch failed" — shown verbatim in the agent editor's model
 * dropdown, which is exactly where you are when the server you just pointed at
 * isn't running. The turn path has normalized these all along; listing models
 * simply never used it. `endpoint` is passed because a bare fetch failure
 * carries no URL of its own.
 */
function fetchError(provider: string, error: unknown, endpoint?: string): FetchModelsResult {
  const raw = error instanceof Error ? error.message : 'Connection failed';
  logger.error('Error fetching models', { provider, endpoint, error: raw });
  return { success: false, error: friendlyAIErrorMessage(error, provider, endpoint) };
}

// ─── Registry ─────────────────────────────────────────────────────────────

const ADAPTERS = new Map<ProviderId, ProviderAdapter>([
  ['anthropic', anthropicAdapter],
  ['openai', openaiAdapter],
  ['google', googleAdapter],
  ['openrouter', openrouterAdapter],
  ['ollama', ollamaAdapter],
  ['lmstudio', lmstudioAdapter],
]);

export function getProviderAdapter(id: string): ProviderAdapter | undefined {
  return ADAPTERS.get(id as ProviderId);
}
