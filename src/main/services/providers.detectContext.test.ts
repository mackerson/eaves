import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getProviderAdapter } from './providers';

function mockModelsResponse(entries: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: entries }),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lmstudio detectContext', () => {
  const detect = () =>
    getProviderAdapter('lmstudio')!.detectContext!('ornith-1.0-9b', {
      apiKey: 'http://localhost:1234/v1',
      baseURL: 'http://localhost:1234/v1',
    });

  it('uses loaded_context_length when the model is loaded', async () => {
    mockModelsResponse([{
      id: 'ornith-1.0-9b', state: 'loaded',
      max_context_length: 262144, loaded_context_length: 8192,
    }]);
    const info = await detect();
    expect(info).toMatchObject({ contextWindow: 8192, maxContextLength: 262144, loadedContextLength: 8192 });
  });

  it('returns unknown for a not-loaded model instead of trusting max_context_length', async () => {
    // JIT-load scenario: the allocation comes from LM Studio's per-model
    // setting, invisible here. Trusting max poisoned the budget (256k belief
    // vs a real 8k window → generation died mid-sentence at the wall).
    mockModelsResponse([{
      id: 'ornith-1.0-9b', state: 'not-loaded',
      max_context_length: 262144,
    }]);
    const info = await detect();
    expect(info).toBeNull();
  });

  it('falls back to max when state is unreported (older LM Studio)', async () => {
    mockModelsResponse([{
      id: 'ornith-1.0-9b',
      max_context_length: 32768,
    }]);
    const info = await detect();
    expect(info).toMatchObject({ contextWindow: 32768 });
  });

  it('uses loaded even when state is stale-unloaded', async () => {
    mockModelsResponse([{
      id: 'ornith-1.0-9b', state: 'not-loaded',
      max_context_length: 262144, loaded_context_length: 16384,
    }]);
    const info = await detect();
    expect(info).toMatchObject({ contextWindow: 16384 });
  });
});

describe('openrouter detectContext', () => {
  const detect = (model: string) =>
    getProviderAdapter('openrouter')!.detectContext!(model, { apiKey: 'sk-or-test' });

  it('prefers the served provider window over the model max', async () => {
    // top_provider is what a sticky-pinned request is actually validated
    // against; it can be smaller than the model's advertised max.
    mockModelsResponse([{
      id: 'z-ai/glm-5.2',
      context_length: 202752,
      top_provider: { context_length: 131072 },
    }]);
    const info = await detect('z-ai/glm-5.2');
    expect(info).toMatchObject({
      contextWindow: 131072, maxContextLength: 202752, source: 'openrouter-api',
    });
  });

  it('falls back to top-level context_length when top_provider is absent', async () => {
    mockModelsResponse([{ id: 'x-ai/grok-4.5', context_length: 256000 }]);
    const info = await detect('x-ai/grok-4.5');
    expect(info).toMatchObject({ contextWindow: 256000, maxContextLength: 256000 });
  });

  it('returns null when the model id is not in the catalog', async () => {
    mockModelsResponse([{ id: 'z-ai/glm-5.2', context_length: 202752 }]);
    const info = await detect('anthropic/claude-opus-4');
    expect(info).toBeNull();
  });

  it('returns null (no fetch) without an API key', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const info = await getProviderAdapter('openrouter')!.detectContext!('z-ai/glm-5.2', { apiKey: '' });
    expect(info).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
