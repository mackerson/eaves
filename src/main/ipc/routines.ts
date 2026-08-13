import { ipcMain } from 'electron';
import { getRoutineRepository } from '../repositories';
import { getRoutineScheduler, RoutineScheduler } from '../services/RoutineScheduler';
import { Routine } from '../types';
import {
  CreateRoutineSchema,
  UpdateRoutineSchema,
  EntityIdSchema,
  CronExpressionSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerRoutineHandlers() {
  const routinesRepo = getRoutineRepository();

  ipcMain.handle('routines:list', ipcResult('routines:list', async (_event, projectId: string) => {
    const validation = validateIPC(EntityIdSchema, projectId, 'routines:list');
    if (!validation.success) return validation;
    return routinesRepo.getByProjectId(validation.data);
  }));

  ipcMain.handle('routines:get', ipcResult('routines:get', async (_event, routineId: string) => {
    const validation = validateIPC(EntityIdSchema, routineId, 'routines:get');
    if (!validation.success) return validation;
    return routinesRepo.getById(validation.data);
  }));

  ipcMain.handle('routines:create', ipcResult('routines:create', async (_event, data: Omit<Routine, 'id' | 'createdAt' | 'updatedAt'>) => {
    const validation = validateIPC(CreateRoutineSchema, data, 'routines:create');
    if (!validation.success) return validation;

    const routineData = {
      ...validation.data,
      enabled: validation.data.enabled ?? true,
    };
    const routine = routinesRepo.create(routineData);
    return { success: true, routine };
  }));

  // The payload key is `updates` — preload has always sent that name, so
  // destructuring `data` here made every routine update fail Zod with
  // "Required": rename, reschedule, relink and the enable/disable toggle.
  ipcMain.handle('routines:update', ipcResult('routines:update', async (_event, { routineId, updates }: { routineId: string; updates: Partial<Omit<Routine, 'id' | 'projectId' | 'createdAt'>> }) => {
    const idValidation = validateIPC(EntityIdSchema, routineId, 'routines:update');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateRoutineSchema, updates, 'routines:update');
    if (!updatesValidation.success) return updatesValidation;

    const routine = routinesRepo.update(idValidation.data, updatesValidation.data);
    if (!routine) {
      return { success: false, error: 'Routine not found' };
    }
    return { success: true, routine };
  }));

  ipcMain.handle('routines:delete', ipcResult('routines:delete', async (_event, routineId: string) => {
    const validation = validateIPC(EntityIdSchema, routineId, 'routines:delete');
    if (!validation.success) return validation;

    const deleted = routinesRepo.delete(validation.data);
    if (!deleted) {
      return { success: false, error: 'Routine not found' };
    }
    return { success: true };
  }));

  ipcMain.handle('routines:execute', ipcResult('routines:execute', async (_event, routineId: string) => {
    const validation = validateIPC(EntityIdSchema, routineId, 'routines:execute');
    if (!validation.success) return validation;

    const scheduler = getRoutineScheduler();
    // A workflow whose nodes fail resolves rather than throwing, so reporting
    // success on "no exception" would tell the user a broken run went fine.
    const outcome = await scheduler.executeRoutine(validation.data);
    if (outcome.status === 'failure') {
      return {
        success: false,
        error: outcome.error || 'Routine execution failed',
        // Partial progress is the useful part of a failure — which node stopped it.
        execution: outcome.execution,
      };
    }
    return {
      success: true,
      skipped: outcome.status === 'skipped',
      reason: outcome.error,
      execution: outcome.execution,
    };
  }));

  ipcMain.handle('routines:scheduler-status', ipcResult('routines:scheduler-status', async () => {
    const scheduler = getRoutineScheduler();
    return { running: scheduler.isSchedulerRunning(), paused: scheduler.isPaused() };
  }));

  ipcMain.handle('routines:set-paused', ipcResult('routines:set-paused', async (_event, paused: unknown) => {
    if (typeof paused !== 'boolean') {
      return { success: false, error: 'paused must be a boolean' };
    }
    const { rescheduled } = getRoutineScheduler().setPaused(paused);
    return { success: true, paused, rescheduled };
  }));

  ipcMain.handle('routines:calculate-next-run', ipcResult('routines:calculate-next-run', async (_event, { cronExpression, fromTime }: { cronExpression: string; fromTime?: number }) => {
    const validation = validateIPC(CronExpressionSchema, cronExpression, 'routines:calculate-next-run');
    if (!validation.success) return validation;
    return RoutineScheduler.calculateNextRun(validation.data, fromTime);
  }));
}
