import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsRepo, filesRepo, projectRepo } = vi.hoisted(() => ({
  settingsRepo: { getCurrentState: vi.fn() },
  filesRepo: { getByProjectId: vi.fn() },
  projectRepo: { getById: vi.fn() },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock('../repositories', () => ({
  getSettingsRepository: () => settingsRepo,
  getFileRepository: () => filesRepo,
  getProjectRepository: () => projectRepo,
  getRoutineRepository: () => ({}),
  getWorkflowRepository: () => ({}),
}));

import { runInProjectScope, scopedProjectId, bindProjectScope } from './projectScope';
import { deferTool, isDeferredTool } from './toolDeferral';
import { builtinTools } from './builtinTools';

describe('project scope', () => {
  it('is absent outside a scope', () => {
    expect(scopedProjectId()).toBeNull();
  });

  it('survives awaits inside the scope', async () => {
    const seen = await runInProjectScope('p-a', async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 1));
      return scopedProjectId();
    });
    expect(seen).toBe('p-a');
  });

  it('keeps overlapping turns apart', async () => {
    // The reason this is async-local rather than a module variable: several
    // channel dispatches and chat streams are routinely in flight at once.
    const slow = runInProjectScope('p-a', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return scopedProjectId();
    });
    const fast = runInProjectScope('p-b', async () => scopedProjectId());

    expect(await Promise.all([slow, fast])).toEqual(['p-a', 'p-b']);
  });
});

describe('bindProjectScope', () => {
  it('runs execute inside the scope without mutating the original tool', async () => {
    const original = { description: 'x', execute: async () => scopedProjectId() };
    const [bound] = Object.values(bindProjectScope({ t: original }, 'p-a')) as Array<{
      execute: () => Promise<string | null>;
    }>;

    expect(await bound.execute()).toBe('p-a');
    // The originals are module-level singletons; binding in place would
    // attribute every agent in the process to the last toolset built.
    expect(await original.execute()).toBeNull();
  });

  it('preserves approval gating and the deferred marker', () => {
    const tools = {
      gated: { needsApproval: true, execute: async () => 1 },
      deferred: deferTool({ description: 'd', execute: async () => 1 }),
      schemaOnly: { description: 'no execute' },
    };
    const bound = bindProjectScope(tools, 'p-a') as Record<string, Record<string, unknown>>;

    expect(bound.gated.needsApproval).toBe(true);
    expect(isDeferredTool(bound.deferred)).toBe(true);
    expect(bound.schemaOnly).toBe(tools.schemaOnly);
  });

  it('passes arguments through untouched', async () => {
    const spy = vi.fn(async (args: unknown) => args);
    const bound = bindProjectScope({ t: { execute: spy } }, 'p-a') as Record<
      string,
      { execute: (a: unknown, b: unknown) => Promise<unknown> }
    >;

    await bound.t.execute({ path: 'a.ts' }, { toolCallId: 'c1' });
    expect(spy).toHaveBeenCalledWith({ path: 'a.ts' }, { toolCallId: 'c1' });
  });
});

describe('built-in tools honour the turn project over the UI selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The UI is looking at a different project than the turn belongs to — a
    // channel in project A while the window shows project B, or any unattended
    // routine turn.
    settingsRepo.getCurrentState.mockReturnValue({ projectId: 'ui-project' });
    filesRepo.getByProjectId.mockImplementation((id: string) =>
      id === 'turn-project'
        ? [{ type: 'directory', name: 'turn', path: '/turn/dir', createdAt: 1 }]
        : [{ type: 'directory', name: 'ui', path: '/ui/dir', createdAt: 1 }],
    );
    projectRepo.getById.mockReturnValue(null);
  });

  it('reads files from the turn project, not the one on screen', async () => {
    const glob = builtinTools.glob as { execute: (a: unknown, b: unknown) => Promise<unknown> };

    await runInProjectScope('turn-project', () =>
      glob.execute({ pattern: '**/*.ts' }, {} as never),
    );

    expect(filesRepo.getByProjectId).toHaveBeenCalledWith('turn-project');
    expect(filesRepo.getByProjectId).not.toHaveBeenCalledWith('ui-project');
  });

  it('files tasks against the turn project', async () => {
    const createTask = vi.fn().mockReturnValue({ id: 't1', content: 'x', createdAt: 1 });
    projectRepo.getById.mockReturnValue({ id: 'turn-project', tasks: [], notes: [] });
    projectRepo.createTask = createTask;

    const addTask = builtinTools.add_task as {
      execute: (a: unknown, b: unknown) => Promise<unknown>;
    };
    await runInProjectScope('turn-project', () =>
      addTask.execute({ content: 'ship it' }, {} as never),
    );

    expect(projectRepo.getById).toHaveBeenCalledWith('turn-project');
    expect(createTask).toHaveBeenCalledWith('turn-project', { content: 'ship it' });
  });

  it('falls back to the UI selection outside a turn', async () => {
    const glob = builtinTools.glob as { execute: (a: unknown, b: unknown) => Promise<unknown> };
    await glob.execute({ pattern: '**/*.ts' }, {} as never);
    expect(filesRepo.getByProjectId).toHaveBeenCalledWith('ui-project');
  });
});
