/**
 * Reaching a local server that is listening on the other IP family.
 *
 * `localhost` resolves to both `::1` and `127.0.0.1`, and a local model server
 * usually binds only one of them — LM Studio and Ollama both default to IPv4.
 * Node 20 turns on Happy Eyeballs (`autoSelectFamily`), so a connection refused
 * on `::1` normally rolls over to `127.0.0.1` on its own and none of this is
 * needed.
 *
 * What Happy Eyeballs cannot fix is a resolver that returns only one family.
 * That is a real configuration on Windows, where a hosts file with the IPv4
 * `localhost` line commented out (the shipping default) leaves the DNS client
 * answering `::1` and nothing else — so there is no second address to race, the
 * connect is refused, and the server that is plainly running looks absent.
 *
 * So: on a connection failure, retry against the loopback literals explicitly.
 *
 * **Only loopback.** A hostname that is not `localhost`/`127.0.0.1`/`::1` is
 * never rewritten. Silently sending a request somewhere other than where the
 * user pointed us is a much worse bug than the one being fixed.
 */

import { isConnectionError } from './aiErrors';
import { logger } from '../services/logger';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Literals to try, in order, once the configured host has failed. */
const LOOPBACK_LITERALS = ['127.0.0.1', '[::1]'];

/**
 * Which literal actually answered for a given origin, remembered so the
 * fallback is paid once rather than on every request to a v6-only resolver.
 */
const known = new Map<string, string>();

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isLoopbackUrl(url: string): boolean {
  const parsed = parse(url);
  return !!parsed && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/** `http://localhost:1234/v1` + `127.0.0.1` → `http://127.0.0.1:1234/v1`. */
function withHost(url: string, host: string): string {
  const parsed = parse(url);
  if (!parsed) return url;
  // `URL.host` keeps the port; assigning hostname alone preserves it too, but
  // bracketed IPv6 has to go through `host` to stay legal.
  parsed.host = host.startsWith('[') ? `${host}:${parsed.port}` : `${host}${parsed.port ? `:${parsed.port}` : ''}`;
  return parsed.toString();
}

function originOf(url: string): string {
  const parsed = parse(url);
  return parsed ? `${parsed.protocol}//${parsed.host}` : url;
}

/**
 * `fetch`, with a loopback-family retry.
 *
 * A drop-in for the global: same signature, same return, and for any
 * non-loopback URL it is exactly `fetch` with no added behaviour. Errors that
 * are not connection failures (an HTTP 500, a bad JSON body) propagate
 * untouched — this only ever retries when nothing answered at all.
 */
export async function loopbackFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  // Forward the exact argument list we were given. `fetch(url, undefined)` is
  // semantically identical to `fetch(url)`, but callers (and their tests) can
  // see the difference, and a drop-in should not be detectable.
  const call = (target: string | URL | Request) =>
    (init === undefined ? fetch(target as never) : fetch(target as never, init));

  if (!isLoopbackUrl(url)) return call(input);

  // A previous request already found which literal answers here.
  const remembered = known.get(originOf(url));
  const first = remembered ? withHost(url, remembered) : url;

  try {
    return await call(first);
  } catch (error) {
    if (!isConnectionError(error)) throw error;

    for (const literal of LOOPBACK_LITERALS) {
      const candidate = withHost(url, literal);
      if (candidate === first) continue;
      try {
        const response = await call(candidate);
        known.set(originOf(url), literal);
        logger.info('[loopback] Reached a local server on the other IP family', {
          configured: originOf(url), reachedVia: literal,
        });
        return response;
      } catch (retryError) {
        if (!isConnectionError(retryError)) throw retryError;
      }
    }

    throw error; // nothing answered; the original failure is the honest one
  }
}

/** Test seam — the remembered family is process-lifetime cache, not state. */
export function resetLoopbackCache(): void {
  known.clear();
}
