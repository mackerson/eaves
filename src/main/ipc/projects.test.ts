import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerProjectHandlers } from './projects';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../repositories', () => ({
  getProjectRepository: vi.fn(),
  getSettingsRepository: vi.fn(),
}));

import { getProjectRepository, getSettingsRepository } from '../repositories';

describe('Project IPC Handlers', () => {
  let mockProjectRepo: { create: Mock; update: Mock; delete: Mock; getById: Mock };
  let mockSettingsRepo: { setCurrentProject: Mock };
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectRepo = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
      getLabelsByProjectId: vi.fn(() => []),
    };
    mockSettingsRepo = { setCurrentProject: vi.fn() };

    (getProjectRepository as Mock).mockReturnValue(mockProjectRepo);
    (getSettingsRepository as Mock).mockReturnValue(mockSettingsRepo);

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerProjectHandlers();
  });

  afterEach(() => vi.clearAllMocks());

  describe('create-project', () => {
    it('should create project with valid data', async () => {
      const handler = handlers.get('create-project')!;
      const mockProject = { id: 'proj-1', name: 'Test', description: 'Desc', createdAt: Date.now() };
      mockProjectRepo.create.mockReturnValue(mockProject);

      const result = await handler({}, { name: 'Test', description: 'Desc' });

      expect(result).toEqual(mockProject);
      expect(mockProjectRepo.create).toHaveBeenCalledWith({ name: 'Test', description: 'Desc' });
      expect(mockSettingsRepo.setCurrentProject).toHaveBeenCalledWith('proj-1');
    });

    it('should reject empty name', async () => {
      const handler = handlers.get('create-project')!;
      const result = await handler({}, { name: '', description: 'Desc' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockProjectRepo.create).not.toHaveBeenCalled();
    });

    it('should default description to empty string when missing', async () => {
      const handler = handlers.get('create-project')!;
      const mockProject = { id: 'proj-1', name: 'Test', description: '', createdAt: Date.now() };
      mockProjectRepo.create.mockReturnValue(mockProject);

      const result = await handler({}, { name: 'Test' });

      expect(result).toEqual(mockProject);
      expect(mockProjectRepo.create).toHaveBeenCalledWith({ name: 'Test', description: '' });
    });
  });

  describe('update-project', () => {
    it('should update project with valid data', async () => {
      const handler = handlers.get('update-project')!;
      const mockUpdated = { id: 'proj-1', name: 'Updated', description: 'New', createdAt: Date.now() };
      mockProjectRepo.update.mockReturnValue(mockUpdated);

      const result = await handler({}, { projectId: 'proj-1', updates: { name: 'Updated' } });

      expect(result).toEqual(mockUpdated);
      expect(mockProjectRepo.update).toHaveBeenCalledWith('proj-1', { name: 'Updated' });
    });

    it('should reject empty project ID', async () => {
      const handler = handlers.get('update-project')!;
      const result = await handler({}, { projectId: '', updates: { name: 'Updated' } });

      expect(result.success).toBe(false);
      expect(mockProjectRepo.update).not.toHaveBeenCalled();
    });

    it('should reject invalid update fields', async () => {
      const handler = handlers.get('update-project')!;
      const result = await handler({}, { projectId: 'proj-1', updates: { name: '' } });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('switch-project', () => {
    /**
     * The handler returns the switched-to project's rows. The renderer used to
     * rehydrate from its boot-time getMemory snapshot, which no
     * renderer-initiated write ever updates — so notes and tasks created that
     * session vanished on every switch. getById already hydrates all of this
     * to validate the id; it was just being thrown away.
     */
    it('should switch to existing project and return its data', async () => {
      const handler = handlers.get('switch-project')!;
      const tasks = [{ id: 't1' }];
      const notes = [{ id: 'n1' }];
      const events = [{ id: 'e1' }];
      mockProjectRepo.getById.mockReturnValue({ id: 'proj-1', name: 'Test', tasks, notes, events });
      mockProjectRepo.getLabelsByProjectId.mockReturnValue([{ id: 'l1' }]);

      const result = await handler({}, 'proj-1');

      expect(result).toEqual({ success: true, tasks, notes, events, labels: [{ id: 'l1' }] });
      expect(mockSettingsRepo.setCurrentProject).toHaveBeenCalledWith('proj-1');
    });

    // Labels are stored per project but the renderer keeps one global bucket,
    // so they have to travel with the switch or A's chips stay on screen in B.
    it('should scope the returned labels to the switched-to project', async () => {
      const handler = handlers.get('switch-project')!;
      mockProjectRepo.getById.mockReturnValue({ id: 'proj-2', tasks: [], notes: [], events: [] });

      await handler({}, 'proj-2');

      expect(mockProjectRepo.getLabelsByProjectId).toHaveBeenCalledWith('proj-2');
    });

    it('should return failure for non-existent project', async () => {
      const handler = handlers.get('switch-project')!;
      mockProjectRepo.getById.mockReturnValue(null);

      const result = await handler({}, 'non-existent');

      expect(result.success).toBe(false);
      expect(mockSettingsRepo.setCurrentProject).not.toHaveBeenCalled();
    });

    it('should reject empty project ID', async () => {
      const handler = handlers.get('switch-project')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('delete-project', () => {
    it('should delete project with valid ID', async () => {
      const handler = handlers.get('delete-project')!;
      mockProjectRepo.delete.mockReturnValue(true);

      const result = await handler({}, 'proj-1');

      expect(result).toEqual({ success: true });
      expect(mockProjectRepo.delete).toHaveBeenCalledWith('proj-1');
    });

    it('should reject empty project ID', async () => {
      const handler = handlers.get('delete-project')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockProjectRepo.delete).not.toHaveBeenCalled();
    });

    it('should handle repository error gracefully', async () => {
      const handler = handlers.get('delete-project')!;
      mockProjectRepo.delete.mockImplementation(() => { throw new Error('DB error'); });

      const result = await handler({}, 'proj-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });
});
