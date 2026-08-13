import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerWorkflowHandlers } from './workflows';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../repositories', () => ({
  getWorkflowRepository: vi.fn(),
}));

vi.mock('../services/WorkflowExecutor', () => ({
  getWorkflowExecutor: vi.fn(),
}));

import { getWorkflowRepository } from '../repositories';
import { getWorkflowExecutor } from '../services/WorkflowExecutor';

describe('Workflow IPC Handlers', () => {
  let mockWorkflowsRepo: {
    getByProjectId: Mock;
    getById: Mock;
    create: Mock;
    update: Mock;
    delete: Mock;
  };
  let mockExecutor: { executeWorkflow: Mock };
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorkflowsRepo = {
      getByProjectId: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    mockExecutor = { executeWorkflow: vi.fn() };

    (getWorkflowRepository as Mock).mockReturnValue(mockWorkflowsRepo);
    (getWorkflowExecutor as Mock).mockReturnValue(mockExecutor);

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerWorkflowHandlers();
  });

  afterEach(() => vi.clearAllMocks());

  // `workflow:http-request` was a dead handler — its SSRF guard (protocol
  // allow-list, private/internal address block), method allow-list, and 30s
  // timeout validated a URL nothing called. The only reachable http path is
  // WorkflowExecutor.executeHttpNode, which now carries this same guard;
  // that file's test suite (WorkflowExecutor.test.ts) is the new home for
  // this coverage.

  describe('workflows:list', () => {
    it('should list workflows for a project', async () => {
      const handler = handlers.get('workflows:list')!;
      const mockWorkflows = [{ id: 'wf-1', name: 'Test Workflow' }];
      mockWorkflowsRepo.getByProjectId.mockReturnValue(mockWorkflows);

      const result = await handler({}, 'proj-1');

      expect(result).toEqual(mockWorkflows);
      expect(mockWorkflowsRepo.getByProjectId).toHaveBeenCalledWith('proj-1');
    });

    it('should reject empty project ID', async () => {
      const handler = handlers.get('workflows:list')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('workflows:get', () => {
    it('should get workflow by ID', async () => {
      const handler = handlers.get('workflows:get')!;
      const mockWorkflow = { id: 'wf-1', name: 'Test' };
      mockWorkflowsRepo.getById.mockReturnValue(mockWorkflow);

      const result = await handler({}, 'wf-1');

      expect(result).toEqual(mockWorkflow);
    });

    it('should reject empty workflow ID', async () => {
      const handler = handlers.get('workflows:get')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
    });
  });

  describe('workflows:create', () => {
    it('should create workflow with valid data', async () => {
      const handler = handlers.get('workflows:create')!;
      const mockWorkflow = { id: 'wf-1', name: 'New Workflow', projectId: 'proj-1' };
      mockWorkflowsRepo.create.mockReturnValue(mockWorkflow);

      const result = await handler({}, {
        name: 'New Workflow',
        projectId: 'proj-1',
        dagDefinition: { nodes: [], edges: [] },
      });

      expect(result).toEqual(mockWorkflow);
    });

    it('should reject workflow with empty name', async () => {
      const handler = handlers.get('workflows:create')!;
      const result = await handler({}, {
        name: '',
        projectId: 'proj-1',
        dagDefinition: { nodes: [], edges: [] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('workflows:update', () => {
    it('should update workflow with valid data', async () => {
      const handler = handlers.get('workflows:update')!;
      const mockUpdated = { id: 'wf-1', name: 'Updated' };
      mockWorkflowsRepo.update.mockReturnValue(mockUpdated);

      const result = await handler({}, { workflowId: 'wf-1', data: { name: 'Updated' } });

      expect(result).toEqual(mockUpdated);
      expect(mockWorkflowsRepo.update).toHaveBeenCalledWith('wf-1', { name: 'Updated' });
    });

    it('should reject empty workflow ID', async () => {
      const handler = handlers.get('workflows:update')!;
      const result = await handler({}, { workflowId: '', data: { name: 'Updated' } });

      expect(result.success).toBe(false);
    });
  });

  describe('workflows:delete', () => {
    it('should delete workflow with valid ID', async () => {
      const handler = handlers.get('workflows:delete')!;
      mockWorkflowsRepo.delete.mockReturnValue(true);

      const result = await handler({}, 'wf-1');

      expect(result).toBe(true);
      expect(mockWorkflowsRepo.delete).toHaveBeenCalledWith('wf-1');
    });

    it('should reject empty workflow ID', async () => {
      const handler = handlers.get('workflows:delete')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
    });
  });

  describe('workflows:execute', () => {
    it('should execute workflow with valid ID', async () => {
      const handler = handlers.get('workflows:execute')!;
      const mockWorkflow = { id: 'wf-1', name: 'Test', nodes: [], edges: [] };
      const mockResult = { success: true, outputs: {} };
      mockWorkflowsRepo.getById.mockReturnValue(mockWorkflow);
      mockExecutor.executeWorkflow.mockResolvedValue(mockResult);

      const result = await handler({}, { workflowId: 'wf-1', variables: { key: 'value' } });

      expect(result).toEqual(mockResult);
      expect(mockExecutor.executeWorkflow).toHaveBeenCalledWith(mockWorkflow, { key: 'value' });
    });

    it('should return error when workflow not found', async () => {
      const handler = handlers.get('workflows:execute')!;
      mockWorkflowsRepo.getById.mockReturnValue(null);

      const result = await handler({}, { workflowId: 'non-existent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Workflow not found');
    });

    it('should reject empty workflow ID', async () => {
      const handler = handlers.get('workflows:execute')!;
      const result = await handler({}, { workflowId: '' });

      expect(result.success).toBe(false);
    });
  });
});
