import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ActiveWorkRegistry } from './ActiveWorkRegistry';

describe('ActiveWorkRegistry', () => {
  let registry: ActiveWorkRegistry;

  beforeEach(() => {
    registry = new ActiveWorkRegistry();
  });

  it('lists work while it runs and drops it when done', () => {
    const work = registry.start({ kind: 'chat-turn', agentId: 'a1', agentName: 'Ninja', containerId: 'chat-1' });
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]).toMatchObject({ kind: 'chat-turn', agentId: 'a1', agentName: 'Ninja' });

    work.done();
    expect(registry.list()).toEqual([]);
  });

  it('keeps concurrent work separate', () => {
    registry.start({ kind: 'chat-turn', agentId: 'a1' });
    registry.start({ kind: 'routine', label: 'HMD BG Collector' });
    registry.start({ kind: 'code-execution', label: 'python' });

    expect(registry.list().map(w => w.kind).sort()).toEqual(['chat-turn', 'code-execution', 'routine']);
  });

  it('reports work with no cancel hook as not cancellable', () => {
    registry.start({ kind: 'routine', label: 'HMD BG Collector' });
    expect(registry.list()[0].cancellable).toBe(false);
  });

  it('invokes the owner cancel hook', () => {
    const onCancel = vi.fn();
    const work = registry.start({ kind: 'chat-turn', agentId: 'a1', onCancel });

    expect(registry.list()[0].cancellable).toBe(true);
    expect(registry.cancel(work.id)).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // Cancel asks the owner to wind down; the owner's finally is what removes
  // the entry. Dropping it here would show the work as gone while it is still
  // running.
  it('leaves the entry in place until the owner finishes', () => {
    const work = registry.start({ kind: 'chat-turn', agentId: 'a1', onCancel: vi.fn() });
    registry.cancel(work.id);
    expect(registry.list()).toHaveLength(1);

    work.done();
    expect(registry.list()).toEqual([]);
  });

  it('never claims a stop it did not get', () => {
    expect(registry.cancel('no-such-id')).toBe(false);

    const uncancellable = registry.start({ kind: 'routine' });
    expect(registry.cancel(uncancellable.id)).toBe(false);

    const throwing = registry.start({ kind: 'chat-turn', onCancel: () => { throw new Error('boom'); } });
    expect(registry.cancel(throwing.id)).toBe(false);
  });

  // A leaked entry is indistinguishable from real work and would show a
  // phantom "running" forever.
  it('sweeps entries whose owner never called done', () => {
    vi.useFakeTimers();
    try {
      registry.start({ kind: 'chat-turn', agentId: 'a1' });
      expect(registry.list()).toHaveLength(1);

      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(registry.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('orders newest first', () => {
    vi.useFakeTimers();
    try {
      registry.start({ kind: 'chat-turn', label: 'older' });
      vi.advanceTimersByTime(1000);
      registry.start({ kind: 'chat-turn', label: 'newer' });

      expect(registry.list().map(w => w.label)).toEqual(['newer', 'older']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leak the cancel hook to consumers', () => {
    registry.start({ kind: 'chat-turn', onCancel: vi.fn() });
    expect('onCancel' in registry.list()[0]).toBe(false);
  });
});
