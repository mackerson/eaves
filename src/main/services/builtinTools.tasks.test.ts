import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsRepo, projectRepo, emitEvent } = vi.hoisted(() => ({
  settingsRepo: { getCurrentState: vi.fn() },
  projectRepo: {
    getById: vi.fn(),
    createTask: vi.fn(),
    toggleTask: vi.fn(),
    deleteTask: vi.fn(),
    createNote: vi.fn(),
    deleteNote: vi.fn(),
  },
  emitEvent: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/eaves-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock('../repositories', () => ({
  getSettingsRepository: () => settingsRepo,
  getProjectRepository: () => projectRepo,
  getFileRepository: () => ({ getByProjectId: vi.fn(() => []) }),
  getRoutineRepository: () => ({}),
  getWorkflowRepository: () => ({}),
}));

import { assertValidGraph, builtinTools } from './builtinTools';

const exec = (name: keyof typeof builtinTools, input: unknown = {}) =>
  (builtinTools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {} as never);

describe('assertValidGraph', () => {
  it('accepts empty / valid graphs', () => {
    expect(() => assertValidGraph(undefined)).not.toThrow();
    expect(() => assertValidGraph({ nodes: [] })).not.toThrow();
    expect(() =>
      assertValidGraph({
        nodes: [{ id: 's', type: 'start', data: {} }, { id: 'e', type: 'end', data: {} }],
      }),
    ).not.toThrow();
  });

  it('rejects nodes missing required data with a corrective error', () => {
    expect(() =>
      assertValidGraph({
        nodes: [{ id: 'c1', type: 'code', data: {} }],
      }),
    ).toThrow(/Workflow not saved/);
  });
});

describe('builtinTools task CRUD', () => {
  const project = {
    id: 'p1',
    name: 'Alpha',
    tasks: [
      { id: 't1', content: 'done', completed: true, createdAt: 1_700_000_000_000 },
      { id: 't2', content: 'todo', completed: false, createdAt: 1_700_000_000_100 },
    ],
    notes: [
      { id: 'n1', content: 'alpha note', createdAt: 1_700_000_000_000 },
      { id: 'n2', content: 'beta memo', createdAt: 1_700_000_000_050 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    settingsRepo.getCurrentState.mockReturnValue({ projectId: 'p1' });
    projectRepo.getById.mockReturnValue(project);
  });

  it('list_tasks requires an active project', async () => {
    settingsRepo.getCurrentState.mockReturnValue({});
    await expect(exec('list_tasks', {})).rejects.toThrow(/No active project/);

    settingsRepo.getCurrentState.mockReturnValue({ projectId: 'missing' });
    projectRepo.getById.mockReturnValue(null);
    await expect(exec('list_tasks', {})).rejects.toThrow(/Project not found/);
  });

  it('list_tasks returns all tasks by default and can filter completed', async () => {
    const all = (await exec('list_tasks', {})) as {
      projectName: string;
      taskCount: number;
      tasks: Array<{ id: string; index: number }>;
    };
    expect(all.projectName).toBe('Alpha');
    expect(all.taskCount).toBe(2);
    expect(all.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(all.tasks[0].index).toBe(1);

    const open = (await exec('list_tasks', { includeCompleted: false })) as {
      taskCount: number;
      tasks: Array<{ id: string }>;
    };
    expect(open.taskCount).toBe(1);
    expect(open.tasks[0].id).toBe('t2');
  });

  it('add_task creates via repo and emits task:created', async () => {
    const created = {
      id: 't3',
      content: 'ship it',
      completed: false,
      createdAt: 1_700_000_000_200,
    };
    projectRepo.createTask.mockReturnValue(created);

    const result = (await exec('add_task', { content: 'ship it' })) as {
      success: boolean;
      task: { id: string; content: string };
    };
    expect(result).toMatchObject({ success: true, task: { id: 't3', content: 'ship it' } });
    expect(projectRepo.createTask).toHaveBeenCalledWith('p1', { content: 'ship it' });
    expect(emitEvent).toHaveBeenCalledWith('task:created', { taskId: 't3', projectId: 'p1' });
  });

  it('toggle_task flips status and throws when missing', async () => {
    projectRepo.toggleTask.mockReturnValueOnce({
      id: 't2',
      content: 'todo',
      completed: true,
    });
    const result = (await exec('toggle_task', { taskId: 't2' })) as {
      success: boolean;
      task: { completed: boolean };
    };
    expect(result.success).toBe(true);
    expect(result.task.completed).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith('task:toggled', { taskId: 't2' });

    projectRepo.toggleTask.mockReturnValueOnce(null);
    await expect(exec('toggle_task', { taskId: 'nope' })).rejects.toThrow(/not found/);
  });

  it('delete_task succeeds or lists available tasks on miss', async () => {
    projectRepo.deleteTask.mockReturnValueOnce(true);
    expect(await exec('delete_task', { taskId: 't1' })).toEqual({ success: true });
    expect(emitEvent).toHaveBeenCalledWith('task:deleted', { taskId: 't1' });

    projectRepo.deleteTask.mockReturnValueOnce(false);
    await expect(exec('delete_task', { taskId: 'missing' })).rejects.toThrow(/Available tasks/);
  });

  it('list_notes filters by searchQuery', async () => {
    const all = (await exec('list_notes', {})) as { noteCount: number };
    expect(all.noteCount).toBe(2);
    const filtered = (await exec('list_notes', { searchQuery: 'BETA' })) as {
      notes: Array<{ id: string }>;
    };
    expect(filtered.notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('add_note / delete_note create, emit, and report available notes on miss', async () => {
    projectRepo.createNote.mockReturnValue({
      id: 'n3',
      content: 'new',
      createdAt: 1_700_000_000_300,
    });
    const created = (await exec('add_note', { content: 'new' })) as { success: boolean; note: { id: string } };
    expect(created.success).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith('note:created', { noteId: 'n3', projectId: 'p1' });

    projectRepo.deleteNote.mockReturnValueOnce(true);
    expect(await exec('delete_note', { noteId: 'n1' })).toEqual({ success: true });

    projectRepo.deleteNote.mockReturnValueOnce(false);
    await expect(exec('delete_note', { noteId: 'nope' })).rejects.toThrow(/Available notes/);
  });
});
