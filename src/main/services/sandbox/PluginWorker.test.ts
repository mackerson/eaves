/**
 * PluginWorker Tests
 *
 * Focused on the fail-closed lifecycle guarantees around a worker that never
 * comes up cleanly: it must be terminated (not left running untracked), its
 * listeners detached, and it must refuse to be resurrected by a stray
 * message even if detachment somehow didn't happen.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class MockWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => 0);
}

let lastMockWorker: MockWorker | null = null;

vi.mock('worker_threads', () => {
  // A plain `function`, not an arrow, because `new Worker(...)` requires the
  // mock implementation to be constructible.
  const Worker = vi.fn().mockImplementation(function () {
    lastMockWorker = new MockWorker();
    return lastMockWorker;
  });
  return { Worker, default: { Worker } };
});

import { PluginWorker } from './PluginWorker';
import type { WorkerConfig } from './types';

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    pluginId: 'test-plugin',
    manifestPath: '/fake/plugin.json',
    entryPath: '/fake/index.js',
    permissions: [],
    config: {},
    userDataPath: '/fake/userData',
    avatarsPath: '/fake/userData/avatars',
    ...overrides,
  };
}

function readyMessage() {
  return { type: 'plugin:ready', id: 'r', pluginId: 'test-plugin', timestamp: Date.now() };
}

function rpcRequestMessage() {
  return {
    type: 'rpc:request',
    id: 'req-1',
    pluginId: 'test-plugin',
    timestamp: Date.now(),
    namespace: 'data',
    method: 'noop',
    args: [],
  };
}

describe('PluginWorker', () => {
  beforeEach(() => {
    lastMockWorker = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sets an unlimited listener cap so concurrent executeTool calls do not warn', () => {
    const worker = new PluginWorker(makeConfig());
    expect(worker.getMaxListeners()).toBe(0);
  });

  describe('start() failure handling', () => {
    it('terminates the worker thread when it never signals ready', async () => {
      const worker = new PluginWorker(makeConfig());
      const startPromise = worker.start();
      // Attach the rejection assertion before advancing timers so the
      // rejection is never briefly unhandled.
      const assertion = expect(startPromise).rejects.toThrow(/failed to start/i);

      await vi.advanceTimersByTimeAsync(30000);
      await assertion;

      expect(worker.getState()).toBe('crashed');
      expect(lastMockWorker?.terminate).toHaveBeenCalledTimes(1);
    });

    it('detaches its listeners so a late message from the dead worker cannot resurrect it', async () => {
      const worker = new PluginWorker(makeConfig());
      const startPromise = worker.start();
      const assertion = expect(startPromise).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;

      const rpcSpy = vi.fn();
      worker.on('rpc-request', rpcSpy);

      // The listeners start() attached to the (mock) underlying worker
      // should already be gone; emitting on it directly proves that.
      lastMockWorker!.emit('message', rpcRequestMessage());

      expect(rpcSpy).not.toHaveBeenCalled();
      expect(worker.getState()).toBe('crashed');
    });

    it('refuses to resurrect via rpc:request even if a listener were still attached (defense in depth)', () => {
      const worker = new PluginWorker(makeConfig());
      // Simulate the terminal state directly, bypassing the listener-removal
      // path entirely, to prove the state guard alone is sufficient.
      (worker as any).state = 'crashed';
      (worker as any).worker = null;

      const rpcSpy = vi.fn();
      worker.on('rpc-request', rpcSpy);

      (worker as any).handleMessage(rpcRequestMessage());

      expect(rpcSpy).not.toHaveBeenCalled();
      expect(worker.getState()).toBe('crashed');
    });

    it('does not resurrect a stopped worker either', () => {
      const worker = new PluginWorker(makeConfig());
      (worker as any).state = 'stopped';
      (worker as any).worker = null;

      const rpcSpy = vi.fn();
      worker.on('rpc-request', rpcSpy);

      (worker as any).handleMessage(rpcRequestMessage());

      expect(rpcSpy).not.toHaveBeenCalled();
      expect(worker.getState()).toBe('stopped');
    });

    it('still transitions to running for a legitimately live worker', async () => {
      const worker = new PluginWorker(makeConfig());
      const startPromise = worker.start();
      lastMockWorker!.emit('message', readyMessage());
      await startPromise;

      const rpcSpy = vi.fn();
      worker.on('rpc-request', rpcSpy);

      lastMockWorker!.emit('message', rpcRequestMessage());

      expect(rpcSpy).toHaveBeenCalledTimes(1);
      expect(worker.getState()).toBe('running');
    });
  });

  describe('exit handling', () => {
    async function running(): Promise<PluginWorker> {
      const worker = new PluginWorker(makeConfig());
      const startPromise = worker.start();
      lastMockWorker!.emit('message', readyMessage());
      await startPromise;
      return worker;
    }

    it('treats an unrequested exit code 0 as a clean stop, not a crash', async () => {
      const worker = await running();
      const onCrash = vi.fn();
      worker.on('crash', onCrash);

      // A plugin whose entry simply returns exits 0. Calling that a crash put
      // a scary line in the log and inflated restartCount for normal exits.
      lastMockWorker!.emit('exit', 0);

      expect(onCrash).not.toHaveBeenCalled();
      expect(worker.getState()).toBe('stopped');
    });

    it('still reports a non-zero exit as a crash', async () => {
      const worker = await running();
      const onCrash = vi.fn();
      worker.on('crash', onCrash);

      lastMockWorker!.emit('exit', 1);

      expect(onCrash).toHaveBeenCalledWith(1);
      expect(worker.getState()).toBe('crashed');
    });
  });

  describe('executeTool', () => {
    async function startedWorker(): Promise<PluginWorker> {
      const worker = new PluginWorker(makeConfig());
      const startPromise = worker.start();
      lastMockWorker!.emit('message', readyMessage());
      await startPromise;
      return worker;
    }

    it('rejects promptly when the worker crashes mid-call, instead of waiting out the full timeout', async () => {
      const worker = await startedWorker();

      const execPromise = worker.executeTool('doThing', {});
      const assertion = expect(execPromise).rejects.toThrow(/crashed/i);

      // Worker thread dies mid-call.
      lastMockWorker!.emit('exit', 1);

      await assertion;
    });

    it('cleans up the crash listener once the call resolves normally (no leak across calls)', async () => {
      const worker = await startedWorker();

      const execPromise = worker.executeTool('doThing', {});
      expect(worker.listenerCount('crash')).toBe(1);

      // Echo back the executionId the worker was sent so tool-result matches.
      const sentMessage = lastMockWorker!.postMessage.mock.calls.at(-1)?.[0];
      lastMockWorker!.emit('message', {
        type: 'tool:result',
        id: 'tr',
        pluginId: 'test-plugin',
        timestamp: Date.now(),
        executionId: sentMessage.executionId,
        result: { ok: true },
      });

      await expect(execPromise).resolves.toEqual({ ok: true });
      expect(worker.listenerCount('crash')).toBe(0);
      expect(worker.listenerCount('tool-result')).toBe(0);
    });
  });
});
