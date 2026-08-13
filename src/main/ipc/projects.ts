import { ipcMain } from 'electron';
import { getProjectRepository, getSettingsRepository } from '../repositories';
import { eventBus } from '../services/EventBus';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  EntityIdSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerProjectHandlers() {
  ipcMain.handle('create-project', ipcResult('create-project', async (_event, { name, description }: { name: string; description: string }) => {
    const validation = validateIPC(CreateProjectSchema, { name, description }, 'create-project');
    if (!validation.success) return validation;
    const validData = validation.data;

    const projectRepo = getProjectRepository();
    const settingsRepo = getSettingsRepository();

    const newProject = projectRepo.create({ name: validData.name, description: validData.description ?? '' });
    settingsRepo.setCurrentProject(newProject.id);
    return newProject;
  }));

  ipcMain.handle('update-project', ipcResult('update-project', async (_event, { projectId, updates }: { projectId: string; updates: { name?: string; description?: string } }) => {
    const idValidation = validateIPC(EntityIdSchema, projectId, 'update-project');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateProjectSchema, updates, 'update-project');
    if (!updatesValidation.success) return updatesValidation;

    const projectRepo = getProjectRepository();
    return projectRepo.update(idValidation.data, updatesValidation.data);
  }));

  ipcMain.handle('switch-project', ipcResult('switch-project', async (_event, projectId: string) => {
    const validation = validateIPC(EntityIdSchema, projectId, 'switch-project');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    const settingsRepo = getSettingsRepository();

    const project = projectRepo.getById(validation.data);
    if (!project) {
      return { success: false, error: 'Project not found' };
    }
    settingsRepo.setCurrentProject(validation.data);

    // Hand the switched-to project's rows back. The renderer used to rehydrate
    // from its boot-time getMemory snapshot, which no renderer-initiated write
    // ever updates — so every note and task created this session vanished on a
    // switch, and everything deleted came back. Nothing extra is read here:
    // getById above already hydrated all of it to validate the id, and the
    // rows were simply being discarded.
    return {
      success: true,
      tasks: project.tasks,
      notes: project.notes,
      events: project.events,
      // Labels are stored per project but the renderer keeps one global
      // bucket, so they have to travel with the switch or A's chips stay on
      // screen in B.
      labels: projectRepo.getLabelsByProjectId(validation.data),
    };
  }));

  ipcMain.handle('delete-project', ipcResult('delete-project', async (_event, projectId: string) => {
    const validation = validateIPC(EntityIdSchema, projectId, 'delete-project');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    projectRepo.delete(validation.data);
    // Deletes update the initiating window optimistically, but the event is
    // still needed so ActivityPersistence records the deletion (parity with
    // agent:deleted) and any future sync/second-window consumer sees it.
    eventBus.emitEvent('project:deleted', { id: validation.data, projectId: validation.data });
    return { success: true };
  }));
}
