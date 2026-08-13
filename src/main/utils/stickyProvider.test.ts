import { describe, it, expect } from 'vitest';
import { resolveStickyProvider } from './stickyProvider';

describe('resolveStickyProvider', () => {
  const msgs = (
    rows: Array<{ senderType?: string; metrics?: { servedProvider?: string } | null }>,
  ) => rows;

  it.each([
    ['anthropic', undefined],
    ['openai', undefined],
    ['ollama', undefined],
  ] as const)('returns undefined for non-OpenRouter provider %s', (provider, expected) => {
    const messages = msgs([
      { senderType: 'agent', metrics: { servedProvider: 'GMICloud' } },
    ]);
    expect(resolveStickyProvider(messages, provider)).toBe(expected);
  });

  it('returns undefined when openrouter but no prior agent servedProvider', () => {
    expect(resolveStickyProvider([], 'openrouter')).toBeUndefined();
    expect(
      resolveStickyProvider(msgs([{ senderType: 'human' }, { senderType: 'agent', metrics: null }]), 'openrouter'),
    ).toBeUndefined();
    expect(
      resolveStickyProvider(
        msgs([{ senderType: 'agent', metrics: {} }]),
        'openrouter',
      ),
    ).toBeUndefined();
  });

  it('returns the most recent agent servedProvider (scan from end)', () => {
    const messages = msgs([
      { senderType: 'agent', metrics: { servedProvider: 'OldBackend' } },
      { senderType: 'human' },
      { senderType: 'agent', metrics: { servedProvider: 'GMICloud' } },
      { senderType: 'human' },
    ]);
    expect(resolveStickyProvider(messages, 'openrouter')).toBe('GMICloud');
  });

  it('skips human messages and agents without metrics when scanning backward', () => {
    const messages = msgs([
      { senderType: 'agent', metrics: { servedProvider: 'DeepInfra' } },
      { senderType: 'human', metrics: { servedProvider: 'should-ignore' } },
      { senderType: 'agent' },
      { senderType: 'agent', metrics: null },
    ]);
    expect(resolveStickyProvider(messages, 'openrouter')).toBe('DeepInfra');
  });
});
