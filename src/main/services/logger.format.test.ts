import { describe, it, expect, vi } from 'vitest';

// The Logger class constructs against app.getPath at import time; only the
// pure formatter is under test here.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/enclave-test' } }));

import { formatLogArgs } from './logger';

describe('formatLogArgs', () => {
  it('keeps the message and stack of an error passed on its own', () => {
    const out = formatLogArgs(new Error('the disk is on fire'));
    expect(out).toContain('the disk is on fire');
    expect(out).toContain('logger.format.test.ts');
  });

  /**
   * The regression this exists for. A packaged build's better-sqlite3 ABI
   * mismatch was logged as `{ reason, promise }` and landed on disk as
   * `{"reason":{"code":"ERR_DLOPEN_FAILED"}}` — every word explaining what
   * failed was dropped, because message and stack are non-enumerable.
   */
  it('keeps the message of an error nested inside a context object', () => {
    const reason = Object.assign(new Error('NODE_MODULE_VERSION 127 vs 128'), {
      code: 'ERR_DLOPEN_FAILED',
    });

    const out = formatLogArgs('Unhandled Promise Rejection:', { reason, promise: {} });

    expect(out).toContain('NODE_MODULE_VERSION 127 vs 128');
    expect(out).toContain('ERR_DLOPEN_FAILED');
  });

  it('keeps a wrapped error\'s cause, which the constructor makes non-enumerable', () => {
    const err = new Error('could not open the database', { cause: new Error('permission denied') });
    const out = formatLogArgs({ err });
    expect(out).toContain('could not open the database');
    expect(out).toContain('permission denied');
  });

  it('does not let a subclass shadow name or message with its own properties', () => {
    class Weird extends Error {
      name = 'Weird';
      constructor() {
        super('the real message');
      }
    }
    const out = formatLogArgs({ err: new Weird() });
    expect(out).toContain('the real message');
    expect(out).toContain('Weird');
  });

  it('truncates a single oversized argument rather than writing it whole', () => {
    const out = formatLogArgs({ blob: 'x'.repeat(10_000) });
    expect(out).toContain('[truncated,');
    expect(out.length).toBeLessThan(4_500);
  });

  it('falls back to String() on a circular object instead of throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => formatLogArgs(circular)).not.toThrow();
  });

  it('passes primitives through', () => {
    expect(formatLogArgs('plugin', 3, true)).toBe('plugin 3 true');
  });

  it('renders null without treating it as an object', () => {
    expect(formatLogArgs(null)).toBe('null');
  });
});
