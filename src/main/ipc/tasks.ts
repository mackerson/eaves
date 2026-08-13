import { ipcMain } from 'electron';
import { getProjectRepository, getSettingsRepository } from '../repositories';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  ReorderItemsSchema,
  EntityIdSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerTaskHandlers() {
  ipcMain.handle('add-task', ipcResult('add-task', async (_event, taskData) => {
    const validation = validateIPC(CreateTaskSchema, taskData, 'add-task');
    if (!validation.success) return validation;

    const settingsRepo = getSettingsRepository();
    const projectRepo = getProjectRepository();

    const currentState = settingsRepo.getCurrentState();
    if (!currentState.projectId) {
      return { success: false, error: 'No active project' };
    }

    return projectRepo.createTask(currentState.projectId, taskData);
  }));

  ipcMain.handle('update-task', ipcResult('update-task', async (_event, { taskId, updates }: { taskId: string; updates: any }) => {
    const idValidation = validateIPC(EntityIdSchema, taskId, 'update-task taskId');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateTaskSchema, updates, 'update-task updates');
    if (!updatesValidation.success) return updatesValidation;

    const projectRepo = getProjectRepository();
    const task = projectRepo.updateTask(idValidation.data, updates);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }
    return task;
  }));

  ipcMain.handle('toggle-task', ipcResult('toggle-task', async (_event, taskId: string) => {
    const validation = validateIPC(EntityIdSchema, taskId, 'toggle-task');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    const task = projectRepo.toggleTask(validation.data);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }
    return task;
  }));

  ipcMain.handle('delete-task', ipcResult('delete-task', async (_event, taskId: string) => {
    const validation = validateIPC(EntityIdSchema, taskId, 'delete-task');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    projectRepo.deleteTask(validation.data);
    return { success: true };
  }));

  ipcMain.handle('reorder-tasks', ipcResult('reorder-tasks', async (_event, orders: { id: string; sortOrder: number }[]) => {
    const validation = validateIPC(ReorderItemsSchema, orders, 'reorder-tasks');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    const success = projectRepo.reorderTasks(validation.data);
    return { success };
  }));

}
