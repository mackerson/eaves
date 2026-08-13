import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveEmbedder, DEFAULT_EMBED_MODEL } from './embeddings';
import type { Settings } from '../types';

describe('resolveEmbedder', () => {
  it('returns null when embedding is disabled or incomplete', () => {
    expect(resolveEmbedder(undefined)).toBeNull();
    expect(resolveEmbedder({ memoryEmbedding: { enabled: false } } as Settings)).toBeNull();
    expect(
      resolveEmbedder({ memoryEmbedding: { enabled: true } } as Settings),
    ).toBeNull();
  });

  it('returns null for cloud providers without an API key', () => {
    expect(
      resolveEmbedder({
        apiKeys: {},
        memoryEmbedding: { enabled: true, provider: 'openai', model: 'text-embedding-3-small' },
      } as Settings),
    ).toBeNull();

    expect(
      resolveEmbedder({
        apiKeys: {},
        memoryEmbedding: { enabled: true, provider: 'google' },
      } as Settings),
    ).toBeNull();
  });

  it('builds OpenAI-compatible embedders for openrouter/openai with keys', () => {
    const openrouter = resolveEmbedder({
      apiKeys: { openrouter: 'or-key' },
      memoryEmbedding: { enabled: true, provider: 'openrouter' },
    } as Settings);
    expect(openrouter?.signature).toBe(`openrouter:${DEFAULT_EMBED_MODEL.openrouter}`);

    const openai = resolveEmbedder({
      apiKeys: { openai: 'sk' },
      memoryEmbedding: { enabled: true, provider: 'openai', model: 'text-embedding-3-large' },
    } as Settings);
    expect(openai?.signature).toBe('openai:text-embedding-3-large');
  });

  it('allows local providers without keys and uses stored base URLs', () => {
    const ollama = resolveEmbedder({
      apiKeys: {},
      memoryEmbedding: { enabled: true, provider: 'ollama' },
    } as Settings);
    expect(ollama?.signature).toBe(`ollama:${DEFAULT_EMBED_MODEL.ollama}`);

    const lm = resolveEmbedder({
      apiKeys: { lmstudio: 'http://127.0.0.1:1234/v1' },
      memoryEmbedding: { enabled: true, provider: 'lmstudio', model: 'nomic' },
    } as Settings);
    expect(lm?.signature).toBe('lmstudio:nomic');
  });

  it('returns null for unsupported providers', () => {
    expect(
      resolveEmbedder({
        apiKeys: { anthropic: 'x' },
        memoryEmbedding: { enabled: true, provider: 'anthropic' as any },
      } as Settings),
    ).toBeNull();
  });
});

describe('Embedder.embed', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('OpenAI-compatible embed posts to /embeddings', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3] }] }),
    } as Response);

    const embedder = resolveEmbedder({
      apiKeys: { openai: 'sk' },
      memoryEmbedding: { enabled: true, provider: 'openai', model: 'text-embedding-3-small' },
    } as Settings)!;

    const vectors = await embedder.embed(['a', 'b']);
    expect(vectors).toEqual([[0.1, 0.2], [0.3]]);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk' }),
      }),
    );
  });

  it('Google embedder uses batchEmbedContents', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [{ values: [1, 2] }] }),
    } as Response);

    const embedder = resolveEmbedder({
      apiKeys: { google: 'gkey' },
      memoryEmbedding: { enabled: true, provider: 'google', model: 'text-embedding-004' },
    } as Settings)!;

    expect(await embedder.embed(['hi'])).toEqual([[1, 2]]);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('batchEmbedContents');
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('key=gkey');
  });

  it('throws on non-OK responses', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'nope',
    } as Response);

    const embedder = resolveEmbedder({
      apiKeys: { openai: 'sk' },
      memoryEmbedding: { enabled: true, provider: 'openai' },
    } as Settings)!;

    await expect(embedder.embed(['x'])).rejects.toThrow(/embeddings HTTP 500/);
  });
});
