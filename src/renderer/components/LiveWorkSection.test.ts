/**
 * Spend aggregation for the live section.
 *
 * The one property worth pinning: a total built from any turn whose usage never
 * settled is a floor, not a figure. Rounding that away would make the panel
 * confidently wrong about money, which is the expensive direction to be wrong in.
 */

import { describe, it, expect } from 'vitest';
import { aggregateSpend } from './LiveWorkSection';
import type { Activity } from '@/types';

function spendRow(data: Record<string, unknown>): Activity {
  return {
    id: Math.random().toString(36),
    type: 'agent:spend',
    category: 'system',
    source: 'core',
    audience: 'system',
    timestamp: Date.now(),
    data,
  } as Activity;
}

describe('aggregateSpend', () => {
  it('sums cost, tokens and turns per agent', () => {
    const rows = aggregateSpend([
      spendRow({ agentId: 'a', agentName: 'Ninja', cost: 0.02, totalTokens: 1000, usageIsTotal: true }),
      spendRow({ agentId: 'a', agentName: 'Ninja', cost: 0.03, totalTokens: 1500, usageIsTotal: true }),
      spendRow({ agentId: 'b', agentName: 'Scout', cost: 0.01, totalTokens: 200, usageIsTotal: true }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agentId: 'a', agentName: 'Ninja', tokens: 2500, turns: 2, complete: true });
    expect(rows[0].cost).toBeCloseTo(0.05);
    expect(rows[1]).toMatchObject({ agentId: 'b', turns: 1 });
  });

  it('ranks the most expensive agent first', () => {
    const rows = aggregateSpend([
      spendRow({ agentId: 'cheap', agentName: 'C', cost: 0.01, totalTokens: 10, usageIsTotal: true }),
      spendRow({ agentId: 'pricey', agentName: 'P', cost: 5, totalTokens: 10, usageIsTotal: true }),
    ]);

    expect(rows.map((r) => r.agentId)).toEqual(['pricey', 'cheap']);
  });

  it('marks a total incomplete when any turn in it was only a floor', () => {
    const rows = aggregateSpend([
      spendRow({ agentId: 'a', agentName: 'Ninja', cost: 0.02, totalTokens: 1000, usageIsTotal: true }),
      // Aborted mid-turn: usage never settled.
      spendRow({ agentId: 'a', agentName: 'Ninja', cost: 0.01, totalTokens: 400, usageIsTotal: false }),
    ]);

    expect(rows[0].complete).toBe(false);
    expect(rows[0].turns).toBe(2);
  });

  it('counts a turn that reported no cost at all', () => {
    // A missing cost is not zero cost — the turn still happened, and dropping
    // it would understate how much work an agent did.
    const rows = aggregateSpend([spendRow({ agentId: 'a', agentName: 'Ninja', usageIsTotal: false })]);

    expect(rows[0]).toMatchObject({ turns: 1, cost: 0, tokens: 0, complete: false });
  });

  it('keeps unattributed spend visible rather than dropping it', () => {
    const rows = aggregateSpend([spendRow({ cost: 0.5, totalTokens: 100, usageIsTotal: true })]);

    expect(rows[0]).toMatchObject({ agentId: 'unknown', agentName: 'Unattributed', cost: 0.5 });
  });
});
