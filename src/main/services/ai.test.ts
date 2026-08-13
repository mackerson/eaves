import { describe, it, expect, vi, beforeEach } from 'vitest';

const { streamText, getProviderAdapter, stripApprovalRequiredTools } = vi.hoisted(() => ({
  streamText: vi.fn(),
  getProviderAdapter: vi.fn(),
  stripApprovalRequiredTools: vi.fn((tools: unknown) => tools),
}));

vi.mock('ai', () => ({
  streamText,
  stepCountIs: (n: number) => ({ __stepCountIs: n }),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./providers', () => ({ getProviderAdapter }));

vi.mock('./toolGating', () => ({ stripApprovalRequiredTools }));

vi.mock('./promptCache', () => ({
  withToolCacheBreakpoint: (tools: unknown) => tools,
  withMessageCacheBreakpoint: (messages: unknown) => messages,
  supportsSystemCacheBreakpoint: (provider: string) => provider === 'openrouter',
  CACHE_BREAKPOINT_PROVIDER_OPTIONS: { openrouter: { cacheControl: { type: 'ephemeral' } } },
}));

vi.mock('../utils/aiErrors', () => ({
  friendlyAIErrorMessage: (err: { message?: string }, provider: string) =>
    `friendly:${provider}:${err?.message ?? 'unknown'}`,
  isConnectionError: (err: { type?: string } | undefined) => err?.type === 'connection_error',
  summarizeProviderError: (err: unknown) => ({ summary: String(err) }),
}));

import { streamAIResponse, getAIProvider, type AIMessage } from './ai';
import type { Agent, AppState } from '../types';

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    name: 'Ada',
    provider: 'anthropic',
    model: 'claude-test',
    temperature: 0.5,
    maxSteps: 5,
    maxOutputTokens: 1024,
    ...over,
  }) as Agent;

const memory = {
  settings: { apiKeys: { anthropic: 'sk-test', openrouter: 'or-key' }, openrouterStickyProvider: true },
} as unknown as AppState;

const messages: AIMessage[] = [{ role: 'user', content: 'hi' }];

function makeStream(parts: unknown[], extras: {
  totalUsage?: Promise<unknown>;
  response?: Promise<unknown>;
  providerMetadata?: Promise<unknown>;
} = {}) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    totalUsage: extras.totalUsage ?? Promise.resolve({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }),
    response: extras.response ?? Promise.resolve({ messages: [{ role: 'assistant', content: 'ok' }] }),
    providerMetadata: extras.providerMetadata ?? Promise.resolve({}),
  };
}

async function collect(gen: AsyncGenerator<unknown, string, unknown>) {
  const events: unknown[] = [];
  let done = await gen.next();
  while (!done.done) {
    events.push(done.value);
    done = await gen.next();
  }
  return { events, result: done.value };
}

describe('getAIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a language model via the provider adapter', () => {
    const createLanguageModel = vi.fn().mockReturnValue({ model: true });
    getProviderAdapter.mockReturnValue({ createLanguageModel });
    expect(getAIProvider(agent(), memory)).toEqual({ model: true });
    expect(createLanguageModel).toHaveBeenCalledWith('claude-test', { apiKey: 'sk-test' });
  });

  it('throws for unknown providers', () => {
    getProviderAdapter.mockReturnValue(undefined);
    expect(() => getAIProvider(agent({ provider: 'nope' }), memory)).toThrow(/Unknown provider/);
  });
});

describe('streamAIResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderAdapter.mockReturnValue({
      createLanguageModel: vi.fn().mockReturnValue({ id: 'model' }),
      getCapabilities: vi.fn().mockReturnValue({
        temperature: true,
        topP: true,
        maxOutputTokens: true,
        stopSequences: true,
      }),
    });
    stripApprovalRequiredTools.mockImplementation((tools: unknown) => tools);
  });

  it('maps text, tool, step, usage, response, and provider-metadata events', async () => {
    streamText.mockReturnValue(
      makeStream(
        [
          { type: 'start-step' },
          { type: 'text-delta', text: 'Hi' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'bash', input: { cmd: 'ls' } },
          { type: 'tool-result', toolCallId: 'tc1', output: { ok: true } },
          {
            type: 'tool-approval-request',
            approvalId: 'ap1',
            toolCall: { toolCallId: 'tc1', toolName: 'bash', input: { cmd: 'ls' } },
          },
          { type: 'tool-output-denied', toolCallId: 'tc1' },
          {
            type: 'finish-step',
            finishReason: 'stop',
            usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          },
        ],
        {
          providerMetadata: Promise.resolve({
            openrouter: {
              provider: 'GMICloud',
              usage: { cost: 0.01, promptTokensDetails: { cachedTokens: 50 } },
            },
          }),
        },
      ),
    );

    const { events, result } = await collect(
      streamAIResponse(agent(), memory, messages, 'system', { bash: {} as never }),
    );

    expect(result).toBe('Hi');
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'step-start' },
        'Hi',
        { type: 'tool-call-start', toolName: 'bash', args: { cmd: 'ls' } },
        { type: 'tool-call-result', toolName: 'bash', result: { ok: true } },
        {
          type: 'tool-approval-request',
          approvalId: 'ap1',
          toolCallId: 'tc1',
          toolName: 'bash',
          input: { cmd: 'ls' },
        },
        { type: 'tool-output-denied', toolCallId: 'tc1', toolName: 'bash' },
        {
          type: 'step-finish',
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        },
        {
          type: 'usage-total',
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        },
        { type: 'response-messages', messages: [{ role: 'assistant', content: 'ok' }] },
        {
          type: 'provider-metadata',
          servedProvider: 'GMICloud',
          cost: 0.01,
          cachedTokens: 50,
        },
      ]),
    );
  });

  it('strips approval-required tools in nonInteractive mode', async () => {
    const tools = { bash: { needsApproval: true } as never, list_tasks: {} as never };
    stripApprovalRequiredTools.mockReturnValue({ list_tasks: tools.list_tasks });
    streamText.mockReturnValue(makeStream([{ type: 'text-delta', text: 'x' }]));

    await collect(
      streamAIResponse(agent(), memory, messages, undefined, tools, undefined, undefined, undefined, {
        nonInteractive: true,
        contextLabel: 'routine/test',
      }),
    );

    expect(stripApprovalRequiredTools).toHaveBeenCalledWith(tools, 'routine/test');
    const cfg = streamText.mock.calls[0][0];
    expect(cfg.tools).toEqual({ list_tasks: tools.list_tasks });
  });

  it('pins sticky OpenRouter provider when preferred and not disabled', async () => {
    streamText.mockReturnValue(makeStream([]));
    await collect(
      streamAIResponse(
        agent({ provider: 'openrouter' }),
        memory,
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { preferredProvider: 'GMICloud' },
      ),
    );
    expect(streamText.mock.calls[0][0].providerOptions).toEqual({
      openrouter: { provider: { order: ['GMICloud'], allow_fallbacks: true } },
    });
  });

  it('does not pin sticky provider when setting is disabled', async () => {
    streamText.mockReturnValue(makeStream([]));
    const mem = {
      settings: { apiKeys: {}, openrouterStickyProvider: false },
    } as unknown as AppState;
    await collect(
      streamAIResponse(
        agent({ provider: 'openrouter' }),
        mem,
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { preferredProvider: 'GMICloud' },
      ),
    );
    expect(streamText.mock.calls[0][0].providerOptions).toBeUndefined();
  });

  it('uses rawPrompt as the sole user message and skips top-level system (template includes it)', async () => {
    streamText.mockReturnValue(makeStream([{ type: 'text-delta', text: 'ok' }]));
    await collect(
      streamAIResponse(
        agent({ provider: 'openrouter' }),
        memory,
        messages,
        'SYS',
        undefined,
        undefined,
        'RAW PROMPT',
      ),
    );
    const cfg = streamText.mock.calls[0][0];
    // rawPrompt path: conversation is replaced; systemPrompt is not applied separately
    // because the instruct template already embeds it.
    expect(cfg.messages).toEqual([{ role: 'user', content: 'RAW PROMPT' }]);
    expect(cfg.system).toBeUndefined();
  });

  it('places openrouter system cache breakpoint on a system message when not using rawPrompt', async () => {
    streamText.mockReturnValue(makeStream([]));
    await collect(
      streamAIResponse(agent({ provider: 'openrouter' }), memory, messages, 'SYS'),
    );
    const cfg = streamText.mock.calls[0][0];
    expect(cfg.messages[0]).toMatchObject({ role: 'system', content: 'SYS' });
    expect(cfg.system).toBeUndefined();
  });

  it('wires activeTools + prepareStep when a gate is provided', async () => {
    streamText.mockReturnValue(makeStream([]));
    const activeTools = vi.fn(() => ['list_tools']);
    await collect(
      streamAIResponse(agent(), memory, messages, undefined, { list_tools: {} as never }, undefined, undefined, undefined, {
        activeTools,
      }),
    );
    const cfg = streamText.mock.calls[0][0];
    expect(cfg.activeTools).toEqual(['list_tools']);
    expect(cfg.prepareStep()).toEqual({ activeTools: ['list_tools'] });
  });

  it('maps tool-scoped vs general stream errors', async () => {
    streamText.mockReturnValue(
      makeStream([
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'bash', input: {} },
        { type: 'error', error: { type: 'tool_error', message: 'boom' } },
      ]),
    );
    const toolErr = await collect(streamAIResponse(agent(), memory, messages, undefined, { bash: {} as never }));
    expect(toolErr.events).toContainEqual({
      type: 'tool-call-error',
      toolName: 'bash',
      error: 'boom',
    });

    streamText.mockReturnValue(
      makeStream([
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'bash', input: {} },
        { type: 'error', error: { type: 'connection_error', message: 'refused' } },
      ]),
    );
    const connErr = await collect(streamAIResponse(agent(), memory, messages));
    expect(connErr.events).toContainEqual({
      type: 'error',
      error: 'friendly:anthropic:refused',
    });
  });

  it('emits anthropic cache read/write metadata', async () => {
    streamText.mockReturnValue(
      makeStream([], {
        providerMetadata: Promise.resolve({
          anthropic: {
            cacheCreationInputTokens: 12,
            usage: { cache_read_input_tokens: 34 },
          },
        }),
      }),
    );
    const { events } = await collect(streamAIResponse(agent(), memory, messages));
    expect(events).toContainEqual({
      type: 'provider-metadata',
      cachedTokens: 34,
      cacheWriteTokens: 12,
    });
  });

  it('omits sampling params the model cannot accept', async () => {
    getProviderAdapter.mockReturnValue({
      createLanguageModel: vi.fn().mockReturnValue({ id: 'model' }),
      getCapabilities: vi.fn().mockReturnValue({
        temperature: false,
        topP: false,
        maxOutputTokens: false,
        stopSequences: false,
      }),
    });
    streamText.mockReturnValue(makeStream([]));
    await collect(
      streamAIResponse(
        agent({ temperature: 0.9, topP: 0.8, maxOutputTokens: 99 }),
        memory,
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        ['STOP'],
      ),
    );
    const cfg = streamText.mock.calls[0][0];
    expect(cfg.temperature).toBeUndefined();
    expect(cfg.topP).toBeUndefined();
    expect(cfg.maxOutputTokens).toBeUndefined();
    expect(cfg.stopSequences).toBeUndefined();
  });

  it('rethrows streamText setup failures', async () => {
    streamText.mockImplementation(() => {
      throw new Error('sdk boom');
    });
    await expect(collect(streamAIResponse(agent(), memory, messages))).rejects.toThrow('sdk boom');
  });
});
