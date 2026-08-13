import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  toolStateRepo,
  grantRepo,
  fileRepo,
  projectRepo,
  channelRepo,
  settingsRepo,
  connectMCPServers,
  getSandboxedPluginManager,
  buildMemoryContext,
  streamAIResponse,
  routeStreamEvent,
  emitStreamStart,
  emitStreamComplete,
  emitAgentSpend,
} = vi.hoisted(() => ({
  toolStateRepo: { get: vi.fn(), set: vi.fn() },
  grantRepo: { listToolNames: vi.fn() },
  fileRepo: { getByProjectId: vi.fn() },
  projectRepo: { getById: vi.fn() },
  channelRepo: { isWorkSession: vi.fn() },
  settingsRepo: { get: vi.fn() },
  connectMCPServers: vi.fn(),
  getSandboxedPluginManager: vi.fn(),
  buildMemoryContext: vi.fn(),
  streamAIResponse: vi.fn(),
  routeStreamEvent: vi.fn(),
  emitStreamStart: vi.fn(),
  emitStreamComplete: vi.fn(),
  emitAgentSpend: vi.fn(),
}));

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock('../repositories', () => ({
  getToolStateRepository: () => toolStateRepo,
  getToolApprovalGrantRepository: () => grantRepo,
  getFileRepository: () => fileRepo,
  getProjectRepository: () => projectRepo,
  getChannelRepository: () => channelRepo,
  getSettingsRepository: () => settingsRepo,
}));
vi.mock('../services/mcp', () => ({ connectMCPServers }));
vi.mock('../services/sandbox', () => ({ getSandboxedPluginManager }));
vi.mock('../services/memoryContext', () => ({ buildMemoryContext }));
vi.mock('../services/ai', () => ({ streamAIResponse }));
vi.mock('../services/streamEventRouter', () => ({
  routeStreamEvent,
  emitStreamStart,
  emitStreamComplete,
  emitAgentSpend,
  createStreamMetrics: () => ({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }),
}));
// Keep heavy tool modules from doing real work; buildToolset still merges them.
vi.mock('../services/builtinTools', () => ({
  builtinTools: {
    bash: { needsApproval: true, description: 'bash' },
    list_tasks: { description: 'tasks' },
  },
}));
vi.mock('../services/channelTools', () => ({
  createChannelTools: () => ({ channel_list: { description: 'list' } }),
}));
vi.mock('../services/agentSelfTools', () => ({
  createAgentSelfTools: () => ({ get_my_channel_behavior: { description: 'self' } }),
}));
vi.mock('../services/coreMemoryTools', () => ({
  createCoreMemoryTools: () => ({ core_memory_replace: { description: 'mem' } }),
}));
vi.mock('../services/workSessionTools', () => ({
  createWorkSessionTools: () => ({ complete_work_session: { description: 'done' } }),
}));
vi.mock('../services/discoveryTools', () => ({
  createDiscoveryTools: (all: Record<string, unknown>) => {
    // Register discovery tools into the same object buildToolset will return.
    return {
      list_tools: { description: 'list' },
      get_tool_info: { description: 'info' },
      enable_tool: {
        description: 'enable',
        execute: async () => {
          void all;
          return { ok: true };
        },
      },
      disable_tool: { description: 'disable' },
    };
  },
}));
vi.mock('../services/toolDeferral', () => ({
  isDeferredTool: () => false,
  // transcriptTools defers summarize_conversation_at at definition time, so the
  // mock has to provide the marker function as well as the predicate.
  deferTool: <T,>(t: T) => t,
}));

import {
  loadSessionState,
  systemPromptPlumbing,
  buildSystemPrompt,
  buildToolset,
  runStream,
} from './chatHelpers';
import type { Agent, Project, Settings } from '../types';

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    name: 'Ada',
    provider: 'anthropic',
    model: 'claude-opus-5',
    systemPrompt: 'You are helpful.',
    description: 'desc',
    ...over,
  }) as Agent;

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    name: 'Proj',
    tasks: [{ id: 't1', content: 'x', completed: false, createdAt: 1 }],
    notes: [{ id: 'n1' }],
    ...over,
  }) as Project;

const settings = { userName: 'Robin' } as Settings;

describe('loadSessionState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached state without hitting the repo', () => {
    const cache = new Map();
    const existing = { enabledTools: new Set(['bash']), onChanged: vi.fn() };
    cache.set('ch-1', existing);
    expect(loadSessionState('ch-1', cache, new Set(['list_tools']))).toBe(existing);
    expect(toolStateRepo.get).not.toHaveBeenCalled();
  });

  it('rehydrates from persisted row; empty array is a real state', () => {
    toolStateRepo.get.mockReturnValue([]);
    const cache = new Map();
    const state = loadSessionState('ch-1', cache, new Set(['seed-only']));
    expect([...state.enabledTools]).toEqual([]);
    expect(cache.get('ch-1')).toBe(state);

    // onChanged persists while still in cache
    state.enabledTools.add('bash');
    state.onChanged?.();
    expect(toolStateRepo.set).toHaveBeenCalledWith('ch-1', ['bash']);
  });

  it('uses seed when nothing is persisted (null)', () => {
    toolStateRepo.get.mockReturnValue(null);
    const seed = new Set(['list_tools', 'bash']);
    const state = loadSessionState('ch-2', new Map(), seed);
    expect(state.enabledTools).toEqual(seed);
  });

  it('onChanged no-ops after eviction (orphan re-INSERT guard)', () => {
    toolStateRepo.get.mockReturnValue(['bash']);
    const cache = new Map();
    const state = loadSessionState('ch-3', cache, new Set());
    cache.delete('ch-3');
    state.onChanged?.();
    expect(toolStateRepo.set).not.toHaveBeenCalled();
  });
});

describe('systemPromptPlumbing', () => {
  it('picks toolset + budget fields without inventing extras', () => {
    expect(
      systemPromptPlumbing(
        {
          projectDirectories: [{ name: 'src', path: '/x' }],
          builtinToolCount: 10,
          mcpToolCount: 2,
          totalToolCount: 20,
        },
        { systemPromptBudget: 4000, sizeClass: 'medium' },
      ),
    ).toEqual({
      projectDirectories: [{ name: 'src', path: '/x' }],
      builtinToolCount: 10,
      mcpToolCount: 2,
      totalToolCount: 20,
      tokenBudget: 4000,
      sizeClass: 'medium',
    });
  });
});

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMemoryContext.mockResolvedValue('');
  });

  it('always includes identity and can attach participant / roleplay notes', async () => {
    const prompt = await buildSystemPrompt({
      agent: agent(),
      project: project(),
      settings,
      participantNote: 'Respond when mentioned.',
      roleplayNote: 'Stay in character.',
      builtinToolCount: 1,
      mcpToolCount: 0,
      totalToolCount: 1,
    });
    expect(prompt).toContain('You are Ada');
    expect(prompt).toContain("user's name is Robin");
    expect(prompt).toContain('Respond when mentioned.');
    expect(prompt).toContain('Stay in character.');
  });

  it('includes project + participants and enrichment when unconstrained', async () => {
    buildMemoryContext.mockResolvedValue('\n\nMemories: likes tea');
    const prompt = await buildSystemPrompt({
      agent: agent(),
      project: project(),
      settings,
      participants: [
        { id: 'u1', type: 'human', displayName: 'Robin' },
        { id: 'a1', type: 'agent', displayName: 'Ada' },
        { id: 'a2', type: 'agent', displayName: 'Bob' },
      ],
      projectDirectories: [
        { name: 'src', path: '/repo/src', kind: 'attached' },
        { name: 'workspace', path: '/data/projects/proj-abc12345', kind: 'workspace' },
      ],
      builtinToolCount: 5,
      mcpToolCount: 1,
      totalToolCount: 10,
      sizeClass: 'large',
    });
    expect(prompt).toContain('Project: Proj');
    expect(prompt).toContain('Humans: Robin');
    expect(prompt).toContain('Ada (you)');
    expect(prompt).toContain('Active Tasks: 1');
    expect(prompt).toContain('Built-in Tools: 5');
    expect(prompt).toContain('src: /repo/src');
    expect(prompt).toContain('Memories: likes tea');
    // The workspace is listed, but apart from the attached folders — an agent
    // that cannot tell the two apart either treats the user's source tree as
    // scratch space or leaves its own scratch space unused.
    expect(prompt).toContain('Workspace (yours');
    expect(prompt).toContain('/data/projects/proj-abc12345');
    const attachedSection = prompt.slice(
      prompt.indexOf('attached by user'),
      prompt.indexOf('Workspace (yours'),
    );
    expect(attachedSection).toContain('src: /repo/src');
    expect(attachedSection).not.toContain('proj-abc12345');
  });

  it('uses promptTemplate path when author supplies one', async () => {
    const prompt = await buildSystemPrompt({
      agent: agent({
        promptTemplate: 'Hello {{user}} from {{agent}} on {{project}}',
        systemPrompt: 'base',
      }),
      project: project(),
      settings,
      builtinToolCount: 0,
      mcpToolCount: 0,
      totalToolCount: 0,
    });
    expect(prompt).toContain('Hello Robin from Ada on Proj');
  });

  it('suppresses productivity enrichment for roleplay archetype', async () => {
    const prompt = await buildSystemPrompt({
      agent: agent({ archetype: { type: 'roleplay' } as Agent['archetype'] }),
      project: project(),
      settings,
      projectDirectories: [{ name: 'src', path: '/x' }],
      builtinToolCount: 9,
      mcpToolCount: 0,
      totalToolCount: 9,
      sizeClass: 'large',
    });
    expect(prompt).not.toContain('Available Tools:');
    expect(prompt).not.toContain('Active Tasks:');
    expect(prompt).not.toContain('Project Folders');
  });
});

describe('buildToolset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileRepo.getByProjectId.mockReturnValue([
      { name: 'src', path: '/repo/src', type: 'directory', createdAt: 1 },
    ]);
    projectRepo.getById.mockReturnValue({ id: 'p1', directory: '/data/projects/proj-abc12345' });
    connectMCPServers.mockResolvedValue({ clients: [], tools: {} });
    getSandboxedPluginManager.mockReturnValue({ getRegisteredTools: () => ({}) });
    channelRepo.isWorkSession.mockReturnValue(false);
    toolStateRepo.get.mockReturnValue(null);
    grantRepo.listToolNames.mockReturnValue(new Set());
  });

  it('applies approval grants by clearing needsApproval on a copy (not shared builtins)', async () => {
    grantRepo.listToolNames.mockReturnValue(new Set(['bash']));
    const toolset = await buildToolset(agent(), project(), 'ch-1', new Map());
    const bash = toolset.enabledTools.bash as { needsApproval?: unknown };
    expect(bash.needsApproval).toBe(false);
    // Original mock export stays approval-gated
    const { builtinTools } = await import('../services/builtinTools');
    expect((builtinTools as { bash: { needsApproval?: unknown } }).bash.needsApproval).toBe(true);
  });

  it('roleplay archetype intersects with defaultTools allowlist only', async () => {
    const toolset = await buildToolset(
      agent({
        archetype: { type: 'roleplay' } as Agent['archetype'],
        defaultTools: ['list_tasks'],
      }),
      project(),
      'ch-1',
      new Map(),
    );
    expect(Object.keys(toolset.enabledTools).sort()).toEqual(['list_tasks']);
    expect(toolset.getActiveToolNames()).toEqual(['list_tasks']);
  });

  it('productivity path registers discovery tools and reports directories', async () => {
    const toolset = await buildToolset(agent({ defaultTools: ['list_tasks'] }), project(), 'ch-1', new Map());
    // Attached folders first, workspace last — the same list the built-in file
    // tools resolve against, so the MCP filesystem servers cover it too.
    expect(toolset.projectDirectories).toEqual([
      { name: 'src', path: '/repo/src', kind: 'attached' },
      { name: 'workspace', path: '/data/projects/proj-abc12345', kind: 'workspace' },
    ]);
    expect(toolset.enabledTools.list_tools).toBeDefined();
    expect(toolset.getActiveToolNames()).toEqual(
      expect.arrayContaining(['list_tools', 'enable_tool', 'list_tasks']),
    );
  });

  it('includes work-session tools only for work-session channels', async () => {
    channelRepo.isWorkSession.mockReturnValue(true);
    const toolset = await buildToolset(agent(), project(), 'ws-1', new Map());
    expect(toolset.enabledTools.complete_work_session).toBeDefined();
  });
});

describe('runStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsRepo.get.mockReturnValue({ userName: 'Robin' });
  });

  it('routes events, collects approvals, captures response-messages and cost', async () => {
    streamAIResponse.mockImplementation(async function* () {
      yield 'Hello';
      yield {
        type: 'tool-approval-request',
        approvalId: 'ap-1',
        toolCallId: 'tc-1',
        toolName: 'bash',
        input: { cmd: 'ls' },
      };
      yield { type: 'provider-metadata', servedProvider: 'GMICloud', cost: 0.012, cachedTokens: 100 };
      yield { type: 'response-messages', messages: [{ role: 'assistant', content: 'Hello' }] };
      yield { type: 'error', error: 'upstream overloaded' };
      return 'Hello';
    });

    const result = await runStream({
      agent: agent({ promptCostPer1M: 1, completionCostPer1M: 1 }),
      formattedResult: {
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: 'sys',
      },
      enabledTools: {},
      abortSignal: new AbortController().signal,
      mainWindow: null,
      messageCount: 2,
      preferredProvider: 'GMICloud',
      envelope: { context: 'chat', containerId: 'ch-1', turnId: 't1' },
    });

    expect(emitStreamStart).toHaveBeenCalled();
    expect(emitStreamComplete).toHaveBeenCalled();
    expect(emitAgentSpend).toHaveBeenCalled();
    expect(result.responseMessages).toEqual([{ role: 'assistant', content: 'Hello' }]);
    expect(result.pendingApprovals).toEqual([
      {
        approvalId: 'ap-1',
        toolCallId: 'tc-1',
        toolName: 'bash',
        input: { cmd: 'ls' },
      },
    ]);
    expect(result.metrics.servedProvider).toBe('GMICloud');
    expect(result.metrics.cost).toBe(0.012);
    expect(result.streamError).toBe('upstream overloaded');
    expect(result.response).toContain('Hello');
  });
});
