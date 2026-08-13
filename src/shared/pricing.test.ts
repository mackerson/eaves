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
