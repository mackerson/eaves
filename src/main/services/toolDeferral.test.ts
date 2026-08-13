import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));

import { deferTool, isDeferredTool } from './toolDeferral';
import { builtinTools } from './builtinTools';
import { computeActiveToolNames, activeToolsFor } from '../ipc/chatHelpers';

const DISCOVERY = ['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool'];

describe('deferTool', () => {
  it('marks a tool without changing its identity', () => {
    const def = { description: 'x' };
    expect(deferTool(def)).toBe(def);
    expect(isDeferredTool(def)).toBe(true);
  });

  it('leaves unmarked values alone', () => {
    expect(isDeferredTool({ description: 'x' })).toBe(false);
    expect(isDeferredTool(undefined)).toBe(false);
    expect(isDeferredTool(null)).toBe(false);
    expect(isDeferredTool('create_workflow')).toBe(false);
  });

  it('keeps the marker off the wire', () => {
    const def = deferTool({ description: 'x', inputSchema: {} });
    // A symbol key cannot be serialized or enumerated, so it can never leak
    // into a tool definition sent to a provider.
    expect(JSON.parse(JSON.stringify(def))).toEqual({ description: 'x', inputSchema: {} });
    expect(Object.keys(def)).toEqual(['description', 'inputSchema']);
  });
});

describe('deferred builtin tools', () => {
  /**
   * The deferral set is a cost/behaviour tradeoff, not an implementation
   * detail: deferring a common read path costs more in round trips than it
   * saves in schema. Pin it so a change is deliberate.
   */
  const EXPECTED_DEFERRED = [
    'create_routine',
    'create_workflow',
    'delete_routine',
    'delete_workflow',
    'execute_routine',
    'get_workflow',
    'toggle_routine',
    'update_routine',
    'update_workflow',
  ];

  it('defers exactly the workflow/routine authoring surface', () => {
    const deferred = Object.entries(builtinTools)
      .filter(([, def]) => isDeferredTool(def))
      .map(([name]) => name)
      .sort();
    expect(deferred).toEqual(EXPECTED_DEFERRED);
  });

  it('keeps the cheap list reads on the wire', () => {
    // Answering "what routines do I have?" must not cost a discovery round
    // trip — that is a common read, and the schemas are small.
    expect(isDeferredTool((builtinTools as any).list_workflows)).toBe(false);
    expect(isDeferredTool((builtinTools as any).list_routines)).toBe(false);
  });

  it('keeps everyday tools on the wire', () => {
    for (const name of ['bash', 'edit_file', 'grep', 'glob', 'web_search', 'store_memory']) {
      expect(isDeferredTool((builtinTools as any)[name]), `${name} must not be deferred`).toBe(false);
    }
  });
});

describe('computeActiveToolNames', () => {
  const tools = {
    list_tools: {},
    get_tool_info: {},
    enable_tool: {},
    disable_tool: {},
    bash: {},
    grep: {},
    create_workflow: deferTool({}),
    update_workflow: deferTool({}),
  };

  it("in 'all' mode exposes everything except deferred tools", () => {
    const active = computeActiveToolNames(tools, new Set(), 'all');
    expect(active.sort()).toEqual([...DISCOVERY, 'bash', 'grep'].sort());
    expect(active).not.toContain('create_workflow');
  });

  it("in 'all' mode a deferred tool appears once enabled", () => {
    const active = computeActiveToolNames(tools, new Set(['create_workflow']), 'all');
    expect(active).toContain('create_workflow');
    expect(active).not.toContain('update_workflow');
  });

  it("in 'enabled' mode exposes only discovery plus the enabled set", () => {
    const active = computeActiveToolNames(tools, new Set(['bash']), 'enabled');
    expect(active.sort()).toEqual([...DISCOVERY, 'bash'].sort());
  });

  it('always exposes the discovery control plane', () => {
    for (const mode of ['all', 'enabled'] as const) {
      const active = computeActiveToolNames(tools, new Set(), mode);
      for (const name of DISCOVERY) expect(active).toContain(name);
    }
  });

  it('is additive — a persisted set can only add, never subtract', () => {
    // The migration hazard: contexts carry enabled-sets written while gating
    // was off. Honouring one must not remove a tool the agent always had.
    const stale = new Set(['bash']);
    expect(computeActiveToolNames(tools, stale, 'all')).toContain('grep');
  });

  it('ignores enabled names that no longer exist', () => {
    const active = computeActiveToolNames(tools, new Set(['deleted_plugin_tool']), 'enabled');
    expect(active).not.toContain('deleted_plugin_tool');
  });
});

describe('cache breakpoint stability', () => {
  /**
   * The tool-block cache breakpoint lands on the last tool actually sent. If
   * that tool changed between steps of a turn, the block's bytes would change
   * with it and the cache would miss every step — costing far more than gating
   * saves. The discovery tools are registered last and can never be gated out,
   * which is what keeps the breakpoint target fixed.
   */
  it('ends the active set on the same tool however the enabled set changes', () => {
    const tools = {
      bash: {},
      create_workflow: deferTool({}),
      list_tools: {},
      get_tool_info: {},
      enable_tool: {},
      disable_tool: {},
    };
    const lastActive = (enabled: Set<string>, mode: 'all' | 'enabled') => {
      const active = new Set(computeActiveToolNames(tools, enabled, mode));
      return Object.keys(tools).filter(n => active.has(n)).pop();
    };

    expect(lastActive(new Set(), 'all')).toBe('disable_tool');
    expect(lastActive(new Set(['create_workflow']), 'all')).toBe('disable_tool');
    expect(lastActive(new Set(), 'enabled')).toBe('disable_tool');
    expect(lastActive(new Set(['bash']), 'enabled')).toBe('disable_tool');
  });
});

describe('activeToolsFor', () => {
  const toolset = (mode: 'all' | 'enabled') => ({
    toolSendMode: mode,
    getActiveToolNames: (override?: 'all' | 'enabled') => [override ?? mode],
  });

  it('gates unconditionally, whatever the mode or window', () => {
    expect(activeToolsFor(toolset('all'), 'large')()).toEqual(['all']);
    expect(activeToolsFor(toolset('enabled'), 'large')()).toEqual(['enabled']);
  });

  /**
   * The window is a user-settable override honoured for any provider, so a
   * cloud agent can be 'all' mode and still have a 4k window. Sending it the
   * full set would blow the context before the first message.
   */
  it("forces 'enabled' semantics on a tiny window even in 'all' mode", () => {
    expect(activeToolsFor(toolset('all'), 'tiny')()).toEqual(['enabled']);
  });

  it('leaves small and medium windows on their resolved mode', () => {
    expect(activeToolsFor(toolset('all'), 'small')()).toEqual(['all']);
    expect(activeToolsFor(toolset('all'), 'medium')()).toEqual(['all']);
    expect(activeToolsFor(toolset('all'), undefined)()).toEqual(['all']);
  });
});
