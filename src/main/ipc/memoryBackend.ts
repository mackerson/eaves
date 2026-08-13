import { ipcMain } from 'electron';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { getServiceRegistry } from '../services/ServiceRegistry';
import { getMemoryBlockRepository } from '../repositories';
import { EntityIdSchema } from '../../shared/validation';
import {
  MemoryBackendKeySchema,
  MemoryBackendListSchema,
  MemoryBackendSearchSchema,
  MemoryBackendStoreSchema,
  MemoryBlockSetSchema,
} from '../../shared/validation';

/**
 * Renderer-facing browse/manage IPC for the *active* memory-backend (the core
 * default or whatever plugin overrides it). This is the store-agnostic surface
 * the core Memory view uses — distinct from `ipc/memories.ts`, which handles the
 * shadow candidate-review lifecycle on the native `agent_memories` table.
 */

function callActiveBackend<T>(method: string, ...args: unknown[]): Promise<T> {
  const registry = getServiceRegistry();
  if (!registry.hasProviders('memory-backend')) {
    throw new Error('No memory backend is available');
  }
  return registry.call<T>('memory-backend', method, ...args);
}

export function registerMemoryBackendHandlers(): void {
  ipcMain.handle('memory:list', ipcResult('memory:list', async (_event, data: unknown) => {
    const v = validateIPC(MemoryBackendListSchema, data ?? {}, 'memory:list');
    if (!v.success) return v;
    return callActiveBackend('list', v.data.pattern, { limit: v.data.limit, offset: v.data.offset });
  }));

  ipcMain.handle('memory:search', ipcResult('memory:search', async (_event, data: unknown) => {
    const v = validateIPC(MemoryBackendSearchSchema, data, 'memory:search');
    if (!v.success) return v;
    return callActiveBackend('search', v.data);
  }));

  ipcMain.handle('memory:retrieve', ipcResult('memory:retrieve', async (_event, key: unknown) => {
    const v = validateIPC(MemoryBackendKeySchema, key, 'memory:retrieve');
    if (!v.success) return v;
    return callActiveBackend('retrieve', v.data);
  }));

  ipcMain.handle('memory:store', ipcResult('memory:store', async (_event, data: unknown) => {
    const v = validateIPC(MemoryBackendStoreSchema, data, 'memory:store');
    if (!v.success) return v;
    return callActiveBackend('store', v.data);
  }));

  ipcMain.handle('memory:delete', ipcResult('memory:delete', async (_event, key: unknown) => {
    const v = validateIPC(MemoryBackendKeySchema, key, 'memory:delete');
    if (!v.success) return v;
    return callActiveBackend('delete', v.data);
  }));

  // Core-memory blocks (agent-scoped) — the human-facing surface for the
  // always-in-context summaries the agent and the "dreaming" shadow maintain.
  ipcMain.handle('memory:blocks:list', ipcResult('memory:blocks:list', async (_event, agentId: unknown) => {
    const v = validateIPC(EntityIdSchema, agentId, 'memory:blocks:list');
    if (!v.success) return v;
    const repo = getMemoryBlockRepository();
    repo.ensureDefaults(v.data);
    return { success: true, blocks: repo.getByAgent(v.data) };
  }));

  ipcMain.handle('memory:block:set', ipcResult('memory:block:set', async (_event, data: unknown) => {
    const v = validateIPC(MemoryBlockSetSchema, data, 'memory:block:set');
    if (!v.success) return v;
    const row = getMemoryBlockRepository().setValue(v.data.agentId, v.data.label, v.data.value);
    if (!row) return { success: false, error: 'Block is read-only' };
    return { success: true, block: row };
  }));
}
