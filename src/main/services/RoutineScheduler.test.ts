import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Routine, Workflow } from '../../shared/types';
import type { WorkflowExecutionResult } from './WorkflowExecutor';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const emitEvent = vi.fn();
vi.mock('./EventBus', () => ({
  eventBus: { emitEvent: (...args: unknown[]) => emitEvent(...args) },
}));

// Hoisted so both the vi.mock factories below and the test bodies can share
// the same fns — vi.mock is hoisted above imports, so anything it closes over
// must be too.
const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getWorkflowById: vi.fn(),
  updateRunTimes: vi.fn(),
  recordRun: vi.fn(),
  getDueRoutines: vi.fn(),
  settingsGet: vi.fn(),
  settingsUpdate: vi.fn(),
  executeWorkflow: vi.fn(),
}));

vi.mock('../repositories', () => ({
  getRoutineRepository: () => ({
    getById: mocks.getById,
    updateRunTimes: mocks.updateRunTimes,
    recordRun: mocks.recordRun,
    getDueRoutines: mocks.getDueRoutines,
  }),
  getWorkflowRepository: () => ({
    getById: mocks.getWorkflowById,
  }),
  getSettingsRepository: () => ({
    get: mocks.settingsGet,
    update: mocks.settingsUpdate,
  }),
}));

vi.mock('./WorkflowExecutor', () => ({
  getWorkflowExecutor: () => ({
    executeWorkflow: mocks.executeWorkflow,
  }),
}));

import { RoutineScheduler } from './RoutineScheduler';

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    projectId: 'proj-1',
    name: 'Test Routine',
    workflowId: 'wf-1',
    cronSchedule: '*/1 * * * *',
    enabled: true,
    pinned: false,
    consecutiveFailures: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    projectId: 'proj-1',
    name: 'Test Workflow',
    dagDefinition: { nodes: [], edges: [] },
    enabled: true,
    pinned: false,
    reviewStatus: 'approved',
    createdBy: 'user',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeExecutionResult(overrides: Partial<WorkflowExecutionResult> = {}): WorkflowExecutionResult {
  return {
    success: true,
    executionId: 'exec-1',
    workflowId: 'wf-1',
    startTime: 0,
    endTime: 0,
    duration: 0,
    outputs: {},
    nodeResults: {},
    ...overrides,
  };
}

// --- Cron day-of-week: parsing and matching -------------------------------
//
// These call the exported static wrapper directly — no repository/executor
// mocking needed, since CronParser.getNextRunTime is a pure function of the
// cron string and a starting instant.

describe('RoutineScheduler cron day-of-week', () => {
  it('does NOT fire on a Tuesday for a Monday-only schedule (regression: DOW used to be ignored)', () => {
    // Tue Aug 11 2026, 08:00 — one hour before the naive (DOW-ignoring) match
    // at 09:00 the same day.
    const tuesdayMorning = new Date(2026, 7, 11, 8, 0, 0).getTime();

    const next = RoutineScheduler.calculateNextRun('0 9 * * 1', tuesdayMorning);

    // Mon Aug 17 2026, 09:00 — the next actual Monday, not "later today".
    const nextMonday9am = new Date(2026, 7, 17, 9, 0, 0).getTime();
    expect(next).toBe(nextMonday9am);
  });

  it('fires on Monday for a Monday-only schedule', () => {
    const mondayMorning = new Date(2026, 7, 10, 8, 0, 0).getTime(); // Mon Aug 10 2026
    const next = RoutineScheduler.calculateNextRun('0 9 * * 1', mondayMorning);
    expect(next).toBe(new Date(2026, 7, 10, 9, 0, 0).getTime());
  });

  it('accepts 7 as Sunday, same as 0', () => {
    const saturday = new Date(2026, 7, 15, 8, 0, 0).getTime(); // Sat Aug 15 2026
    const viaZero = RoutineScheduler.calculateNextRun('0 9 * * 0', saturday);
    const viaSeven = RoutineScheduler.calculateNextRun('0 9 * * 7', saturday);
    expect(viaSeven).toBe(viaZero);
    expect(viaSeven).toBe(new Date(2026, 7, 16, 9, 0, 0).getTime()); // Sun Aug 16 2026
  });

  it('ORs day-of-month with day-of-week when both are restricted (cron standard)', () => {
    // "0 0 1 * 1" = midnight on the 1st OR any Monday — not AND.
    // From Tue Aug 11 2026, the next Monday (Aug 17) comes before the next
    // 1st-of-month (Sep 1), so an OR match lands on Aug 17, not Sep 1.
    const tuesday = new Date(2026, 7, 11, 8, 0, 0).getTime();
    const next = RoutineScheduler.calculateNextRun('0 0 1 * 1', tuesday);
    expect(next).toBe(new Date(2026, 7, 17, 0, 0, 0).getTime());
  });

  it('still matches on day-of-month alone when day-of-week is "*" (AND with the unrestricted field)', () => {
    // "0 0 1 * *" should only match the 1st of the month, never a Monday that
    // isn't also the 1st — proves day-of-week left at '*' does not leak into
    // an OR.
    const mondayNotFirst = new Date(2026, 7, 10, 8, 0, 0).getTime(); // Mon Aug 10 2026
    const next = RoutineScheduler.calculateNextRun('0 0 1 * *', mondayNotFirst);
    expect(next).toBe(new Date(2026, 8, 1, 0, 0, 0).getTime()); // Sep 1 2026, not Aug 10/17
  });
});

// --- In-flight guard and completion-based rescheduling ---------------------

describe('RoutineScheduler in-flight guard', () => {
  let scheduler: RoutineScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduler = new RoutineScheduler();
    mocks.getById.mockReturnValue(makeRoutine());
    mocks.getWorkflowById.mockReturnValue(makeWorkflow());
    mocks.settingsGet.mockReturnValue({ routinesPaused: false });
  });

  it('skips a routine whose previous run has not finished yet', async () => {
    let resolveExec!: (result: WorkflowExecutionResult) => void;
    mocks.executeWorkflow.mockReturnValueOnce(
      new Promise<WorkflowExecutionResult>(resolve => {
        resolveExec = resolve;
      })
    );

    const firstCall = scheduler.executeRoutine('routine-1');
    // Let the first call reach and await executor.executeWorkflow().
    await Promise.resolve();
    await Promise.resolve();

    const second = await scheduler.executeRoutine('routine-1');
    expect(second).toEqual({ status: 'skipped', error: 'Previous run still in progress' });
    expect(mocks.executeWorkflow).toHaveBeenCalledTimes(1);

    resolveExec(makeExecutionResult());
    const first = await firstCall;
    expect(first.status).toBe('success');
  });

  it('releases the guard once the in-flight run finishes', async () => {
    mocks.executeWorkflow.mockResolvedValueOnce(makeExecutionResult());
    await scheduler.executeRoutine('routine-1');

    mocks.executeWorkflow.mockResolvedValueOnce(makeExecutionResult());
    const second = await scheduler.executeRoutine('routine-1');
    expect(second.status).toBe('success');
    expect(mocks.executeWorkflow).toHaveBeenCalledTimes(2);
  });

  it('releases the guard when the run throws, so it is not wedged in-flight forever', async () => {
    mocks.executeWorkflow.mockRejectedValueOnce(new Error('boom'));
    await expect(scheduler.executeRoutine('routine-1')).rejects.toThrow('boom');

    mocks.executeWorkflow.mockResolvedValueOnce(makeExecutionResult());
    const result = await scheduler.executeRoutine('routine-1');
    expect(result.status).toBe('success');
    expect(mocks.executeWorkflow).toHaveBeenCalledTimes(2);
  });

  it('two ticks racing the same due routine only run the workflow once', async () => {
    let resolveExec!: (result: WorkflowExecutionResult) => void;
    mocks.executeWorkflow.mockReturnValueOnce(
      new Promise<WorkflowExecutionResult>(resolve => {
        resolveExec = resolve;
      })
    );

    // Mirrors checkAndExecuteDueRoutines: fire-and-forget, no await between
    // dispatches within the same tick (or two overlapping ticks).
    const outcomes = [scheduler.executeRoutine('routine-1'), scheduler.executeRoutine('routine-1')];

    resolveExec(makeExecutionResult());
    const results = await Promise.all(outcomes);

    expect(mocks.executeWorkflow).toHaveBeenCalledTimes(1);
    expect(results.filter(r => r.status === 'success')).toHaveLength(1);
    expect(results.filter(r => r.status === 'skipped')).toHaveLength(1);
  });
});

describe('RoutineScheduler next-run scheduling', () => {
  let scheduler: RoutineScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduler = new RoutineScheduler();
    mocks.getById.mockReturnValue(makeRoutine({ cronSchedule: '*/1 * * * *' }));
    mocks.getWorkflowById.mockReturnValue(makeWorkflow());
    mocks.settingsGet.mockReturnValue({ routinesPaused: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes next_run from completion time, not the time the run started', async () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 10, 9, 0, 0).getTime();
    vi.setSystemTime(start);

    const runDurationMs = 5 * 60 * 1000; // outlasts the every-minute schedule
    mocks.executeWorkflow.mockImplementation(async () => {
      vi.advanceTimersByTime(runDurationMs);
      return makeExecutionResult();
    });

    await scheduler.executeRoutine('routine-1');

    expect(mocks.recordRun).toHaveBeenCalledTimes(1);
    const [, , nextRun] = mocks.recordRun.mock.calls[0];
    const completionTime = start + runDurationMs;

    // Strictly after completion — the bug computed this from `start`, which
    // for a run this long is already in the past by the time it's written.
    expect(nextRun).toBeGreaterThan(completionTime);
    // And specifically not the stale start-based value the old code produced.
    expect(nextRun).not.toBe(start + 60000);
  });
});
