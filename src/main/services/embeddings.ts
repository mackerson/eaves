import type { Settings } from '../types';
import { logger } from './logger';

/**
 * Pluggable embedders. An Embedder is
 * an *identity* — its `signature` binds the vector index to one model+space, so
 * switching embedders forces a re-index. API adapters live here now; a bundled
 * local (transformers.js) embedder implements the same interface later.
 *
 * Dimensions are read from the embed output by the caller (robust for any
 * model), so the interface stays to just: who am I, and embed these texts.
 */
export interface Embedder {
  /** `${provider}:${model}` — the index's bound identity. */
  signature: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** OpenAI-shaped `/embeddings` — covers OpenRouter, OpenAI, LM Studio, Ollama. */
class OpenAICompatibleEmbedder implements Embedder {
  readonly signature: string;
  constructor(
    provider: string,
    private model: string,
    private baseURL: string,
    private apiKey: string | undefined,
  ) {
    this.signature = `${provider}:${model}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json() as { data?: Array<{ embedding: number[] }> };
    return (data.data ?? []).map(d => d.embedding);
  }
}

/** Google Gemini embeddings — its own request shape. */
class GoogleEmbedder implements Embedder {
  readonly signature: string;
  constructor(private model: string, private apiKey: string) {
    this.signature = `google:${model}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map(t => ({ model: `models/${this.model}`, content: { parts: [{ text: t }] } })),
        }),
      },
    );
    if (!res.ok) throw new Error(`google embeddings HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json() as { embeddings?: Array<{ values: number[] }> };
    return (data.embeddings ?? []).map(e => e.values);
  }
}

/** Provider → OpenAI-compatible base URL. Local providers read their endpoint
 *  from the stored credential (apiKeys[provider]) like the chat adapters do. */
function openAiCompatBaseURL(provider: string, stored: string | undefined): string | null {
  switch (provider) {
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'openai': return 'https://api.openai.com/v1';
    case 'ollama': return `${(stored || 'http://localhost:11434').replace(/\/+$/, '')}/v1`;
    case 'lmstudio': return (stored || 'http://localhost:1234/v1').replace(/\/+$/, '');
    default: return null;
  }
}

/** Suggested default embedding model per provider (user-overridable in settings). */
export const DEFAULT_EMBED_MODEL: Record<string, string> = {
  openrouter: 'openai/text-embedding-3-small',
  openai: 'text-embedding-3-small',
  google: 'text-embedding-004',
  ollama: 'nomic-embed-text',
  lmstudio: 'text-embedding-nomic-embed-text-v1.5',
};

/**
 * Resolve the active embedder from settings, or null when embedding is off /
 * unconfigured / missing its key. Cloud providers need `apiKeys[provider]`;
 * local providers (ollama/lmstudio) work without a key.
 */
export function resolveEmbedder(settings: Settings | undefined): Embedder | null {
  const cfg = settings?.memoryEmbedding;
  if (!cfg?.enabled || !cfg.provider) return null;
  const model = cfg.model?.trim() || DEFAULT_EMBED_MODEL[cfg.provider];
  if (!model) return null;

  const stored = settings?.apiKeys?.[cfg.provider as keyof typeof settings.apiKeys];

  if (cfg.provider === 'google') {
    if (!stored) return null;
    return new GoogleEmbedder(model, stored);
  }

  const baseURL = openAiCompatBaseURL(cfg.provider, stored);
  if (!baseURL) { logger.warn('[embeddings] unsupported embedding provider', { provider: cfg.provider }); return null; }
  const isLocal = cfg.provider === 'ollama' || cfg.provider === 'lmstudio';
  if (!isLocal && !stored) return null; // cloud providers need a key
  return new OpenAICompatibleEmbedder(cfg.provider, model, baseURL, isLocal ? undefined : stored);
}
