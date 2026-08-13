import { ipcMain } from 'electron';
import { getActivityRepository } from '../repositories';
import { logger } from '../services/logger';
import { ActivityAudienceSchema, ActivityFilterSchema, TimestampSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerActivityHandlers() {
  ipcMain.handle('activities:list', ipcResult('activities:list', async (_event, filter?: unknown) => {
    const repo = getActivityRepository();

    if (filter) {
      const validation = validateIPC(ActivityFilterSchema, filter, 'activities:list');
      if (!validation.success) return validation;
      return { success: true, activities: repo.getAll(validation.data) };
    }

    return { success: true, activities: repo.getAll({ limit: 100 }) };
  }));

  ipcMain.handle('activities:recent-count', ipcResult('activities:recent-count', async (_event, since?: unknown) => {
    const repo = getActivityRepository();
    if (since != null) {
      const validation = validateIPC(TimestampSchema, since, 'activities:recent-count');
      if (!validation.success) return validation;
      return { success: true, count: repo.getRecentCount(validation.data) };
    }
    return { success: true, count: repo.getRecentCount(Date.now() - 24 * 60 * 60 * 1000) };
  }));

  ipcMain.handle('activities:categories', ipcResult('activities:categories', async (_event, audience?: unknown) => {
    const repo = getActivityRepository();
    if (audience != null) {
      const validation = validateIPC(ActivityAudienceSchema, audience, 'activities:categories');
      if (!validation.success) return validation;
      return { success: true, categories: repo.getCategories(validation.data) };
    }
    return { success: true, categories: repo.getCategories() };
  }));

  ipcMain.handle('activities:clear', ipcResult('activities:clear', async () => {
    const repo = getActivityRepository();
    repo.clear();
    logger.info('[Activities] Cleared all activities');
    return { success: true };
  }));

  ipcMain.handle('activities:clear-before', ipcResult('activities:clear-before', async (_event, timestamp?: unknown) => {
    const validation = validateIPC(TimestampSchema, timestamp, 'activities:clear-before');
    if (!validation.success) return validation;

    const repo = getActivityRepository();
    const deleted = repo.clearBefore(validation.data);
    logger.info(`[Activities] Cleared ${deleted} activities before ${new Date(validation.data).toISOString()}`);
    return { success: true, deleted };
  }));

  ipcMain.handle('activities:count', ipcResult('activities:count', async () => {
    const repo = getActivityRepository();
    return { success: true, count: repo.getCount() };
  }));
}
