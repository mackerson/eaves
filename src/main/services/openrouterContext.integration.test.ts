import { describe, it, expect, vi, afterEach } from 'vitest';

// Integration test: proves OpenRouter context-window detection wires
// end-to-end through the SAME modules a real turn uses —
//   detectModelContext (warmup) → modelContextCache → resolveContextWindow /
//   computeContextBudget (the budget path in contextBudget.ts).
// Without the warmup an OpenRouter model falls to the blanket 128k default;
// with it the budget reflects the real per-model window from OpenRouter's
// /models.
// (Vitest isolates module state per file, so the context cache starts cold.)

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// resolveProviderCredential reads the settings repo for the stored OR key.
vi.mock('../repositories', () => ({
  getSettingsRepository: () => ({
    get: () => ({ apiKeys: { openrouter: 'sk-or-test' } }),
  }),
}));

import { detectModelContext, resolveDetectEndpoint } from './modelContext';
import { resolveContextWindow, computeContextBudget } from './contextBudget';
import type { Agent } from '../types';

const agent = {
  provider: 'openrouter',
  model: 'z-ai/glm-5.2',
  // No user override, no static-table entry → this is the case that falls
  // through to the blanket 128k default until detection warms the cache.
  contextWindow: undefined,
  maxOutputTokens: undefined,
} as unknown as Agent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter context window resolves end-to-end', () => {
  it('is 128k before detection, then the real served window after warmup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 'z-ai/glm-5.2',
          context_length: 202752,               // model max
          top_provider: { context_length: 131072 }, // what the served backend allocates
        }],
      }),
    })));

    // Cold cache — nothing detected yet, so the blanket OpenRouter default.
    expect(resolveContextWindow(agent)).toBe(128_000);

    // Warm the cache exactly as AgentTurnService does before a turn.
    const detected = await detectModelContext('openrouter', 'z-ai/glm-5.2');
    expect(detected).toMatchObject({ contextWindow: 131072, source: 'openrouter-api' });

    // The budget path sees the real window (served provider window preferred).
    const endpoint = resolveDetectEndpoint('openrouter');
    expect(resolveContextWindow(agent, { endpoint })).toBe(131072);

    const budget = computeContextBudget(agent, { endpoint });
    expect(budget.contextWindow).toBe(131072);
    expect(budget.sizeClass).toBe('large');
    // messageBudget derives from the true window, not the 128k guess.
    expect(budget.messageBudget).toBeGreaterThan(50_000);
  });
});
