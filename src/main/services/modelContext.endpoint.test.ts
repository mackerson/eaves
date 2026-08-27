/**
 * `resolveDetectEndpoint` decides the cache scope for model-context detection,
 * and its value is written to the debug log as `endpoint`. It must never be a
 * credential.
 *
 * How it became one: resolveProviderCredential puts the single stored string in
 * `baseURL` for a local provider and in `apiKey` for a cloud one, so
 * `baseURL ?? apiKey` quietly returned an API key for every cloud provider.
 * That was inert while only Ollama and LM Studio had detectContext — the
 * orchestrator returns early for adapters that lack it, before any logging —
 * and stopped being inert the moment OpenRouter got one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settingsRepo = { get: vi.fn() };
vi.mock('../repositories', () => ({ getSettingsRepository: () => settingsRepo }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveDetectEndpoint } from './modelContext';

const SECRET = 'sk-or-v1-averyrealllookingsecret';

beforeEach(() => {
  vi.clearAllMocks();
  settingsRepo.get.mockReturnValue({
    apiKeys: {
      openrouter: SECRET,
      anthropic: 'sk-ant-alsosecret',
      lmstudio: 'http://localhost:1234/v1',
      ollama: 'http://localhost:11434',
    },
  });
});

describe('resolveDetectEndpoint', () => {
  it.each(['openrouter', 'anthropic', 'openai', 'google'])(
    'never returns the stored credential for %s',
    (provider) => {
      const endpoint = resolveDetectEndpoint(provider);
      expect(endpoint).toBeUndefined();
      expect(endpoint ?? '').not.toContain('sk-');
    },
  );

  // Scoping by endpoint is what stops a multi-host setup serving another
  // server's window — and for a local provider the stored string IS the URL,
  // so that case must keep working.
  it('returns the base URL for a local provider, which is what scoping is for', () => {
    expect(resolveDetectEndpoint('lmstudio')).toBe('http://localhost:1234/v1');
    expect(resolveDetectEndpoint('ollama')).toBe('http://localhost:11434');
  });

  it('honours an explicit override for either kind', () => {
    expect(resolveDetectEndpoint('lmstudio', 'http://otherbox:1234/v1')).toBe('http://otherbox:1234/v1');
    expect(resolveDetectEndpoint('openrouter', 'https://proxy.example/v1')).toBe('https://proxy.example/v1');
  });

  it('survives settings not being loaded yet', () => {
    settingsRepo.get.mockReturnValue(undefined);
    expect(resolveDetectEndpoint('openrouter')).toBeUndefined();
  });
});
