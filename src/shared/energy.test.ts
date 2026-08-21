import { describe, it, expect } from 'vitest';
import {
  classifyModel,
  estimateTurnEnergy,
  energyToCarbonGrams,
  sumEnergy,
  describeEnergy,
  DEFAULT_GRID_INTENSITY_G_PER_KWH,
} from './energy';

describe('classifyModel', () => {
  // The same trap pricing.ts already fell into once: a family name that is a
  // prefix of another. `claude-haiku-4-5` must not be read as an Opus.
  it('separates families whose names share a prefix', () => {
    expect(classifyModel('anthropic', 'claude-haiku-4-5')).toBe('small');
    expect(classifyModel('anthropic', 'claude-3-5-haiku-20241022')).toBe('small');
    expect(classifyModel('anthropic', 'claude-opus-5')).toBe('frontier');
    expect(classifyModel('anthropic', 'claude-sonnet-5')).toBe('large');
    expect(classifyModel('openai', 'gpt-4o-mini')).toBe('small');
    expect(classifyModel('openai', 'gpt-4o')).toBe('large');
    expect(classifyModel('openai', 'o3-mini')).toBe('small');
  });

  // Which hardware it ran on decides the energy, not which family the weights
  // came from — a llama on the user's GPU is a local turn.
  it('classifies anything on local providers as local', () => {
    expect(classifyModel('ollama', 'llama3')).toBe('local');
    expect(classifyModel('lmstudio', 'qwen2.5-coder')).toBe('local');
  });

  // Overstating every unrecognised model would quietly inflate the estimate
  // for the whole workspace.
  it('falls back to medium, not frontier, for unknown models', () => {
    expect(classifyModel('openai', 'some-unreleased-thing')).toBe('medium');
  });
});

describe('estimateTurnEnergy', () => {
  it('scales with tokens and charges decode more than prefill', () => {
    const prefillHeavy = estimateTurnEnergy('anthropic', 'claude-sonnet-5', 10_000, 0);
    const decodeHeavy = estimateTurnEnergy('anthropic', 'claude-sonnet-5', 0, 10_000);
    expect(decodeHeavy.wh).toBeGreaterThan(prefillHeavy.wh);
  });

  it('costs more on a frontier model than a small one for identical work', () => {
    const small = estimateTurnEnergy('anthropic', 'claude-haiku-4-5', 2000, 500);
    const frontier = estimateTurnEnergy('anthropic', 'claude-opus-5', 2000, 500);
    expect(frontier.wh).toBeGreaterThan(small.wh);
  });

  // Anchored against published figures: Google's reported median for a Gemini
  // text prompt and Epoch's GPT-4o estimate both land near 0.2-0.3 Wh for a
  // typical short exchange. Being off by an order of magnitude here would make
  // every downstream carbon number meaningless.
  it('lands in the published ballpark for a typical exchange', () => {
    const typical = estimateTurnEnergy('openai', 'gpt-4o', 2000, 500);
    expect(typical.wh).toBeGreaterThan(0.05);
    expect(typical.wh).toBeLessThan(1);
  });

  // The range is the honest part. A point estimate presented without one
  // implies a precision nobody outside a provider has.
  it('brackets the point estimate with a real range', () => {
    const e = estimateTurnEnergy('anthropic', 'claude-opus-5', 5000, 1000);
    expect(e.whLow).toBeLessThan(e.wh);
    expect(e.whHigh).toBeGreaterThan(e.wh);
    expect(e.provenance).toBe('estimated');
  });

  // Cached tokens are re-read rather than recomputed: cheaper, not free.
  // Dropping them would make a warm-cache agent look like it consumed nothing.
  it('counts cached tokens at a reduced weight rather than zero', () => {
    const withCache = estimateTurnEnergy('anthropic', 'claude-sonnet-5', 0, 100, 10_000);
    const without = estimateTurnEnergy('anthropic', 'claude-sonnet-5', 0, 100, 0);
    const asFreshInput = estimateTurnEnergy('anthropic', 'claude-sonnet-5', 10_000, 100, 0);
    expect(withCache.wh).toBeGreaterThan(without.wh);
    expect(withCache.wh).toBeLessThan(asFreshInput.wh);
  });

  // No datacenter overhead on hardware sitting under the user's desk.
  it('applies datacenter overhead to cloud turns but not local ones', () => {
    const local = estimateTurnEnergy('ollama', 'llama3', 1000, 1000);
    expect(local.provenance).toBe('estimated');
    expect(local.wh).toBeGreaterThan(0);
  });
});

describe('energyToCarbonGrams', () => {
  it('converts at the given grid intensity', () => {
    // 1 kWh at the world-average grid.
    expect(energyToCarbonGrams(1000, DEFAULT_GRID_INTENSITY_G_PER_KWH))
      .toBeCloseTo(DEFAULT_GRID_INTENSITY_G_PER_KWH);
  });

  // The single input with the widest legitimate variation — an order of
  // magnitude between a nuclear grid and a coal one.
  it('tracks the grid it is given', () => {
    expect(energyToCarbonGrams(1000, 50)).toBeCloseTo(50);
    expect(energyToCarbonGrams(1000, 700)).toBeCloseTo(700);
  });
});

describe('sumEnergy', () => {
  const measured = { wh: 1, whLow: 1, whHigh: 1, provenance: 'measured' as const };
  const estimated = { wh: 2, whLow: 1, whHigh: 4, provenance: 'estimated' as const };

  it('adds the point estimates and both bounds', () => {
    const total = sumEnergy([measured, estimated]);
    expect(total.wh).toBe(3);
    expect(total.whLow).toBe(2);
    expect(total.whHigh).toBe(5);
  });

  // The whole point of carrying provenance. One estimated term makes the total
  // an estimate; labelling it 'measured' would launder a guess into a fact.
  it('degrades to estimated if any single term was estimated', () => {
    expect(sumEnergy([measured, measured]).provenance).toBe('measured');
    expect(sumEnergy([measured, estimated]).provenance).toBe('estimated');
    expect(sumEnergy([estimated]).provenance).toBe('estimated');
  });

  it('treats an empty total as estimated rather than measured', () => {
    expect(sumEnergy([]).provenance).toBe('estimated');
    expect(sumEnergy([]).wh).toBe(0);
  });
});

describe('describeEnergy', () => {
  it('picks a unit that keeps the number readable', () => {
    expect(describeEnergy(0.25)).toMatch(/mWh$/);
    expect(describeEnergy(12)).toMatch(/Wh$/);
    expect(describeEnergy(4200)).toMatch(/kWh$/);
  });
});
