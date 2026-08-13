import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../repositories', () => ({ getMemoryBlockRepository: vi.fn() }));
vi.mock('./ServiceRegistry', () => ({ getServiceRegistry: vi.fn() }));

import { parseDreamOutput, consolidateDream } from './shadowConsolidate';
import { getMemoryBlockRepository } from '../repositories';
import { getServiceRegistry } from './ServiceRegistry';

describe('parseDreamOutput', () => {
  it('parses focus + facts and clamps/filters', () => {
    const out = parseDreamOutput(`prose before {
      "focus": "  Shipping the memory layer  ",
      "facts": [
        {"key": "daniel-webster", "value": "Cascadia tagger", "description": "person of interest", "tags": ["people", 3]},
        {"key": "bad"},
        {"value": "no key"}
      ]
    } trailing`);
    expect(out).not.toBeNull();
    expect(out!.focus).toBe('Shipping the memory layer');
    expect(out!.facts).toHaveLength(1);
    expect(out!.facts[0]).toMatchObject({ key: 'daniel-webster', value: 'Cascadia tagger', description: 'person of interest', tags: ['people'] });
  });

  it('returns null for non-JSON or empty dreams', () => {
    expect(parseDreamOutput('no json here')).toBeNull();
    expect(parseDreamOutput('{"focus": "", "facts": []}')).toBeNull();
    expect(parseDreamOutput('{bad json')).toBeNull();
  });

  it('accepts focus-only or facts-only', () => {
    expect(parseDreamOutput('{"focus": "just focus"}')).toMatchObject({ focus: 'just focus', facts: [] });
    expect(parseDreamOutput('{"facts": [{"key":"k","value":"v"}]}')).toMatchObject({ focus: '' });
  });
});

describe('consolidateDream', () => {
  const setValue = vi.fn();
  const call = vi.fn(async () => ({ success: true }));
  beforeEach(() => {
    setValue.mockClear(); call.mockClear();
    vi.mocked(getMemoryBlockRepository).mockReturnValue({ setValue } as never);
    vi.mocked(getServiceRegistry).mockReturnValue({ hasProviders: () => true, call } as never);
  });

  it('updates current_focus and stores facts with shadow-dream provenance', async () => {
    const res = await consolidateDream('agent-1', {
      focus: 'active on whales',
      facts: [{ key: 'daniel-webster', value: 'tagger', description: 'poi', tags: ['people'] }],
    });
    expect(res).toEqual({ focusUpdated: true, factsStored: 1 });
    expect(setValue).toHaveBeenCalledWith('agent-1', 'current_focus', 'active on whales');
    expect(call).toHaveBeenCalledWith('memory-backend', 'store', expect.objectContaining({
      key: 'daniel-webster',
      metadata: expect.objectContaining({ source: 'shadow-dream', agentId: 'agent-1', tags: ['people'] }),
    }));
  });

  it('skips fact writes when no backend is present', async () => {
    vi.mocked(getServiceRegistry).mockReturnValue({ hasProviders: () => false, call } as never);
    const res = await consolidateDream('a1', { focus: '', facts: [{ key: 'k', value: 'v' }] });
    expect(res.factsStored).toBe(0);
    expect(call).not.toHaveBeenCalled();
  });
});
