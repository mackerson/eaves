import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost } from './pricing';

describe('getModelPricing', () => {
  // The regression: `claude-opus-4-8` starts with `claude-opus-4`, so a bare
  // prefix rule priced Opus 4.8 at Opus 4.0's $15/$75 — a 3x overstatement
  // presented as a real number. A model family extending its own name is the
  // normal case, not an edge case.
  it('does not price a newer family member at an older sibling rate', () => {
    expect(getModelPricing('anthropic', 'claude-opus-4-8')).toEqual({ promptCostPer1M: 5, completionCostPer1M: 25 });
    expect(getModelPricing('anthropic', 'claude-opus-4-7')).toEqual({ promptCostPer1M: 5, completionCostPer1M: 25 });
    expect(getModelPricing('anthropic', 'claude-opus-4-6')).toEqual({ promptCostPer1M: 5, completionCostPer1M: 25 });
    expect(getModelPricing('anthropic', 'claude-opus-4-20250514')).toEqual({ promptCostPer1M: 15, completionCostPer1M: 75 });
  });

  it('prices the current families', () => {
    expect(getModelPricing('anthropic', 'claude-opus-5')?.promptCostPer1M).toBe(5);
    expect(getModelPricing('anthropic', 'claude-sonnet-5')?.promptCostPer1M).toBe(3);
    expect(getModelPricing('anthropic', 'claude-haiku-4-5')?.promptCostPer1M).toBe(1);
    expect(getModelPricing('anthropic', 'claude-fable-5')?.promptCostPer1M).toBe(10);
  });

  it('still resolves dated and -latest aliases', () => {
    expect(getModelPricing('anthropic', 'claude-3-5-sonnet-latest')?.promptCostPer1M).toBe(3);
    expect(getModelPricing('anthropic', 'claude-3-5-sonnet-20241022')?.promptCostPer1M).toBe(3);
  });

  // Absent is visible; wrong is not. An unknown model must return null so the
  // UI can say "unpriced" rather than render an invented figure.
  it('returns null rather than guessing', () => {
    expect(getModelPricing('anthropic', 'claude-opus-9-nonexistent')).toBeNull();
    expect(getModelPricing('ollama', 'llama3')).toBeNull();
    expect(getModelPricing('nonexistent-provider', 'claude-opus-5')).toBeNull();
  });
});

describe('calculateCost', () => {
  it('computes from the table', () => {
    // 1M input + 1M output on Opus 5 = $5 + $25
    expect(calculateCost('anthropic', 'claude-opus-5', 1_000_000, 1_000_000)).toBeCloseTo(30);
  });

  it('lets an agent-level override win', () => {
    expect(calculateCost('anthropic', 'claude-opus-5', 1_000_000, 0, { promptCostPer1M: 1 })).toBeCloseTo(1);
  });

  it('returns null for an unpriced model so callers can say so', () => {
    expect(calculateCost('anthropic', 'claude-opus-9-nonexistent', 1000, 1000)).toBeNull();
  });
});

describe('calculateCost: local providers', () => {
  // Free and unknown are different answers to different questions, and a view
  // that conflates them either hides real local usage or invents a hole in the
  // totals. Local models are zero; an unrecognised cloud model is null.
  it('prices local models at zero rather than unknown', () => {
    expect(calculateCost('ollama', 'llama3', 100_000, 100_000)).toBe(0);
    expect(calculateCost('lmstudio', 'anything-at-all', 500, 500)).toBe(0);
  });

  it('still honours an override on a local model', () => {
    // Someone metering their own GPU time in dollars.
    expect(calculateCost('ollama', 'llama3', 1_000_000, 0, { promptCostPer1M: 2 })).toBeCloseTo(2);
  });
});

describe('calculateCost: prompt-cache tiers', () => {
  // Anthropic reports cache reads and creations *separately* from
  // input_tokens, so each tier is charged on top of the uncached input.
  it('charges Anthropic cache tiers additively', () => {
    // 1M uncached input @ $5 + 1M cache reads @ 0.1x + 1M cache writes @ 1.25x
    const cost = calculateCost(
      'anthropic', 'claude-opus-5', 1_000_000, 0, undefined,
      { cachedTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(5 + 0.5 + 6.25);
  });

  // The regression this whole tier exists to fix: before it, every cached
  // token was billed at the full input rate.
  it('makes a warm Anthropic turn cheaper than a cold one', () => {
    const cold = calculateCost('anthropic', 'claude-opus-5', 1_000_000, 0)!;
    const warm = calculateCost(
      'anthropic', 'claude-opus-5', 0, 0, undefined, { cachedTokens: 1_000_000 },
    )!;
    expect(warm).toBeLessThan(cold);
    expect(warm).toBeCloseTo(cold * 0.1);
  });

  // OpenAI-shaped usage already *contains* the cached tokens in its prompt
  // count. Treating that as additive would bill the same tokens twice.
  it('discounts OpenAI cached tokens out of the input total, not on top of it', () => {
    // 1M prompt tokens of which 400k were cached: 600k @ full + 400k @ 0.5x
    const cost = calculateCost(
      'openai', 'gpt-4o', 1_000_000, 0, undefined, { cachedTokens: 400_000 },
    );
    expect(cost).toBeCloseTo((600_000 / 1e6) * 2.5 + (400_000 / 1e6) * 2.5 * 0.5);
    // And never more than billing every prompt token at the full rate.
    expect(cost!).toBeLessThan(calculateCost('openai', 'gpt-4o', 1_000_000, 0)!);
  });

  // A provider reporting more cached tokens than input would otherwise produce
  // a negative line item, which is worse than a slightly high one.
  it('never produces a negative charge from inconsistent cache counts', () => {
    const cost = calculateCost(
      'openai', 'gpt-4o', 1000, 0, undefined, { cachedTokens: 999_999 },
    );
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('applies the provider shape even when rates come from an override', () => {
    // The override replaces the rate, not the accounting shape: Anthropic
    // stays additive, so cached tokens are charged on top at 0.1x.
    const cost = calculateCost(
      'anthropic', 'claude-opus-5', 1_000_000, 0,
      { promptCostPer1M: 10, completionCostPer1M: 0 },
      { cachedTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(10 + 1);
  });

  it('ignores cache tiers when there are none', () => {
    const withEmpty = calculateCost(
      'anthropic', 'claude-opus-5', 1000, 1000, undefined,
      { cachedTokens: 0, cacheWriteTokens: 0 },
    );
    expect(withEmpty).toBe(calculateCost('anthropic', 'claude-opus-5', 1000, 1000));
  });
});
