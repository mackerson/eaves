import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workflow } from '../types';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// EventBus is the gate's side-effect surface; capture calls without touching
// the real singleton.
const emitEvent = vi.fn();
vi.mock('./EventBus', () => ({
  eventBus: { emitEvent: (...args: unknown[]) => emitEvent(...args) },
}));

// Stub the other WorkflowExecutor collaborators — the gate tests should not
// reach CodeExecutor, agent loading, or AI streaming. If the gate ever
// fails-open, these would blow up with undefined calls, which is itself a
// useful safety net.
vi.mock('./CodeExecutor', () => ({
  getCodeExecutor: () => ({
    execute: vi.fn().mockRejectedValue(new Error('CodeExecutor should not run for a blocked workflow')),
  }),
}));
vi.mock('./ai', () => ({
  streamAIResponse: vi.fn().mockImplementation(async function* () {
    throw new Error('streamAIResponse should not run for a blocked workflow');
  }),
}));
vi.mock('./appStateLoader', () => ({
  loadAppState: vi.fn().mockReturnValue({}),
}));
vi.mock('../repositories', () => ({
  getAgentRepository: vi.fn(),
  getSettingsRepository: vi.fn(),
}));

import { WorkflowExecutor } from './WorkflowExecutor';
import { logger } from './logger';
import { streamAIResponse } from './ai';
import { getAgentRepository, getSettingsRepository } from '../repositories';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-test',
    projectId: 'proj-1',
    name: 'Test workflow',
    enabled: true,
    dagDefinition: {
      nodes: [
        { id: 'n1', type: 'code', position: { x: 0, y: 0 }, data: { code: 'console.log(1)' } },
      ],
      edges: [],
    },
    reviewStatus: 'approved',
    createdBy: 'user',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('WorkflowExecutor review gate', () => {
  beforeEach(() => {
    emitEvent.mockClear();
  });

  it('blocks workflows with reviewStatus=pending without executing any node', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(makeWorkflow({ reviewStatus: 'pending' }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pending human review/);
    expect(emitEvent).toHaveBeenCalledWith(
      'workflow:blocked:pending-review',
      expect.objectContaining({ workflowId: 'wf-test', projectId: 'proj-1' }),
    );
    // The workflow started/completed events must NOT fire for a blocked run.
    expect(emitEvent).not.toHaveBeenCalledWith('workflow:execution:started', expect.anything());
    expect(emitEvent).not.toHaveBeenCalledWith('workflow:execution:completed', expect.anything());
  });

  it('fails closed: unknown reviewStatus values are treated as blocked', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(
      makeWorkflow({ reviewStatus: 'bogus' as Workflow['reviewStatus'] }),
    );

    expect(result.success).toBe(false);
    expect(emitEvent).toHaveBeenCalledWith(
      'workflow:blocked:pending-review',
      expect.any(Object),
    );
  });

  it('fails closed: undefined reviewStatus is treated as blocked', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(
      makeWorkflow({ reviewStatus: undefined as unknown as Workflow['reviewStatus'] }),
    );

    expect(result.success).toBe(false);
    expect(emitEvent).toHaveBeenCalledWith(
      'workflow:blocked:pending-review',
      expect.any(Object),
    );
  });
});

// Observability: the executor accumulated a per-node record and then dropped
// it, so every caller could say only "it worked" or "it didn't". An agent
// could trigger a routine and had no way to see what it produced.
describe('WorkflowExecutor node results', () => {
  beforeEach(() => emitEvent.mockClear());

  it('returns what each node produced on a successful run', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(makeWorkflow({
      dagDefinition: {
        nodes: [
          { id: 'n1', type: 'delay', position: { x: 0, y: 0 }, data: { duration: 1 } },
        ],
        edges: [],
      },
    }));

    expect(result.success).toBe(true);
    expect(Object.keys(result.nodeResults)).toEqual(['n1']);
    expect(result.nodeResults.n1).toMatchObject({ nodeId: 'n1', success: true });
    expect(typeof result.nodeResults.n1.duration).toBe('number');
  });

  it('reports how far a failing run got, and which node stopped it', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(makeWorkflow({
      dagDefinition: {
        nodes: [
          { id: 'ok', type: 'delay', position: { x: 0, y: 0 }, data: { duration: 1 } },
          { id: 'boom', type: 'http', position: { x: 1, y: 0 }, data: {} },
        ],
        edges: [{ id: 'e1', source: 'ok', target: 'boom' }],
      },
    }));

    expect(result.success).toBe(false);
    // The node that ran before the failure is still reported — that is the
    // point of returning partial results.
    expect(result.nodeResults.ok).toMatchObject({ success: true });
  });

  it('reports no node results for a workflow blocked before it ran', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(makeWorkflow({ reviewStatus: 'pending' }));
    expect(result.nodeResults).toEqual({});
  });
});

// A conditional whose branches rejoin (start -> cond -> {A, B} -> join -> end)
// left `join` waiting on a parent (A, the untaken branch) that never
// executes. executeNodes re-queued it forever with no await on the continue
// path, busy-looping the Node event loop for the full maxExecutionTime.
describe('WorkflowExecutor node scheduling — conditional rejoin', () => {
  beforeEach(() => emitEvent.mockClear());

  it('forces the join through instead of spinning, and never runs the untaken branch', async () => {
    const executor = new WorkflowExecutor();
    const workflow = makeWorkflow({
      safetyConfig: { maxExecutionTime: 300 },
      dagDefinition: {
        nodes: [
          { id: 'start-n', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'cond', type: 'conditional', position: { x: 0, y: 0 }, data: { condition: 'no', operator: 'equals', value: 'yes' } },
          { id: 'A', type: 'delay', position: { x: 0, y: 0 }, data: { duration: 0.001, unit: 'seconds' } },
          { id: 'B', type: 'delay', position: { x: 0, y: 0 }, data: { duration: 0.001, unit: 'seconds' } },
          { id: 'join', type: 'action', position: { x: 0, y: 0 }, data: {} },
          { id: 'end-n', type: 'end', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          { id: 'e1', source: 'start-n', target: 'cond' },
          { id: 'e2', source: 'cond', sourceHandle: 'true', target: 'A' },
          { id: 'e3', source: 'cond', sourceHandle: 'false', target: 'B' },
          { id: 'e4', source: 'A', target: 'join' },
          { id: 'e5', source: 'B', target: 'join' },
          { id: 'e6', source: 'join', target: 'end-n' },
        ],
      },
    });

    const startedAt = Date.now();
    const result = await executor.executeWorkflow(workflow);
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(true);
    expect(result.nodeResults.join).toMatchObject({ success: true });
    expect(result.nodeResults['end-n']).toMatchObject({ success: true });
    // 'A' sits on the branch that was never taken — it must never run, even
    // though the fix forces `join` past its missing-parent gate.
    expect(result.nodeResults.A).toBeUndefined();
    // Before the fix, this graph timed out (failed) after burning the full
    // 300ms synchronously. The fix resolves in a handful of event-loop ticks.
    expect(elapsed).toBeLessThan(250);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stalled'),
      expect.objectContaining({ nodeIds: ['join'] }),
    );
  });
});

// The executor is a process-wide singleton (getWorkflowExecutor). Before the
// fix, `this.currentWorkflow` was mutable per-run state on that singleton:
// two runs firing without an await between them (as RoutineScheduler's
// unawaited dispatch does) could have run B overwrite the field while A was
// mid-flight, so A's executeLoopNode looked up its loop body in B's graph.
describe('WorkflowExecutor concurrent runs on the shared singleton', () => {
  beforeEach(() => emitEvent.mockClear());

  it('does not let one run resolve its loop body against a different run\'s graph', async () => {
    const executor = new WorkflowExecutor();

    const workflowA = makeWorkflow({
      id: 'wf-a',
      dagDefinition: {
        nodes: [
          // The delay yields the event loop before A reaches its loop node,
          // giving B a chance to run (and, pre-fix, to overwrite
          // `this.currentWorkflow`) in between.
          { id: 'delayA', type: 'delay', position: { x: 0, y: 0 }, data: { duration: 0.02, unit: 'seconds' } },
          { id: 'loopA', type: 'loop', position: { x: 0, y: 0 }, data: { collection: ['x'], variable: 'item' } },
          { id: 'bodyA', type: 'action', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          { id: 'ea1', source: 'delayA', target: 'loopA' },
          { id: 'ea2', source: 'loopA', sourceHandle: 'body', target: 'bodyA' },
        ],
      },
    });

    const workflowB = makeWorkflow({
      id: 'wf-b',
      dagDefinition: {
        nodes: [
          { id: 'loopB', type: 'loop', position: { x: 0, y: 0 }, data: { collection: ['y'], variable: 'item' } },
          { id: 'bodyB', type: 'action', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          { id: 'eb1', source: 'loopB', sourceHandle: 'body', target: 'bodyB' },
        ],
      },
    });

    const [resultA, resultB] = await Promise.all([
      executor.executeWorkflow(workflowA),
      executor.executeWorkflow(workflowB),
    ]);

    expect(resultB.success).toBe(true);
    const loopBOutput = resultB.nodeResults.loopB.output as { iterations: number; results: Record<string, unknown>[] };
    expect(loopBOutput.iterations).toBe(1);
    expect(loopBOutput.results[0]).toHaveProperty('bodyB');

    expect(resultA.success).toBe(true);
    // Pre-fix, A's identifyLoopBody read `this.currentWorkflow`, which B (no
    // delay, so it finishes first) had already overwritten and nothing ever
    // reset — A would find no matching loop node in B's graph and
    // identifyLoopBody would return an empty subgraph. `iterations` would
    // still read 1 (the loop still counts a pass per item), but `results[0]`
    // would be `{}` — a real body that silently never ran, under a
    // `success: true` result.
    const loopAOutput = resultA.nodeResults.loopA.output as { iterations: number; results: Record<string, unknown>[] };
    expect(loopAOutput.iterations).toBe(1);
    expect(loopAOutput.results[0]).toHaveProperty('bodyA');
  });
});

// executeNode's default arm used to return `{success: true, skipped: true}`
// for any node type it didn't recognize — including 'transformNode', which
// the visual editor's demo template gives a real `script` that never ran.
describe('WorkflowExecutor node types', () => {
  beforeEach(() => emitEvent.mockClear());

  it('runs input/output as no-op start/end markers, matching the visual editor', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(makeWorkflow({
      dagDefinition: {
        nodes: [
          { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: {} },
          { id: 'out', type: 'output', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [{ id: 'e1', source: 'in', target: 'out' }],
      },
    }));

    expect(result.success).toBe(true);
    expect(result.nodeResults.in).toMatchObject({ success: true });
    expect(result.nodeResults.out).toMatchObject({ success: true });
  });

  it('fails closed on a node type it has no handler for, instead of reporting success', async () => {
    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(makeWorkflow({
      dagDefinition: {
        nodes: [
          { id: 'transform', type: 'transformNode', position: { x: 0, y: 0 }, data: { script: 'return 1', language: 'javascript' } },
        ],
        edges: [],
      },
    }));

    expect(result.success).toBe(false);
    expect(result.nodeResults.transform).toMatchObject({ success: false });
    expect(result.nodeResults.transform.error).toMatch(/Unknown node type/);
  });
});

// This is the new home for the SSRF/method/timeout coverage that used to
// live in ipc/workflows.test.ts against the `workflow:http-request` handler
// — a handler nothing ever called. executeHttpNode is the reachable path.
describe('WorkflowExecutor http node SSRF guard', () => {
  beforeEach(() => emitEvent.mockClear());

  async function runHttp(data: Record<string, unknown>) {
    const executor = new WorkflowExecutor();
    return executor.executeWorkflow(makeWorkflow({
      dagDefinition: {
        nodes: [{ id: 'n1', type: 'http', position: { x: 0, y: 0 }, data }],
        edges: [],
      },
    }));
  }

  it('makes the request when the URL and method are valid', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {
        get: (key: string) => (key === 'content-type' ? 'application/json' : null),
        entries: () => [['content-type', 'application/json']],
      },
      json: async () => ({ data: 'test' }),
    });

    const result = await runHttp({ url: 'https://api.example.com/data', method: 'GET' });

    expect(result.success).toBe(true);
    expect((result.nodeResults.n1.output as { data: unknown }).data).toEqual({ data: 'test' });
    expect(global.fetch).toHaveBeenCalledWith('https://api.example.com/data', expect.objectContaining({ method: 'GET' }));
  });

  it.each([
    ['http://127.0.0.1/internal', 'private/internal'],
    ['http://localhost:3000/api', 'private/internal'],
    ['http://10.0.0.1/api', 'private/internal'],
    ['http://192.168.1.1/api', 'private/internal'],
    ['http://169.254.169.254/latest/meta-data', 'private/internal'], // cloud metadata endpoint
    ['ftp://example.com/file', 'Invalid protocol'],
    ['not-a-url', 'Invalid URL'],
  ])('blocks %s before ever calling fetch', async (url, expectedError) => {
    global.fetch = vi.fn();

    const result = await runHttp({ url, method: 'GET' });

    expect(result.success).toBe(false);
    expect(result.nodeResults.n1.error).toContain(expectedError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('blocks a disallowed HTTP method before ever calling fetch', async () => {
    global.fetch = vi.fn();

    const result = await runHttp({ url: 'https://api.example.com/data', method: 'TRACE' });

    expect(result.success).toBe(false);
    expect(result.nodeResults.n1.error).toContain('Invalid HTTP method');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces network errors', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await runHttp({ url: 'https://api.example.com/data', method: 'GET' });

    expect(result.success).toBe(false);
    expect(result.nodeResults.n1.error).toBe('Network error');
  });
});

// loadAppState() reports currentProjectId as whatever project the UI last
// had selected — scope-incorrect for a workflow node running on a schedule
// with no human present. Every other non-interactive turn path (chatHelpers,
// compaction, ShadowService, AgentTurnService) builds a minimal AppState
// instead; the agent node should do the same, using the run's own projectId.
describe('WorkflowExecutor agent node — project scope', () => {
  beforeEach(() => {
    emitEvent.mockClear();
    vi.mocked(getSettingsRepository).mockReturnValue({ get: () => ({ apiKeys: {} }) } as unknown as ReturnType<typeof getSettingsRepository>);
    vi.mocked(getAgentRepository).mockReturnValue({
      getById: (id: string) => (id === 'agent-1' ? { id: 'agent-1', name: 'Agent', provider: 'anthropic', model: 'claude' } : null),
    } as unknown as ReturnType<typeof getAgentRepository>);
  });

  it('scopes memory.currentProjectId to the workflow\'s own project, not ambient UI state', async () => {
    let capturedProjectId: unknown;
    vi.mocked(streamAIResponse).mockImplementationOnce(async function* (_agent, memory) {
      capturedProjectId = (memory as { currentProjectId: unknown }).currentProjectId;
      yield 'ok';
    } as typeof streamAIResponse);

    const executor = new WorkflowExecutor();
    const result = await executor.executeWorkflow(makeWorkflow({
      projectId: 'proj-workflow-own',
      dagDefinition: {
        nodes: [{ id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'agent-1', prompt: 'hi' } }],
        edges: [],
      },
    }));

    expect(result.success).toBe(true);
    expect(capturedProjectId).toBe('proj-workflow-own');
  });
});
