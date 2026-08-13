/**
 * Provider registry — single source of truth for AI provider metadata.
 *
 * Adding a new provider (e.g. OpenRouter, Cohere) means:
 * 1. Add its id to ProviderId.
 * 2. Append an entry to PROVIDERS here.
 * 3. Add a matching adapter in src/main/services/providers.ts
 *    (createLanguageModel + fetchModels).
 *
 * Renderer components and main-process services iterate this list instead of
 * enumerating providers individually, so the data model stays flat.
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio';

/**
 * What knobs a model accepts. Drives agent-editor UI gating: a slider
 * pointed at a model that rejects temperature is just confusing.
 *
 * The provider adapter resolves these per-model in three layers:
 *   1. Adapter override (e.g. OpenRouter's per-model supported_parameters,
 *      or a regex matching reasoning-first Claude / OpenAI o-series models).
 *   2. Provider default from defaultCapabilities below.
 *   3. Optimistic — assume supported, let the SDK silently drop unsupported
 *      params.
 */
export interface ModelCapabilities {
  /** Sampling temperature accepted on requests. */
  temperature: boolean;
  /** Nucleus sampling (top_p). */
  topP: boolean;
  /** Custom stop sequences. */
  stopSequences: boolean;
  /** Raw-prompt mode (instruct templates). True for local providers. */
  rawPrompt: boolean;
  /** Configurable max output tokens. */
  maxOutputTokens: boolean;
  /** Function/tool calling. */
  toolUse: boolean;
}

/**
 * Live-detected context window metadata for a model, sourced from a local
 * provider's native API (LM Studio's /api/v0/models, Ollama's /api/show).
 *
 * - `maxContextLength`: the model's true ceiling (e.g. 131072 for Gemma).
 * - `loadedContextLength`: how much the running server actually allocated.
 *   LM Studio's loader defaults this low (often 4096) unless raised; Ollama
 *   doesn't report it, so it's omitted there.
 * - `contextWindow`: the value we feed the budget — the *operational* ceiling,
 *   so `loadedContextLength` first (the server rejects requests past it),
 *   falling back to `maxContextLength` when loaded isn't reported (Ollama).
 */
export interface ModelContextInfo {
  contextWindow: number;
  maxContextLength?: number;
  loadedContextLength?: number;
  source: 'lmstudio-api' | 'ollama-api' | 'openrouter-api';
}

export const FULL_CAPABILITIES: ModelCapabilities = {
  temperature: true,
  topP: true,
  stopSequences: true,
  rawPrompt: false,
  maxOutputTokens: true,
  toolUse: true,
};

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** Emoji rendered on the provider card. */
  icon: string;
  description: string;
  /** Label for the single credential field — "API Key" or "Endpoint URL". */
  keyLabel: string;
  keyPlaceholder: string;
  keyHelp: string;
  /**
   * When true the credential field must be filled to proceed. Local providers
   * (Ollama, LM Studio) can run against their default endpoint with nothing
   * entered.
   */
  needsKey: boolean;
  /**
   * True for providers whose `apiKeys[id]` field actually stores an endpoint
   * URL rather than a credential. The fetch-models IPC routes the value to
   * `baseURL` instead of `apiKey` when this is set.
   */
  isLocalEndpoint?: boolean;
  /** Default endpoint for local providers that accept an override. */
  defaultEndpoint?: string;
  /** External URL shown in the OOBE help panel and provider tooltips. */
  docsUrl?: string;
  /** Baseline capabilities; adapters can override per model. */
  defaultCapabilities: ModelCapabilities;
}

export const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    icon: '\u2728',
    description: 'Claude models — highly capable, nuanced AI',
    keyLabel: 'API Key',
    keyPlaceholder: 'sk-ant-...',
    keyHelp: 'Get an API key at console.anthropic.com. Pay-as-you-go; most conversations cost fractions of a cent.',
    needsKey: true,
    docsUrl: 'https://console.anthropic.com/',
    // Reasoning-first models reject temperature/topP — adapter overrides those.
    defaultCapabilities: { ...FULL_CAPABILITIES, rawPrompt: false },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    icon: '\u{1f9e0}',
    description: 'GPT models — versatile general-purpose AI',
    keyLabel: 'API Key',
    keyPlaceholder: 'sk-...',
    keyHelp: 'Get an API key at platform.openai.com. ChatGPT subscription doesn\u2019t include API access.',
    needsKey: true,
    docsUrl: 'https://platform.openai.com/api-keys',
    // o1/o3/o4-class reasoning models reject sampling params — adapter overrides.
    defaultCapabilities: { ...FULL_CAPABILITIES, rawPrompt: false },
  },
  {
    id: 'google',
    label: 'Google',
    icon: '\u{1f48e}',
    description: 'Gemini models — large context, multimodal',
    keyLabel: 'API Key',
    keyPlaceholder: 'AIza...',
    keyHelp: 'Get an API key at aistudio.google.com. Generous free tier.',
    needsKey: true,
    docsUrl: 'https://aistudio.google.com/app/apikey',
    defaultCapabilities: { ...FULL_CAPABILITIES, rawPrompt: false },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    icon: '\u{1f501}',
    description: 'One key for 200+ models — Claude, GPT, Llama, Gemini, and more',
    keyLabel: 'API Key',
    keyPlaceholder: 'sk-or-...',
    keyHelp: 'Get an API key at openrouter.ai/keys. Pay per model; no subscription. Great for trying many models without juggling keys.',
    needsKey: true,
    docsUrl: 'https://openrouter.ai/keys',
    // OpenRouter routes to many backends. The adapter consults the model
    // listing's `supported_parameters` for per-model truth; this default
    // applies until that fetch lands and is intentionally optimistic.
    defaultCapabilities: { ...FULL_CAPABILITIES, rawPrompt: false },
  },
  {
    id: 'ollama',
    label: 'Ollama',
    icon: '\u{1f999}',
    description: 'Run models locally — private, no API key needed',
    keyLabel: 'Endpoint URL',
    keyPlaceholder: 'http://localhost:11434',
    keyHelp: 'Install from ollama.com and run a model locally. Leave empty to use the default endpoint.',
    needsKey: false,
    isLocalEndpoint: true,
    defaultEndpoint: 'http://localhost:11434',
    docsUrl: 'https://ollama.com/',
    // Local providers accept raw-prompt mode and the full sampling toolkit;
    // tool-use availability depends on the underlying model.
    defaultCapabilities: { ...FULL_CAPABILITIES, rawPrompt: true },
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    icon: '\u{1f4bb}',
    description: 'Local inference server — OpenAI-compatible',
    keyLabel: 'Endpoint URL',
    keyPlaceholder: 'http://localhost:1234/v1',
    keyHelp: 'Start a local server from LM Studio. Leave empty to use the default endpoint.',
    needsKey: false,
    isLocalEndpoint: true,
    defaultEndpoint: 'http://localhost:1234/v1',
    docsUrl: 'https://lmstudio.ai/',
    defaultCapabilities: { ...FULL_CAPABILITIES, rawPrompt: true },
  },
];

export const PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.map(p => p.id);

export function getProvider(id: string): ProviderMeta | undefined {
  return PROVIDERS.find(p => p.id === id);
}

export function isProviderId(id: string): id is ProviderId {
  return PROVIDER_IDS.includes(id as ProviderId);
}
