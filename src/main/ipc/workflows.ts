import { ipcMain } from 'electron';
import { getWorkflowRepository } from '../repositories';
import { getWorkflowExecutor } from '../services/WorkflowExecutor';
import { Workflow } from '../types';
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  ExecuteWorkflowSchema,
  EntityIdSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerWorkflowHandlers() {
  const workflowsRepo = getWorkflowRepository();

  ipcMain.handle('workflows:list', ipcResult('workflows:list', async (_event, projectId: string) => {
    const validation = validateIPC(EntityIdSchema, projectId, 'workflows:list');
    if (!validation.success) return validation;
    return workflowsRepo.getByProjectId(validation.data);
  }));

  ipcMain.handle('workflows:get', ipcResult('workflows:get', async (_event, workflowId: string) => {
    const validation = validateIPC(EntityIdSchema, workflowId, 'workflows:get');
    if (!validation.success) return validation;
    return workflowsRepo.getById(validation.data);
  }));

  ipcMain.handle('workflows:create', ipcResult('workflows:create', async (_event, data: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>) => {
    const validation = validateIPC(CreateWorkflowSchema, data, 'workflows:create');
    if (!validation.success) return validation;
    const validData = validation.data as Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>;
    return workflowsRepo.create(validData);
  }));

  ipcMain.handle('workflows:update', ipcResult('workflows:update', async (_event, { workflowId, data }: { workflowId: string; data: Partial<Omit<Workflow, 'id' | 'projectId' | 'createdAt'>> }) => {
    const idValidation = validateIPC(EntityIdSchema, workflowId, 'workflows:update');
    if (!idValidation.success) return idValidation;
    const dataValidation = validateIPC(UpdateWorkflowSchema, data, 'workflows:update');
    if (!dataValidation.success) return dataValidation;
    return workflowsRepo.update(idValidation.data, dataValidation.data);
  }));

  ipcMain.handle('workflows:delete', ipcResult('workflows:delete', async (_event, workflowId: string) => {
    const validation = validateIPC(EntityIdSchema, workflowId, 'workflows:delete');
    if (!validation.success) return validation;
    return workflowsRepo.delete(validation.data);
  }));

  ipcMain.handle('workflows:execute', ipcResult('workflows:execute', async (_event, { workflowId, variables }: { workflowId: string; variables?: Record<string, any> }) => {
    const validation = validateIPC(ExecuteWorkflowSchema, { workflowId, variables }, 'workflows:execute');
    if (!validation.success) return validation;

    const workflow = workflowsRepo.getById(validation.data.workflowId);
    if (!workflow) {
      return { success: false, error: `Workflow not found: ${validation.data.workflowId}` };
    }

    const executor = getWorkflowExecutor();
    return executor.executeWorkflow(workflow, validation.data.variables || {});
  }));

  ipcMain.handle('workflows:approve', ipcResult('workflows:approve', async (_event, workflowId: string) => {
    const validation = validateIPC(EntityIdSchema, workflowId, 'workflows:approve');
    if (!validation.success) return validation;

    const workflow = workflowsRepo.setReviewStatus(validation.data, 'approved');
    if (!workflow) {
      return { success: false, error: `Workflow not found: ${validation.data}` };
    }
    return { success: true, workflow };
  }));

  ipcMain.handle('workflows:count-pending-review', ipcResult('workflows:count-pending-review', async (_event, projectId?: string) => {
    if (projectId !== undefined && projectId !== null) {
      const validation = validateIPC(EntityIdSchema, projectId, 'workflows:count-pending-review');
      if (!validation.success) return validation;
      return { success: true, count: workflowsRepo.countPendingReview(validation.data) };
    }
    return { success: true, count: workflowsRepo.countPendingReview() };
  }));
}
