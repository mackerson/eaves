import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/eaves-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));

import {
  resolveToolSendMode,
  seedEnabledTools,
  activeToolsFor,
  computeActiveToolNames,
  buildRequestInfo,
} from '../ipc/chatHelpers';
import { deferTool } from './toolDeferral';
import type { Agent } from '../types';

/**
 * The tool-send posture, which had no coverage at all until a regression went
 * through it. These two functions decide how much schema every request carries
 * and, for a small local model, whether the request fits in the window.
 */

const agent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'A', provider: 'anthropic', model: 'claude-opus-5', ...over }) as Agent;

describe('resolveToolSendMode', () => {
  it("defaults local endpoints to 'enabled' — they cannot afford the full set", () => {
    expect(resolveToolSendMode(agent({ provider: 'ollama' }))).toBe('enabled');
    expect(resolveToolSendMode(agent({ provider: 'lmstudio' }))).toBe('enabled');
  });

  it("defaults cloud providers to 'all'", () => {
    for (const provider of ['anthropic', 'openai', 'google', 'openrouter']) {
      expect(resolveToolSendMode(agent({ provider })), provider).toBe('all');
    }
  });

  it('lets an explicit agent setting win over the provider default', () => {
    expect(resolveToolSendMode(agent({ provider: 'anthropic', toolSendMode: 'enabled' }))).toBe('enabled');
    expect(resolveToolSendMode(agent({ provider: 'ollama', toolSendMode: 'all' }))).toBe('all');
  });

  it("falls back to 'all' for an unknown provider rather than starving it", () => {
    // Failing the other way would silently strip every tool from an agent on a
    // provider we don't recognise.
    expect(resolveToolSendMode(agent({ provider: 'some-new-provider' }))).toBe('all');
  });
});

describe('seedEnabledTools', () => {
  const DISCOVERY = ['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool'];

  it('always seeds the discovery control plane', () => {
    const seed = seedEnabledTools(agent());
    for (const name of DISCOVERY) expect(seed.has(name)).toBe(true);
  });

  it("seeds the agent's declared defaultTools alongside it", () => {
    const seed = seedEnabledTools(agent({ defaultTools: ['bash', 'create_workflow'] }));
    expect(seed.has('bash')).toBe(true);
    // An explicit defaultTools entry beats deferral: the agent author asked
    // for it, so it is enabled from the first turn and rides along.
    expect(seed.has('create_workflow')).toBe(true);
  });

  // eaves_guide rides along with the control plane: an agent that can't look
  // up how Eaves works answers from nothing, and the user can't tell.
  it('handles an agent with no defaultTools', () => {
    expect([...seedEnabledTools(agent())].sort()).toEqual([...DISCOVERY, 'eaves_guide'].sort());
  });
});

describe('buildRequestInfo', () => {
  const budget = { contextWindow: 200_000, sizeClass: 'large' as const, messageBudget: 150_000 };
  const base = {
    budget,
    systemPrompt: 'you are a helpful agent',
    messagesTotal: 40,
    messagesSent: 12,
    activeToolNames: ['bash', 'grep'],
  };

  it('reports the gated tool count, not the registered one', () => {
    // The number users see as "what this request cost" — before the extraction
    // one copy of this counted every registered tool while gating was off.
    const info = buildRequestInfo(base);
    expect(info.toolCount).toBe(2);
    expect(info.toolsIncluded).toBe(true);
  });

  it('reports no tools when the active set is empty', () => {
    const info = buildRequestInfo({ ...base, activeToolNames: [] });
    expect(info.toolCount).toBe(0);
    expect(info.toolsIncluded).toBe(false);
  });

  it('carries budget and windowing through unchanged', () => {
    const info = buildRequestInfo(base);
    expect(info).toMatchObject({
      contextWindow: 200_000,
      sizeClass: 'large',
      messageBudget: 150_000,
      messagesTotal: 40,
      messagesSent: 12,
    });
    expect(info.systemPromptTokens).toBeGreaterThan(0);
  });

  it('withholds the prompt text unless debug logging asked for it', () => {
    expect(buildRequestInfo(base).systemPrompt).toBeUndefined();
    expect(buildRequestInfo({ ...base, includeSystemPrompt: true }).systemPrompt).toBe(base.systemPrompt);
  });
});

describe('small-model posture end to end', () => {
  const tools = {
    bash: {},
    grep: {},
    create_workflow: deferTool({}),
    list_tools: {},
    get_tool_info: {},
    enable_tool: {},
    disable_tool: {},
  };

  const activeFor = (a: Agent, sizeClass: 'tiny' | 'large', enabled = new Set<string>()) => {
    const mode = resolveToolSendMode(a);
    return activeToolsFor(
      { toolSendMode: mode, getActiveToolNames: (o) => computeActiveToolNames(tools, enabled, o ?? mode) },
      sizeClass,
    )();
  };

  it('gives a local small model the discovery floor only', () => {
    const active = activeFor(agent({ provider: 'ollama' }), 'tiny');
    expect(active.sort()).toEqual(['disable_tool', 'enable_tool', 'get_tool_info', 'list_tools']);
  });

  it('gives a local model its seeded defaultTools on top of discovery', () => {
    const active = activeFor(agent({ provider: 'ollama' }), 'tiny', new Set(['bash']));
    expect(active).toContain('bash');
    expect(active).not.toContain('grep');
  });

  /**
   * The regression this file exists for: a cloud agent resolves to 'all', but
   * contextWindow is a user override honoured for any provider. A 4k window
   * must not receive the full set.
   */
  it('trims a cloud model pinned to a tiny window down to the floor', () => {
    const active = activeFor(agent({ provider: 'anthropic' }), 'tiny');
    expect(active).not.toContain('bash');
    expect(active).toHaveLength(4);
  });

  it('gives a normal cloud model everything except deferred tools', () => {
    const active = activeFor(agent({ provider: 'anthropic' }), 'large');
    expect(active).toContain('bash');
    expect(active).toContain('grep');
    expect(active).not.toContain('create_workflow');
  });
});
