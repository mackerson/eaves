import { ipcMain } from 'electron';
import { getAgentMemoryRepository } from '../repositories';
import { EntityIdSchema, ReviewMemorySchema, BulkReviewMemoriesSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { getServiceRegistry } from '../services/ServiceRegistry';
import { logger } from '../services/logger';
import { AgentMemory } from '../types';

/**
 * Write an approved memory through to the active memory-backend service (if any).
 * Uses agent-scoped key convention: agent:{agentId}:{memoryId}
 */
async function writeToMemoryBackend(memory: AgentMemory): Promise<void> {
  const serviceRegistry = getServiceRegistry();
  if (!serviceRegistry.hasProviders('memory-backend')) return;

  try {
    await serviceRegistry.call('memory-backend', 'store', {
      key: `agent:${memory.agentId}:${memory.id}`,
      value: memory.content,
      metadata: {
        tags: ['agent-memory', memory.memoryType],
        description: `Shadow-extracted memory (${memory.memoryType})`,
        agentId: memory.agentId,
        confidence: memory.confidence,
        sourceMemoryId: memory.id,
      },
    });
    logger.debug(`[Memories] Wrote approved memory ${memory.id} to memory-backend`);
  } catch (error) {
    logger.debug('[Memories] Failed to write to memory-backend (non-fatal):', error);
  }
}

export function registerMemoryHandlers() {
  ipcMain.handle('get-candidate-memories', ipcResult('get-candidate-memories', async (_event, agentId: string) => {
    const validation = validateIPC(EntityIdSchema, agentId, 'get-candidate-memories');
    if (!validation.success) return validation;

    const memoryRepo = getAgentMemoryRepository();
    return memoryRepo.getCandidatesByAgentId(validation.data);
  }));

  ipcMain.handle('get-candidate-memory-count', ipcResult('get-candidate-memory-count', async (_event, agentId: string) => {
    const validation = validateIPC(EntityIdSchema, agentId, 'get-candidate-memory-count');
    if (!validation.success) return validation;

    const memoryRepo = getAgentMemoryRepository();
    return memoryRepo.getCandidateCount(validation.data);
  }));

  ipcMain.handle('get-approved-memories', ipcResult('get-approved-memories', async (_event, agentId: string) => {
    const validation = validateIPC(EntityIdSchema, agentId, 'get-approved-memories');
    if (!validation.success) return validation;

    const memoryRepo = getAgentMemoryRepository();
    return memoryRepo.getApprovedByAgentId(validation.data);
  }));

  ipcMain.handle('review-memory', ipcResult('review-memory', async (_event, data: unknown) => {
    const validation = validateIPC(ReviewMemorySchema, data, 'review-memory');
    if (!validation.success) return validation;

    const { memoryId, status } = validation.data;
    const memoryRepo = getAgentMemoryRepository();
    const memory = memoryRepo.updateStatus(memoryId, status);
    if (!memory) {
      return { success: false, error: 'Memory not found' };
    }

    // Write through to memory-backend on approval
    if (status === 'approved') {
      await writeToMemoryBackend(memory);
    }

    return memory;
  }));

  ipcMain.handle('bulk-review-memories', ipcResult('bulk-review-memories', async (_event, data: unknown) => {
    const validation = validateIPC(BulkReviewMemoriesSchema, data, 'bulk-review-memories');
    if (!validation.success) return validation;

    const { memoryIds, status } = validation.data;
    const memoryRepo = getAgentMemoryRepository();
    const updated = memoryRepo.bulkUpdateStatus(memoryIds, status);

    // Write through approved memories to memory-backend
    if (status === 'approved') {
      for (const id of memoryIds) {
        const memory = memoryRepo.getById(id);
        if (memory) await writeToMemoryBackend(memory);
      }
    }

    return { updated };
  }));

  ipcMain.handle('delete-memory', ipcResult('delete-memory', async (_event, memoryId: string) => {
    const validation = validateIPC(EntityIdSchema, memoryId, 'delete-memory');
    if (!validation.success) return validation;

    const memoryRepo = getAgentMemoryRepository();
    return memoryRepo.delete(validation.data);
  }));
}
