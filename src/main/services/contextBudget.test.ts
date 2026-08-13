import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { getCachedModelContext } = vi.hoisted(() => ({ getCachedModelContext: vi.fn() }));
vi.mock('./modelContextCache', () => ({ getCachedModelContext }));

import {
  estimateTokens,
  estimateMessageTokens,
  windowMessages,
  getModelSizeClass,
  resolveContextWindow,
  computeContextBudget,
} from './contextBudget';
import type { Agent } from '../types';

const makeAgent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'A', provider: 'anthropic', model: 'unknown-model', ...over }) as Agent;

describe('estimateMessageTokens', () => {
  it('handles plain string content', () => {
    expect(estimateMessageTokens({ content: 'hello world' })).toBe(estimateTokens('hello world'));
  });

  it('walks multi-part content and sums text parts', () => {
    const tokens = estimateMessageTokens({
      content: [
        { type: 'text', text: 'first chunk' },
        { type: 'text', text: 'second chunk' },
      ],
    });
    expect(tokens).toBe(estimateTokens('first chunk') + estimateTokens('second chunk'));
  });

  it('treats images as a flat cost — not the base64 length', () => {
    const bigBase64 = 'A'.repeat(200_000);
    const withImage = estimateMessageTokens({
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image', image: bigBase64, mimeType: 'image/png' },
      ],
    });
    // The base64 alone would be ~57k tokens via raw JSON.stringify;
    // we should be closer to a few hundred.
    expect(withImage).toBeLessThan(2_000);
    // But still strictly more than the text alone.
    expect(withImage).toBeGreaterThan(estimateTokens('see this'));
  });

  it('treats image-data, file-data, file-url etc as flat-cost media', () => {
    const tokensA = estimateMessageTokens({
      content: [{ type: 'image-data', data: 'A'.repeat(50_000), mediaType: 'image/jpeg' }],
    });
    const tokensB = estimateMessageTokens({
      content: [{ type: 'file-data', data: 'A'.repeat(50_000), mediaType: 'application/pdf' }],
    });
    expect(tokensA).toBeLessThan(2_000);
    expect(tokensB).toBeLessThan(2_000);
  });

  it('counts tool-result content (including media) per part', () => {
    const tokens = estimateMessageTokens({
      content: [
        {
          type: 'tool-result',
          toolName: 'mcp_screenshot',
          output: [
            { type: 'text', text: 'screenshot of homepage' },
            { type: 'image-data', data: 'A'.repeat(80_000), mediaType: 'image/png' },
          ],
        },
      ],
    });
    // Should account for the text + flat image, not 80k chars of base64.
    expect(tokens).toBeLessThan(3_000);
    expect(tokens).toBeGreaterThan(estimateTokens('screenshot of homepage'));
  });

  it('counts sidecar toolCalls array entries', () => {
    const tokens = estimateMessageTokens({
      content: '',
      toolCalls: [
        { toolName: 'bash', input: { command: 'ls -la' } },
      ],
    });
    expect(tokens).toBeGreaterThan(0);
  });

  // The SDK wraps tool-result output as { type, value } — the shape stored in
  // response_messages_json and replayed to the model. Unless the estimator
  // unwraps `value`, these score ~0 tokens, so giant tool results never
  // trigger compaction/windowing and small local context windows overflow.
  it('counts SDK v6 json-wrapped tool-result output by its value', () => {
    const bigResult = { tools: Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(250) })) };
    const tokens = estimateMessageTokens({
      content: [
        {
          type: 'tool-result',
          toolName: 'list_tools',
          output: { type: 'json', value: bigResult },
        },
      ],
    });
    // ~10KB of JSON must register as thousands of tokens, not ~0.
    expect(tokens).toBeGreaterThan(2_000);
  });

  it('counts SDK v6 text-wrapped tool-result output by its value', () => {
    const tokens = estimateMessageTokens({
      content: [
        { type: 'tool-result', toolName: 'bash', output: { type: 'text', value: 'y'.repeat(3_500) } },
      ],
    });
    expect(tokens).toBeGreaterThan(900);
  });

  it('counts SDK v6 content-wrapped tool-result output with media as flat cost', () => {
    const tokens = estimateMessageTokens({
      content: [
        {
          type: 'tool-result',
          toolName: 'screenshot',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'homepage screenshot' },
              { type: 'media', data: 'A'.repeat(80_000), mediaType: 'image/png' },
            ],
          },
        },
      ],
    });
    expect(tokens).toBeLessThan(3_000);
    expect(tokens).toBeGreaterThan(estimateTokens('homepage screenshot'));
  });
});

describe('windowMessages', () => {
  it('returns an empty list untouched', () => {
    const empty: { content: string }[] = [];
    expect(windowMessages(empty, 100)).toBe(empty);
  });

  it('returns all messages when total fits the budget', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    expect(windowMessages(msgs, 100)).toEqual(msgs);
  });

  it('drops oldest messages first to fit budget', () => {
    const msgs = [
      { role: 'user', content: 'A'.repeat(700) },     // ~200 tok
      { role: 'assistant', content: 'B'.repeat(700) }, // ~200 tok
      { role: 'user', content: 'C'.repeat(700) },     // ~200 tok
    ];
    const kept = windowMessages(msgs, 250);
    expect(kept.length).toBe(1);
    expect(kept[0].content).toBe(msgs[2].content);
  });

  it('keeps the most-recent message even if it exceeds the budget', () => {
    const msgs = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'X'.repeat(10_000) },
    ];
    const kept = windowMessages(msgs, 50);
    expect(kept).toEqual([msgs[1]]);
  });

  it('does not throw away history just because of an inline image', () => {
    // Counted by raw JSON.stringify the base64 reads as ~30k tokens, which
    // would evict the whole conversation to make room for one image.
    const msgs = [
      { role: 'user', content: 'first message in history' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'reply two' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', image: 'A'.repeat(100_000), mimeType: 'image/png' },
        ],
      },
    ];
    const kept = windowMessages(msgs, 4_000);
    // All four messages should survive — the image is ~1500 tokens, not 30k.
    expect(kept.length).toBe(4);
  });
});

describe('estimatePartTokens — part-type branches', () => {
  it('walks object (non-array) content through the part walker', () => {
    expect(estimateMessageTokens({ content: { type: 'text', text: 'hello there' } })).toBe(
      estimateTokens('hello there'),
    );
  });

  it('scores a text part with a non-string text field as empty', () => {
    expect(estimateMessageTokens({ content: [{ type: 'text', text: 42 }] })).toBe(0);
  });

  it('counts reasoning parts like text', () => {
    expect(estimateMessageTokens({ content: [{ type: 'reasoning', text: 'thinking hard' }] })).toBe(
      estimateTokens('thinking hard'),
    );
    expect(estimateMessageTokens({ content: [{ type: 'reasoning', text: null }] })).toBe(0);
  });

  it.each(['tool-approval-request', 'tool-approval-response'])(
    'counts %s by approvalId + reason',
    (type) => {
      expect(estimateMessageTokens({ content: [{ type, approvalId: 'ap-1', reason: 'why' }] })).toBe(
        estimateTokens('ap-1') + estimateTokens('why'),
      );
      // Both fields optional — missing ones contribute nothing.
      expect(estimateMessageTokens({ content: [{ type }] })).toBe(0);
    },
  );

  it('counts tool-call name alongside its input', () => {
    const withName = estimateMessageTokens({
      content: [{ type: 'tool-call', toolName: 'read_file', input: { path: 'a.ts' } }],
    });
    const withoutName = estimateMessageTokens({
      content: [{ type: 'tool-call', input: { path: 'a.ts' } }],
    });
    expect(withName).toBe(withoutName + estimateTokens('read_file'));
  });

  it('falls back through text/content/data/input/output for unknown part types', () => {
    expect(estimateMessageTokens({ content: [{ type: 'mystery', data: 'payload here' }] })).toBe(
      estimateTokens('payload here'),
    );
    // Nothing recognizable — empty, not a stringified blob of the whole part.
    expect(estimateMessageTokens({ content: [{ type: 'mystery' }] })).toBe(0);
  });

  it('ignores null and primitive parts', () => {
    expect(estimateMessageTokens({ content: [null, undefined, 7, 'raw'] })).toBe(0);
  });

  it('scores an unserializable fallback value as empty rather than crashing', () => {
    // JSON.stringify of a function yields undefined — the `?? ''` guard.
    expect(estimateMessageTokens({ content: [{ type: 'mystery', data: () => {} }] })).toBe(0);
  });

  it('survives circular structures via the stringify fallback', () => {
    const circular: Record<string, unknown> = { type: 'mystery' };
    circular.data = circular;
    expect(() => estimateMessageTokens({ content: [circular] })).not.toThrow();
  });

  it('counts untagged tool-result output through the generic walker', () => {
    expect(
      estimateMessageTokens({ content: [{ type: 'tool-result', output: 'plain string out' }] }),
    ).toBe(estimateTokens('plain string out'));
  });

  it('counts error-text wrapped tool-result output by its value', () => {
    expect(
      estimateMessageTokens({
        content: [{ type: 'tool-result', output: { type: 'error-text', value: 'boom failed' } }],
      }),
    ).toBe(estimateTokens('boom failed'));
  });

  it('counts non-text items inside content-wrapped output via stringify', () => {
    const out = estimateMessageTokens({
      content: [
        { type: 'tool-result', output: { type: 'content', value: [{ type: 'other', k: 'v' }] } },
      ],
    });
    expect(out).toBe(estimateTokens(JSON.stringify({ type: 'other', k: 'v' })));
  });
});

describe('getModelSizeClass', () => {
  it.each([
    [1024, 'tiny'],
    [4096, 'tiny'],
    [4097, 'small'],
    [16384, 'small'],
    [16385, 'medium'],
    [32768, 'medium'],
    [32769, 'large'],
    [200_000, 'large'],
  ])('classifies %i as %s', (window, expected) => {
    expect(getModelSizeClass(window)).toBe(expected);
  });
});

describe('resolveContextWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCachedModelContext.mockReturnValue(undefined);
  });

  it('prefers the agent override when set', () => {
    expect(resolveContextWindow(makeAgent({ contextWindow: 65_536 }))).toBe(65_536);
  });

  it('clamps the override to the detected loaded window', () => {
    getCachedModelContext.mockReturnValue({ loadedContextLength: 8_192 });
    expect(resolveContextWindow(makeAgent({ contextWindow: 128_000 }))).toBe(8_192);
  });

  it('keeps an override that fits inside the detected loaded window', () => {
    getCachedModelContext.mockReturnValue({ loadedContextLength: 128_000 });
    expect(resolveContextWindow(makeAgent({ contextWindow: 32_768 }))).toBe(32_768);
  });

  it('ignores a zero or negative override', () => {
    expect(resolveContextWindow(makeAgent({ contextWindow: 0, provider: 'openai' }))).toBe(128_000);
  });

  it('uses the known-model table before falling back to a provider default', () => {
    // gpt-4o is in the shared pricing table at 128k; the openai default is the
    // same number, so use a provider whose default differs to prove the lookup.
    expect(resolveContextWindow(makeAgent({ provider: 'ollama', model: 'gpt-4o' }))).toBe(128_000);
  });

  it('uses the live-detected window when there is no override', () => {
    getCachedModelContext.mockReturnValue({ contextWindow: 40_000 });
    expect(resolveContextWindow(makeAgent({ provider: 'ollama' }))).toBe(40_000);
  });

  it.each([
    ['anthropic', 200_000],
    ['openai', 128_000],
    ['google', 1_048_576],
    ['openrouter', 128_000],
    ['ollama', 4_096],
    ['lmstudio', 4_096],
    ['some-unknown-provider', 4_096],
  ])('falls back to the %s provider default', (provider, expected) => {
    expect(resolveContextWindow(makeAgent({ provider: provider as Agent['provider'] }))).toBe(
      expected,
    );
  });
});

describe('computeContextBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCachedModelContext.mockReturnValue(undefined);
  });

  it('caps the output reserve at half the window for tiny models', () => {
    const b = computeContextBudget(makeAgent({ contextWindow: 4_096, maxOutputTokens: 4_096 }));
    expect(b.sizeClass).toBe('tiny');
    expect(b.outputReserve).toBe(2_048);
  });

  it('uses maxOutputTokens directly above the tiny class', () => {
    const b = computeContextBudget(makeAgent({ contextWindow: 128_000, maxOutputTokens: 8_192 }));
    expect(b.outputReserve).toBe(8_192);
  });

  it('defaults maxOutputTokens to 4096 when unset', () => {
    expect(computeContextBudget(makeAgent({ contextWindow: 128_000 })).outputReserve).toBe(4_096);
  });

  it('caps budgeted input for ultra-large windows', () => {
    const b = computeContextBudget(makeAgent({ contextWindow: 2_500_000, maxOutputTokens: 4_096 }));
    expect(b.inputBudget).toBe(256_000);
  });

  it.each([
    [4_096, 'tiny', 0.3],
    [16_384, 'small', 0.35],
    [32_768, 'medium', 0.4],
    [200_000, 'large', 0.5],
  ])('splits system/message budget by size class at %i', (window, sizeClass, ratio) => {
    const b = computeContextBudget(makeAgent({ contextWindow: window, maxOutputTokens: 1_000 }));
    expect(b.sizeClass).toBe(sizeClass);
    expect(b.systemPromptBudget).toBe(Math.floor(b.inputBudget * ratio));
    expect(b.systemPromptBudget + b.messageBudget).toBeLessThanOrEqual(b.inputBudget);
  });
});
