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

  it('returns unknown for a not-loaded model that will not load either', async () => {
    // JIT-load scenario: the allocation comes from LM Studio's per-model
    // setting, invisible here. Trusting max poisoned the budget (256k belief
    // vs a real 8k window → generation died mid-sentence at the wall). If the
    // warm-up cannot tell us the real window, unknown is still the answer.
    mockModelsResponse([{
      id: 'ornith-1.0-9b', state: 'not-loaded',
      max_context_length: 262144,
    }]);
    const info = await detect();
    expect(info).toBeNull();
  });

  // Admitting ignorance is right, but the fallback for "unknown" is a 4096
  // guess, which budgeted the first message of every session as though the
  // model were tiny and then recovered on the second. The load was going to
  // happen on the next request anyway, so trigger it and read the real window.
  it('JIT-loads a cold model and budgets against the window it actually got', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      call++;
      if (init?.method === 'POST') {
        expect(String(url)).toContain('/v1/chat/completions');
        return { ok: true, json: async () => ({}) };
      }
      // First probe: cold. Second probe (after the warm-up): loaded.
      return {
        ok: true,
        json: async () => ({
          data: [{
            id: 'ornith-1.0-9b',
            state: call === 1 ? 'not-loaded' : 'loaded',
            max_context_length: 262144,
            ...(call === 1 ? {} : { loaded_context_length: 32768 }),
          }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await detect();

    expect(info).toMatchObject({
      contextWindow: 32768, maxContextLength: 262144, loadedContextLength: 32768,
    });
    expect(fetchMock.mock.calls.some(([, init]) => (init as { method?: string })?.method === 'POST'))
      .toBe(true);
  });

  it('degrades to unknown rather than hanging when the warm-up fails', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
      call++;
      if (init?.method === 'POST') throw new Error('connect ECONNREFUSED');
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'ornith-1.0-9b', state: 'not-loaded', max_context_length: 262144 }] }),
      };
    }));

    expect(await detect()).toBeNull();
    expect(call).toBeGreaterThan(1); // it tried
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

  // 411 of OpenRouter's 417 models publish this, and reading only the
  // context_length beside it is why every reply stopped at 4096 however much
  // the model could produce.
  it('reads the served backend\'s real output cap', async () => {
    mockModelsResponse([{
      id: 'anthropic/claude-sonnet-4.5',
      context_length: 1000000,
      top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
    }]);
    const info = await detect('anthropic/claude-sonnet-4.5');
    expect(info).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 64000 });
  });

  it('leaves the output cap unknown for the handful that do not publish one', async () => {
    mockModelsResponse([{
      id: 'z-ai/glm-5.2', context_length: 202752, top_provider: { context_length: 131072 },
    }]);
    const info = await detect('z-ai/glm-5.2');
    expect(info?.maxOutputTokens).toBeUndefined();
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
