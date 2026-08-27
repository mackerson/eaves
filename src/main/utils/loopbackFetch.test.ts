/**
 * The bug this guards: a local model server bound to one IP family, and a
 * resolver that only answers with the other. Node 20's Happy Eyeballs covers
 * the usual case; it cannot cover a resolver returning a single address, which
 * is the shipping Windows default when the hosts file's IPv4 localhost line is
 * commented out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loopbackFetch, isLoopbackUrl, resetLoopbackCache } from './loopbackFetch';

const refused = () => Object.assign(new Error('connect ECONNREFUSED ::1:1234'), { code: 'ECONNREFUSED' });
const ok = (url: string) => ({ ok: true, url } as unknown as Response);

beforeEach(() => resetLoopbackCache());
afterEach(() => vi.unstubAllGlobals());

describe('isLoopbackUrl', () => {
  it.each([
    ['http://localhost:1234/v1', true],
    ['http://127.0.0.1:11434/api/tags', true],
    ['http://[::1]:1234/v1', true],
    ['http://LOCALHOST:1234/v1', true],
    ['https://openrouter.ai/api/v1/models', false],
    ['http://192.168.1.50:1234/v1', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

describe('loopbackFetch', () => {
  it('passes a remote URL straight through, untouched', async () => {
    const spy = vi.fn(async (u: string) => ok(u));
    vi.stubGlobal('fetch', spy);

    await loopbackFetch('https://openrouter.ai/api/v1/models');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
  });

  it('does not retry when the first attempt works', async () => {
    const spy = vi.fn(async (u: string) => ok(u));
    vi.stubGlobal('fetch', spy);

    await loopbackFetch('http://localhost:1234/v1/models');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reaches a server bound to IPv4 when localhost only answers ::1', async () => {
    const spy = vi.fn(async (u: string) => {
      if (u.includes('localhost')) throw refused();
      return ok(u);
    });
    vi.stubGlobal('fetch', spy);

    const res = await loopbackFetch('http://localhost:1234/v1/models');

    expect(res.url).toBe('http://127.0.0.1:1234/v1/models');
  });

  it('remembers which family answered, so the fallback is paid once', async () => {
    const spy = vi.fn(async (u: string) => {
      if (u.includes('localhost')) throw refused();
      return ok(u);
    });
    vi.stubGlobal('fetch', spy);

    await loopbackFetch('http://localhost:1234/v1/models');
    const callsAfterFirst = spy.mock.calls.length;
    await loopbackFetch('http://localhost:1234/v1/chat/completions');

    // Second request goes straight to the literal that worked: one call, not two.
    expect(spy.mock.calls.length).toBe(callsAfterFirst + 1);
    expect(spy.mock.calls[spy.mock.calls.length - 1][0]).toContain('127.0.0.1');
  });

  it('falls the other way too, for a server bound to IPv6 only', async () => {
    const spy = vi.fn(async (u: string) => {
      if (u.includes('[::1]')) return ok(u);
      throw refused();
    });
    vi.stubGlobal('fetch', spy);

    const res = await loopbackFetch('http://localhost:1234/v1/models');

    expect(res.url).toBe('http://[::1]:1234/v1/models');
  });

  // Retrying an HTTP error would double-send a real request that was received.
  it('never retries a response that arrived, however bad it is', async () => {
    const spy = vi.fn(async (u: string) => ({ ok: false, status: 500, url: u } as unknown as Response));
    vi.stubGlobal('fetch', spy);

    const res = await loopbackFetch('http://localhost:1234/v1/models');

    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never retries a failure that was not a connection failure', async () => {
    const spy = vi.fn(async () => { throw new Error('The operation was aborted'); });
    vi.stubGlobal('fetch', spy);

    await expect(loopbackFetch('http://localhost:1234/v1/models')).rejects.toThrow(/aborted/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports the original failure when nothing answers on any family', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw refused(); }));

    await expect(loopbackFetch('http://localhost:1234/v1/models'))
      .rejects.toThrow(/ECONNREFUSED/);
  });

  it('carries the method and body through to the retry', async () => {
    const spy = vi.fn(async (u: string) => {
      if (u.includes('localhost')) throw refused();
      return ok(u);
    });
    vi.stubGlobal('fetch', spy);

    await loopbackFetch('http://localhost:1234/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: 'x' }),
    });

    const [, init] = spy.mock.calls[spy.mock.calls.length - 1];
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ model: 'x' }) });
  });
});
