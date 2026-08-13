import { ipcMain } from 'electron';
import { getEventRepository, getMilestoneRepository, getDeadlineRepository } from '../repositories';
import { ScheduleEvent, Milestone, Deadline } from '../types';
import { logger } from '../services/logger';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import {
  CreateEventSchema,
  UpdateEventSchema,
  CreateMilestoneSchema,
  UpdateMilestoneSchema,
  CreateDeadlineSchema,
  UpdateDeadlineSchema,
  DateRangeSchema,
  EntityIdSchema,
} from '../../shared/validation';

export function registerSchedulingHandlers() {
  // Remove any existing handlers first to prevent double registration errors
  // This can happen when Electron doesn't fully clean up on hot reload
  const handlers = [
    'get-events', 'get-event', 'create-event', 'update-event', 'delete-event', 'get-events-by-date-range',
    'get-milestones', 'get-milestone', 'create-milestone', 'update-milestone', 'delete-milestone',
    'get-deadlines', 'get-deadline', 'create-deadline', 'update-deadline', 'delete-deadline'
  ];

  for (const handler of handlers) {
    ipcMain.removeHandler(handler);
  }

  // ============================================
  // Event Handlers
  // ============================================

  ipcMain.handle('get-events', ipcResult('get-events', async (_event, projectId?: string) => {
    if (projectId) {
      const validation = validateIPC(EntityIdSchema, projectId, 'get-events');
      if (!validation.success) return validation;
    }

    const eventRepo = getEventRepository();
    if (projectId) {
      return eventRepo.getByProjectId(projectId);
    }
    return eventRepo.getAll();
  }));

  ipcMain.handle('get-event', ipcResult('get-event', async (_event, eventId: string) => {
    const validation = validateIPC(EntityIdSchema, eventId, 'get-event');
    if (!validation.success) return validation;

    const eventRepo = getEventRepository();
    return eventRepo.getById(validation.data);
  }));

  ipcMain.handle('create-event', ipcResult('create-event', async (_event, eventData: Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>) => {
    const validation = validateIPC(CreateEventSchema, eventData, 'create-event');
    if (!validation.success) return validation;

    const eventRepo = getEventRepository();
    const event = eventRepo.create(eventData);
    logger.info('[IPC] Event created', { eventId: event.id });
    return { success: true, event };
  }));

  ipcMain.handle('update-event', ipcResult('update-event', async (_event, { eventId, updates }: { eventId: string; updates: Partial<Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt'>> }) => {
    const idValidation = validateIPC(EntityIdSchema, eventId, 'update-event');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateEventSchema, updates, 'update-event');
    if (!updatesValidation.success) return updatesValidation;

    const eventRepo = getEventRepository();
    // Validated payload, not the raw one — see terminal.ts:create.
    const event = eventRepo.update(idValidation.data, updatesValidation.data);
    if (!event) {
      return { success: false, error: 'Event not found' };
    }
    logger.info('[IPC] Event updated', { eventId: idValidation.data });
    return { success: true, event };
  }));

  ipcMain.handle('delete-event', ipcResult('delete-event', async (_event, eventId: string) => {
    const validation = validateIPC(EntityIdSchema, eventId, 'delete-event');
    if (!validation.success) return validation;

    const eventRepo = getEventRepository();
    const success = eventRepo.delete(validation.data);
    if (success) {
      logger.info('[IPC] Event deleted', { eventId: validation.data });
    }
    return { success };
  }));

  ipcMain.handle('get-events-by-date-range', ipcResult('get-events-by-date-range', async (_event, { startTime, endTime, projectId }: { startTime: number; endTime: number; projectId?: string }) => {
    const validation = validateIPC(DateRangeSchema, { startTime, endTime, projectId }, 'get-events-by-date-range');
    if (!validation.success) return validation;

    const eventRepo = getEventRepository();
    return eventRepo.getByDateRange(validation.data.startTime, validation.data.endTime, validation.data.projectId);
  }));

  // ============================================
  // Milestone Handlers
  // ============================================

  ipcMain.handle('get-milestones', ipcResult('get-milestones', async (_event, projectId?: string) => {
    if (projectId) {
      const validation = validateIPC(EntityIdSchema, projectId, 'get-milestones');
      if (!validation.success) return validation;
    }

    const milestoneRepo = getMilestoneRepository();
    if (projectId) {
      return milestoneRepo.getByProjectId(projectId);
    }
    return milestoneRepo.getAll();
  }));

  ipcMain.handle('get-milestone', ipcResult('get-milestone', async (_event, milestoneId: string) => {
    const validation = validateIPC(EntityIdSchema, milestoneId, 'get-milestone');
    if (!validation.success) return validation;

    const milestoneRepo = getMilestoneRepository();
    return milestoneRepo.getById(validation.data);
  }));

  ipcMain.handle('create-milestone', ipcResult('create-milestone', async (_event, milestoneData: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>) => {
    const validation = validateIPC(CreateMilestoneSchema, milestoneData, 'create-milestone');
    if (!validation.success) return validation;

    const milestoneRepo = getMilestoneRepository();
    const milestone = milestoneRepo.create(milestoneData);
    logger.info('[IPC] Milestone created', { milestoneId: milestone.id });
    return { success: true, milestone };
  }));

  ipcMain.handle('update-milestone', ipcResult('update-milestone', async (_event, { milestoneId, updates }: { milestoneId: string; updates: Partial<Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>> }) => {
    const idValidation = validateIPC(EntityIdSchema, milestoneId, 'update-milestone');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateMilestoneSchema, updates, 'update-milestone');
    if (!updatesValidation.success) return updatesValidation;

    const milestoneRepo = getMilestoneRepository();
    const milestone = milestoneRepo.update(idValidation.data, updatesValidation.data);
    if (!milestone) {
      return { success: false, error: 'Milestone not found' };
    }
    logger.info('[IPC] Milestone updated', { milestoneId: idValidation.data });
    return { success: true, milestone };
  }));

  ipcMain.handle('delete-milestone', ipcResult('delete-milestone', async (_event, milestoneId: string) => {
    const validation = validateIPC(EntityIdSchema, milestoneId, 'delete-milestone');
    if (!validation.success) return validation;

    const milestoneRepo = getMilestoneRepository();
    const success = milestoneRepo.delete(validation.data);
    if (success) {
      logger.info('[IPC] Milestone deleted', { milestoneId: validation.data });
    }
    return { success };
  }));

  // ============================================
  // Deadline Handlers
  // ============================================

  ipcMain.handle('get-deadlines', ipcResult('get-deadlines', async (_event, projectId?: string) => {
    if (projectId) {
      const validation = validateIPC(EntityIdSchema, projectId, 'get-deadlines');
      if (!validation.success) return validation;
    }

    const deadlineRepo = getDeadlineRepository();
    if (projectId) {
      return deadlineRepo.getByProjectId(projectId);
    }
    return deadlineRepo.getAll();
  }));

  ipcMain.handle('get-deadline', ipcResult('get-deadline', async (_event, deadlineId: string) => {
    const validation = validateIPC(EntityIdSchema, deadlineId, 'get-deadline');
    if (!validation.success) return validation;

    const deadlineRepo = getDeadlineRepository();
    return deadlineRepo.getById(validation.data);
  }));

  ipcMain.handle('create-deadline', ipcResult('create-deadline', async (_event, deadlineData: Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>) => {
    const validation = validateIPC(CreateDeadlineSchema, deadlineData, 'create-deadline');
    if (!validation.success) return validation;

    const deadlineRepo = getDeadlineRepository();
    const deadline = deadlineRepo.create(deadlineData);
    logger.info('[IPC] Deadline created', { deadlineId: deadline.id });
    return { success: true, deadline };
  }));

  ipcMain.handle('update-deadline', ipcResult('update-deadline', async (_event, { deadlineId, updates }: { deadlineId: string; updates: Partial<Omit<Deadline, 'id' | 'createdAt' | 'updatedAt'>> }) => {
    const idValidation = validateIPC(EntityIdSchema, deadlineId, 'update-deadline');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateDeadlineSchema, updates, 'update-deadline');
    if (!updatesValidation.success) return updatesValidation;

    const deadlineRepo = getDeadlineRepository();
    const deadline = deadlineRepo.update(idValidation.data, updatesValidation.data);
    if (!deadline) {
      return { success: false, error: 'Deadline not found' };
    }
    logger.info('[IPC] Deadline updated', { deadlineId: idValidation.data });
    return { success: true, deadline };
  }));

  ipcMain.handle('delete-deadline', ipcResult('delete-deadline', async (_event, deadlineId: string) => {
    const validation = validateIPC(EntityIdSchema, deadlineId, 'delete-deadline');
    if (!validation.success) return validation;

    const deadlineRepo = getDeadlineRepository();
    const success = deadlineRepo.delete(validation.data);
    if (success) {
      logger.info('[IPC] Deadline deleted', { deadlineId: validation.data });
    }
    return { success };
  }));
}
