import { describe, it, expect } from 'vitest';
import type { Tool } from 'ai';
import { withToolCacheBreakpoint, supportsToolCacheBreakpoint, supportsSystemCacheBreakpoint, withMessageCacheBreakpoint } from './promptCache';

const tool = (description: string) => ({ description, inputSchema: {} }) as unknown as Tool;

describe('withToolCacheBreakpoint', () => {
  it('marks only the last tool — caching is a prefix, one breakpoint covers the block', () => {
    const out = withToolCacheBreakpoint({ a: tool('a'), b: tool('b'), c: tool('c') }, 'anthropic')!;
    const opts = (t: Tool) => (t as { providerOptions?: Record<string, unknown> }).providerOptions;

    expect(opts(out.a)).toBeUndefined();
    expect(opts(out.b)).toBeUndefined();
    expect(opts(out.c)).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });

  it('preserves key order — order is the cache identity', () => {
    const input = { z: tool('z'), a: tool('a'), m: tool('m') };
    expect(Object.keys(withToolCacheBreakpoint(input, 'anthropic')!)).toEqual(['z', 'a', 'm']);
  });

  // The SDK drops any registered tool missing from activeTools before it
  // serializes the block. Marking a gated-out tool would ship a tools block
  // with no breakpoint at all — the entire cache discount lost, silently.
  it('marks the last tool that is actually sent, not the last registered', () => {
    const input = { a: tool('a'), b: tool('b'), deferred: tool('deferred') };
    const out = withToolCacheBreakpoint(input, 'anthropic', ['a', 'b'])!;
    const opts = (t: Tool) => (t as { providerOptions?: Record<string, unknown> }).providerOptions;

    expect(opts(out.b)).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(opts(out.deferred)).toBeUndefined();
  });

  it('keeps every registered tool in the returned object when gating', () => {
    // activeTools decides what is sent; this function only decides where the
    // breakpoint goes. Dropping keys here would break same-turn enable→use.
    const input = { a: tool('a'), b: tool('b'), deferred: tool('deferred') };
    expect(Object.keys(withToolCacheBreakpoint(input, 'anthropic', ['a'])!)).toEqual(['a', 'b', 'deferred']);
  });

  it('falls back to the last registered tool when no active set is given', () => {
    const input = { a: tool('a'), b: tool('b') };
    const out = withToolCacheBreakpoint(input, 'anthropic')!;
    const opts = (t: Tool) => (t as { providerOptions?: Record<string, unknown> }).providerOptions;
    expect(opts(out.b)).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });

  // The builtin tool table is a module-level literal shared across every agent
  // and provider — mutating one entry would leak a breakpoint everywhere.
  it('never mutates the input tools', () => {
    const shared = { a: tool('a'), b: tool('b') };
    withToolCacheBreakpoint(shared, 'anthropic');
    expect((shared.b as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('leaves providers that cache automatically or not at all untouched', () => {
    for (const provider of ['openai', 'ollama', 'openrouter', 'google']) {
      const input = { a: tool('a') };
      expect(withToolCacheBreakpoint(input, provider)).toBe(input);
      expect(supportsToolCacheBreakpoint(provider)).toBe(false);
    }
    expect(supportsToolCacheBreakpoint('anthropic')).toBe(true);
  });

  it('handles empty and absent toolsets', () => {
    expect(withToolCacheBreakpoint(undefined, 'anthropic')).toBeUndefined();
    const empty = {};
    expect(withToolCacheBreakpoint(empty, 'anthropic')).toBe(empty);
  });

  it('merges into existing providerOptions rather than clobbering them', () => {
    const withOpts = {
      a: { description: 'a', inputSchema: {}, providerOptions: { anthropic: { deferLoading: true }, openai: { x: 1 } } } as unknown as Tool,
    };
    const out = withToolCacheBreakpoint(withOpts, 'anthropic')!;
    expect((out.a as { providerOptions: Record<string, unknown> }).providerOptions).toEqual({
      anthropic: { deferLoading: true, cacheControl: { type: 'ephemeral' } },
      openai: { x: 1 },
    });
  });
});

describe('supportsSystemCacheBreakpoint', () => {
  // OpenRouter's provider serializes tools without cache_control — a tool
  // breakpoint there is a silent no-op, so the breakpoint moves to system,
  // which still covers tools because tools render first.
  it('routes OpenRouter to the system breakpoint, not the tool one', () => {
    expect(supportsSystemCacheBreakpoint('openrouter')).toBe(true);
    expect(supportsToolCacheBreakpoint('openrouter')).toBe(false);
  });

  it('keeps Anthropic on the tool breakpoint', () => {
    expect(supportsToolCacheBreakpoint('anthropic')).toBe(true);
    expect(supportsSystemCacheBreakpoint('anthropic')).toBe(false);
  });

  it('leaves auto-caching and local providers on neither', () => {
    for (const p of ['openai', 'ollama', 'google']) {
      expect(supportsToolCacheBreakpoint(p)).toBe(false);
      expect(supportsSystemCacheBreakpoint(p)).toBe(false);
    }
  });
});

describe('withMessageCacheBreakpoint', () => {
  const msg = (content: string) => ({ role: 'user' as const, content });

  it('marks the last message so the next turn reuses the prefix', () => {
    const out = withMessageCacheBreakpoint([msg('a'), msg('b'), msg('c')], 'anthropic');
    const opts = (m: object) => (m as { providerOptions?: unknown }).providerOptions;

    expect(opts(out[0])).toBeUndefined();
    expect(opts(out[1])).toBeUndefined();
    expect(opts(out[2])).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });

  it('applies on both providers that honor message-level cache_control', () => {
    for (const p of ['anthropic', 'openrouter']) {
      const out = withMessageCacheBreakpoint([msg('a')], p);
      expect((out[0] as { providerOptions?: unknown }).providerOptions).toBeDefined();
    }
  });

  it('is a no-op for providers that cache automatically or not at all', () => {
    const input = [msg('a')];
    for (const p of ['openai', 'ollama', 'google']) {
      expect(withMessageCacheBreakpoint(input, p)).toBe(input);
    }
  });

  // Callers pass arrays assembled from persisted rows that other code holds.
  it('never mutates the input array or its messages', () => {
    const input = [msg('a'), msg('b')];
    const out = withMessageCacheBreakpoint(input, 'anthropic');
    expect(out).not.toBe(input);
    expect((input[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('handles an empty history', () => {
    const empty: object[] = [];
    expect(withMessageCacheBreakpoint(empty, 'anthropic')).toBe(empty);
  });
});
