import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
// builtinTools transitively loads database.ts, which reads app.getPath at module
// load. Stub Electron so the import graph resolves (the memory tools never touch
// the DB — they route through the service registry).
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));

import { builtinTools } from './builtinTools';
import { getServiceRegistry } from './ServiceRegistry';

// The core memory tools are backend-agnostic: they route through the active
// `memory-backend` service. Here we register a spy backend and assert each tool
// forwards the right method + args and returns the backend's result verbatim.

const calls: Array<[string, unknown[]]> = [];
const spyBackend = {
  store: (...a: unknown[]) => { calls.push(['store', a]); return Promise.resolve({ success: true, key: (a[0] as any).key }); },
  retrieve: (...a: unknown[]) => { calls.push(['retrieve', a]); return Promise.resolve({ success: true, key: a[0], value: 'v' }); },
  search: (...a: unknown[]) => { calls.push(['search', a]); return Promise.resolve({ success: true, query: (a[0] as any).query, count: 0, results: [] }); },
  list: (...a: unknown[]) => { calls.push(['list', a]); return Promise.resolve({ success: true, count: 0, keys: [] }); },
  delete: (...a: unknown[]) => { calls.push(['delete', a]); return Promise.resolve({ success: true, key: a[0] }); },
};

const exec = (name: keyof typeof builtinTools, input: unknown) =>
  (builtinTools[name] as any).execute(input, {} as any);

beforeEach(() => {
  calls.length = 0;
  getServiceRegistry().register('spy', 'memory-backend', spyBackend as any, {});
});
afterEach(() => {
  getServiceRegistry().unregister('spy', 'memory-backend');
});

describe('core memory tools route through the memory-backend service', () => {
  it('store_memory → store({key,value,metadata})', async () => {
    const r = await exec('store_memory', { key: 'k', value: 'v', metadata: { tags: ['t'] } });
    expect(calls[0]).toEqual(['store', [{ key: 'k', value: 'v', metadata: { tags: ['t'] } }]]);
    expect(r).toEqual({ success: true, key: 'k' });
  });

  it('retrieve_memory → retrieve(key)', async () => {
    await exec('retrieve_memory', { key: 'k' });
    expect(calls[0]).toEqual(['retrieve', ['k']]);
  });

  it('search_memories → search({query,limit,tags})', async () => {
    await exec('search_memories', { query: 'whale', limit: 5, tags: ['work'] });
    expect(calls[0]).toEqual(['search', [{ query: 'whale', limit: 5, tags: ['work'] }]]);
  });

  it('list_memories → list(pattern)', async () => {
    await exec('list_memories', { pattern: 'agent:*' });
    expect(calls[0]).toEqual(['list', ['agent:*']]);
  });

  it('delete_memory → delete(key)', async () => {
    await exec('delete_memory', { key: 'k' });
    expect(calls[0]).toEqual(['delete', ['k']]);
  });
});
