/**
 * Spike (committed): does global WebSocket exist in a plugin Worker Thread?
 *
 * FINDING (2026-10-01, verified by running this worker shape under the real
 * Electron binary): NO on the runtime that matters. Electron 32.3.3 bundles
 * Node 20.18.1, where undici's WebSocket is still behind
 * --experimental-websocket — `typeof globalThis.WebSocket` is 'undefined' in
 * the plugin worker (and in main's Node side), while `fetch` IS a global.
 * Under system Node >= 22 (what vitest runs on) WebSocket is global, so the
 * catalog's "Node >= 22 should have it" assumption fails only because
 * Electron 32's Node is 20.x. No trivial fix: execArgv experiment flags on
 * the worker are fragile under Electron, and an Electron major bump is its
 * own project. Until the bump, WS-dependent bridges (Discord, Slack Socket
 * Mode, nostr) must bundle a userland client (e.g. `ws`, pure JS over
 * net/tls — works today via the plugin's own CJS requires, same
 * trusted-by-install path as `fetch`) or use the gated net:socket broker.
 *
 * The test spawns a worker exactly the way PluginWorker does (no execArgv,
 * only resourceLimits) and pins the per-runtime expectation so a Node or
 * Electron upgrade that changes the answer fails loudly here.
 */

import { describe, it, expect } from 'vitest';
import { Worker } from 'worker_threads';

interface WorkerGlobals {
  node: string;
  webSocket: string;
  fetch: string;
}

function probeWorkerGlobals(): Promise<WorkerGlobals> {
  return new Promise((resolve, reject) => {
    // Same spawn shape as PluginWorker: no execArgv, resourceLimits only.
    const worker = new Worker(
      `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage({
        node: process.versions.node,
        webSocket: typeof globalThis.WebSocket,
        fetch: typeof globalThis.fetch,
      });
      `,
      { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64 } }
    );
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker probe timed out'));
    }, 5000);
    worker.once('message', (msg: WorkerGlobals) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(msg);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('plugin worker thread globals', () => {
  it('WebSocket presence matches the runtime Node major (>=22 global, <22 absent)', async () => {
    const globals = await probeWorkerGlobals();
    const major = parseInt(globals.node.split('.')[0], 10);
    if (major >= 22) {
      expect(globals.webSocket).toBe('function');
    } else {
      // Electron 32's bundled Node 20.x lands here when this runs in-app.
      expect(globals.webSocket).toBe('undefined');
    }
  });

  it('fetch is a global in the worker on every supported runtime', async () => {
    const globals = await probeWorkerGlobals();
    expect(globals.fetch).toBe('function');
  });
});
