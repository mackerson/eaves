import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchModelsForProvider } from './fetchModels';

vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// These tests characterize the current per-provider behavior. They intentionally
// assert on concrete URLs, headers, and response shape so that the upcoming
// provider-registry refactor has a safety net — any accidental behavior change
// (wrong endpoint, missing header, filter regression) fails here.

interface MockResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
}

function mockFetchResponse(body: unknown, init: Partial<MockResponse> = {}): MockResponse {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
  };
}

describe('fetchModelsForProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('anthropic', () => {
    it('returns models from /v1/models with the required headers', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        data: [{ id: 'claude-opus-4-5' }, { id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }],
      }));

      const result = await fetchModelsForProvider('anthropic', { apiKey: 'sk-ant-test' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models?limit=100',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-test',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
    });

    it('filters out entries missing an id', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        data: [{ id: 'claude-opus-4-5' }, { id: null }, { display_name: 'no id here' }, { id: '' }],
      }));

      const result = await fetchModelsForProvider('anthropic', { apiKey: 'sk-ant-test' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['claude-opus-4-5']);
    });

    it('errors when the API key is missing', async () => {
      global.fetch = vi.fn();

      const result = await fetchModelsForProvider('anthropic', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Anthropic API key not configured');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('surfaces non-ok HTTP responses', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({}, { ok: false, status: 401, statusText: 'Unauthorized' }),
      );

      const result = await fetchModelsForProvider('anthropic', { apiKey: 'bad-key' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 401');
      expect(result.error).toContain('Unauthorized');
    });
  });

  describe('openai', () => {
    it('returns models from /v1/models with a Bearer token', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
      }));

      const result = await fetchModelsForProvider('openai', { apiKey: 'sk-test' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('errors when the API key is missing', async () => {
      global.fetch = vi.fn();

      const result = await fetchModelsForProvider('openai', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('OpenAI API key not configured');
    });

    it('surfaces HTTP errors', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({}, { ok: false, status: 500, statusText: 'Internal Server Error' }),
      );

      const result = await fetchModelsForProvider('openai', { apiKey: 'sk-test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });
  });

  describe('google', () => {
    it('returns gemini models, stripping the "models/" prefix', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        models: [
          { name: 'models/gemini-2.5-pro' },
          { name: 'models/gemini-2.5-flash' },
          { name: 'models/embedding-gecko-001' }, // should be filtered out
        ],
      }));

      const result = await fetchModelsForProvider('google', { apiKey: 'AIza-test' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models?key=AIza-test',
      );
    });

    it('errors when the API key is missing', async () => {
      global.fetch = vi.fn();

      const result = await fetchModelsForProvider('google', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Google API key not configured');
    });

    it('surfaces HTTP errors', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({}, { ok: false, status: 403, statusText: 'Forbidden' }),
      );

      const result = await fetchModelsForProvider('google', { apiKey: 'bad' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 403');
    });
  });

  describe('openrouter', () => {
    it('lists models from /api/v1/models with bearer auth', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        data: [
          { id: 'anthropic/claude-sonnet-4-5', supported_parameters: ['temperature', 'top_p', 'tools'] },
          { id: 'openai/o1', supported_parameters: ['max_tokens'] },
        ],
      }));

      const result = await fetchModelsForProvider('openrouter', { apiKey: 'sk-or-test' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['anthropic/claude-sonnet-4-5', 'openai/o1']);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Authorization': 'Bearer sk-or-test' }),
        }),
      );
    });

    it('errors when the API key is missing', async () => {
      global.fetch = vi.fn();

      const result = await fetchModelsForProvider('openrouter', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('OpenRouter API key not configured');
    });

    it('caches supported_parameters for getCapabilities lookup', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        data: [
          { id: 'anthropic/claude-sonnet-4-5', supported_parameters: ['temperature', 'top_p', 'tools', 'max_tokens', 'stop'] },
          { id: 'openai/o1', supported_parameters: ['max_tokens'] },
        ],
      }));

      await fetchModelsForProvider('openrouter', { apiKey: 'sk-or-test' });

      const { getProviderAdapter } = await import('../services/providers');
      const adapter = getProviderAdapter('openrouter')!;

      // Sampling-friendly model: full caps from supported_parameters
      const sonnet = adapter.getCapabilities('anthropic/claude-sonnet-4-5');
      expect(sonnet.temperature).toBe(true);
      expect(sonnet.topP).toBe(true);
      expect(sonnet.toolUse).toBe(true);
      expect(sonnet.stopSequences).toBe(true);

      // Reasoning model: temperature/topP/stop disabled by supported_parameters
      const o1 = adapter.getCapabilities('openai/o1');
      expect(o1.temperature).toBe(false);
      expect(o1.topP).toBe(false);
      expect(o1.stopSequences).toBe(false);
    });
  });

  describe('ollama', () => {
    it('calls /api/tags on the provided baseURL', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        models: [{ name: 'llama3.1:latest' }, { name: 'mistral:7b' }],
      }));

      const result = await fetchModelsForProvider('ollama', { baseURL: 'http://remote:11434' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['llama3.1:latest', 'mistral:7b']);
      expect(global.fetch).toHaveBeenCalledWith('http://remote:11434/api/tags');
    });

    it('falls back to apiKey when baseURL is missing (legacy endpoint storage)', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ models: [] }));

      await fetchModelsForProvider('ollama', { apiKey: 'http://configured-via-apikey:11434' });

      expect(global.fetch).toHaveBeenCalledWith('http://configured-via-apikey:11434/api/tags');
    });

    it('falls back to localhost when nothing is provided', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ models: [] }));

      await fetchModelsForProvider('ollama', {});

      expect(global.fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
    });

    it('surfaces HTTP errors with the endpoint in the message', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({}, { ok: false, status: 404, statusText: 'Not Found' }),
      );

      const result = await fetchModelsForProvider('ollama', { baseURL: 'http://nope:11434' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('http://nope:11434');
      expect(result.error).toContain('HTTP 404');
      // A server that answered was reached — telling someone to start it sends
      // them to fix something that isn't broken.
      expect(result.error).not.toMatch(/cannot reach/i);
    });

    it('names the endpoint and the fix when the server is not running', async () => {
      // The real undici shape: a bare "fetch failed" carrying the refusal in
      // `cause.code` and no URL of its own.
      global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      }));

      const result = await fetchModelsForProvider('ollama', { baseURL: 'http://localhost:11434' });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Cannot reach the model server at http://localhost:11434. Make sure Ollama is running.',
      );
    });

    it('explains an empty model list rather than showing an empty dropdown', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ models: [] }));

      const result = await fetchModelsForProvider('ollama', { baseURL: 'http://localhost:11434' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('no models installed');
      expect(result.error).toContain('ollama pull');
    });
  });

  describe('lmstudio', () => {
    it('appends /v1 when the configured URL lacks it', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ data: [] }));

      await fetchModelsForProvider('lmstudio', { baseURL: 'http://localhost:1234' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/models',
        expect.any(Object),
      );
    });

    it('preserves /v1 when the configured URL already has it', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ data: [] }));

      await fetchModelsForProvider('lmstudio', { baseURL: 'http://localhost:1234/v1' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/models',
        expect.any(Object),
      );
    });

    it('returns model ids from the OpenAI-compatible response shape', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({
        data: [{ id: 'local-llama-8b' }, { id: 'local-phi-3' }],
      }));

      const result = await fetchModelsForProvider('lmstudio', { baseURL: 'http://localhost:1234' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['local-llama-8b', 'local-phi-3']);
    });

    it('falls back to the default localhost endpoint when nothing is provided', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ data: [] }));

      await fetchModelsForProvider('lmstudio', {});

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/models',
        expect.any(Object),
      );
    });

    it('names the endpoint and the fix when the server is not running', async () => {
      global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      }));

      const result = await fetchModelsForProvider('lmstudio', { baseURL: 'http://localhost:1234' });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Cannot reach the model server at http://localhost:1234. Make sure LM Studio is running and the server is started.',
      );
    });

    it('distinguishes a running server with nothing loaded', async () => {
      // LM Studio up but no model loaded answers 200 with an empty list — an
      // unexplained empty dropdown is the same dead end as a failed fetch.
      global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ data: [] }));

      const result = await fetchModelsForProvider('lmstudio', { baseURL: 'http://localhost:1234' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('no models loaded');
      expect(result.error).toContain('http://localhost:1234/v1');
    });
  });

  describe('unknown provider + error handling', () => {
    it('returns a "not supported" error for unknown providers', async () => {
      global.fetch = vi.fn();

      const result = await fetchModelsForProvider('cohere', { apiKey: 'co-test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('converts thrown fetch errors into an error result', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      const result = await fetchModelsForProvider('anthropic', { apiKey: 'sk-ant' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('getaddrinfo ENOTFOUND');
    });
  });
});
