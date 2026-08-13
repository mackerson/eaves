/**
 * The bus half of the envelope contract.
 *
 * Renderer events have carried { turnId, agentId, containerId, context } since
 * ADR-001, but the EventBus emits carried agentId alone — so a bus consumer
 * could only ask "which agent?", never "which conversation?". That is what let
 * MessagingBridgeService cross-feed one agent's turns between surfaces.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { eventBus } from './EventBus';
import {
  routeStreamEvent,
  emitStreamComplete,
  emitStreamAborted,
  emitAgentSpend,
  emitStreamSentinel,
  emitCompaction,
  trackUsage,
  createStreamMetrics,
  type StreamEnvelope,
} from './streamEventRouter';

const envelope: StreamEnvelope = {
  turnId: 'turn-1',
  agentId: 'agent-1',
  containerId: 'chat-42',
  context: 'chat',
};

function capture(type: string) {
  const seen: any[] = [];
  eventBus.onEvent(type, (e) => seen.push(e.data));
  return seen;
}

describe('streamEventRouter bus payloads', () => {
  beforeEach(() => {
    eventBus.removeAllListeners?.('chat:stream');
    eventBus.removeAllListeners?.('chat:complete');
    eventBus.removeAllListeners?.('chat:aborted');
  });

  it('stamps text chunks with the conversation they belong to', () => {
    const seen = capture('chat:stream');
    routeStreamEvent('hello', 'agent-1', null, createStreamMetrics(), 'text', envelope);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      agentId: 'agent-1',
      chunk: 'hello',
      containerId: 'chat-42',
      context: 'chat',
      turnId: 'turn-1',
    });
  });

  it('stamps completion so consumers can match it to the turn they started', () => {
    const seen = capture('chat:complete');
    emitStreamComplete('agent-1', 5, 3, createStreamMetrics(), envelope);

    expect(seen[0]).toMatchObject({ agentId: 'agent-1', containerId: 'chat-42', turnId: 'turn-1' });
  });

  it('emits a terminal event for an aborted turn', () => {
    const seen = capture('chat:aborted');
    emitStreamAborted('agent-1', envelope);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agentId: 'agent-1', containerId: 'chat-42', context: 'chat' });
  });

  it('leaves containerId undefined for unstamped emitters rather than inventing one', () => {
    const seen = capture('chat:stream');
    routeStreamEvent('hello', 'agent-1', null, createStreamMetrics());

    expect(seen[0].containerId).toBeUndefined();
  });
});

describe('trackUsage', () => {
  // The bug this exists for: `finish-step` reports ONE step's usage, and the
  // old accounting assigned it, so a 4-step tool chain reported whichever step
  // landed last. Each step resends the accumulated tool results, so the steps
  // a consumer never saw were the expensive ones — a token ramp hiding in
  // plain sight.
  it('prefers the SDK summed total over any single step', () => {
    const m = createStreamMetrics();
    for (const inputTokens of [10_000, 15_000, 22_000, 30_000]) {
      trackUsage({ type: 'step-finish', finishReason: 'tool-calls', usage: { inputTokens, outputTokens: 200, totalTokens: inputTokens + 200 } }, m);
    }
    trackUsage({ type: 'usage-total', usage: { inputTokens: 77_000, outputTokens: 800, totalTokens: 77_800 } }, m);

    expect(m.inputTokens).toBe(77_000);
    expect(m.totalTokens).toBe(77_800);
    expect(m.usageIsTotal).toBe(true);
  });

  it('falls back to the largest step, not the last, when the total never arrives', () => {
    const m = createStreamMetrics();
    trackUsage({ type: 'step-finish', finishReason: 'tool-calls', usage: { inputTokens: 30_000, outputTokens: 500, totalTokens: 30_500 } }, m);
    // A short summarizing final step must not erase the expensive one.
    trackUsage({ type: 'step-finish', finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 } }, m);

    expect(m.inputTokens).toBe(30_000);
    expect(m.usageIsTotal).toBeFalsy();
  });

  it('does not let a late step overwrite the authoritative total', () => {
    const m = createStreamMetrics();
    trackUsage({ type: 'usage-total', usage: { inputTokens: 77_000, outputTokens: 800, totalTokens: 77_800 } }, m);
    trackUsage({ type: 'step-finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } }, m);
    expect(m.inputTokens).toBe(77_000);
  });

  it('captures the provider-reported cost and cache hits', () => {
    const m = createStreamMetrics();
    trackUsage({ type: 'provider-metadata', servedProvider: 'DeepInfra', cost: 0.0042, cachedTokens: 1200 }, m);
    expect(m.cost).toBe(0.0042);
    expect(m.servedProvider).toBe('DeepInfra');
    expect(m.cachedTokens).toBe(1200);
  });

  it('ignores junk without throwing', () => {
    const m = createStreamMetrics();
    expect(() => trackUsage(undefined, m)).not.toThrow();
    expect(() => trackUsage('a string chunk', m)).not.toThrow();
    expect(() => trackUsage({ nope: true }, m)).not.toThrow();
    expect(m.inputTokens).toBe(0);
  });
});

describe('emitAgentSpend', () => {
  const agent = { id: 'agent-1', name: 'Ninja', provider: 'openrouter', model: 'x/y' };

  beforeEach(() => { eventBus.removeAllListeners?.('agent:spend'); });

  it('records one attributable row per inference', () => {
    const seen = capture('agent:spend');
    const m = createStreamMetrics();
    trackUsage({ type: 'usage-total', usage: { inputTokens: 77_000, outputTokens: 800, totalTokens: 77_800 } }, m);
    trackUsage({ type: 'provider-metadata', servedProvider: 'DeepInfra', cost: 0.12 }, m);

    emitAgentSpend(agent, m, { kind: 'workflow-node', containerId: 'wf-1' });

    expect(seen[0]).toMatchObject({
      agentId: 'agent-1',
      agentName: 'Ninja',
      kind: 'workflow-node',
      containerId: 'wf-1',
      totalTokens: 77_800,
      cost: 0.12,
      usageIsTotal: true,
    });
  });

  it('flags a figure that is only a floor', () => {
    const seen = capture('agent:spend');
    const m = createStreamMetrics();
    trackUsage({ type: 'step-finish', finishReason: 'tool-calls', usage: { inputTokens: 900, outputTokens: 10, totalTokens: 910 } }, m);

    emitAgentSpend(agent, m, { kind: 'compaction' });

    // An aborted turn still reports what it burned, but must not claim the
    // number is complete.
    expect(seen[0].usageIsTotal).toBe(false);
    expect(seen[0].totalTokens).toBe(910);
  });
});

/**
 * The SDK surfaces a refused connection or an overloaded provider as an error
 * *part* of the stream, not a throw — so the turn "completes" carrying an error
 * notice. Nothing reached the bus for that, which made the commonest way an
 * agent fails the one failure the activity feed never recorded.
 */
describe('terminal in-band stream errors', () => {
  beforeEach(() => { eventBus.removeAllListeners?.('chat:error'); });

  it('reports an in-band error to the bus, attributed to its conversation', () => {
    const seen = capture('chat:error');
    routeStreamEvent(
      { type: 'error', error: { message: 'fetch failed' } },
      'agent-1', null, createStreamMetrics(), 'text', envelope,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      agentId: 'agent-1',
      containerId: 'chat-42',
      context: 'chat',
      turnId: 'turn-1',
      error: { message: 'fetch failed' },
    });
  });

  it('accepts a bare string error', () => {
    const seen = capture('chat:error');
    routeStreamEvent({ type: 'error', error: 'overloaded' }, 'agent-1', null, createStreamMetrics(), 'text', envelope);

    expect(seen[0].error).toEqual({ message: 'overloaded' });
  });

  it('stays quiet for every other event type', () => {
    const seen = capture('chat:error');
    routeStreamEvent({ type: 'tool-call-start', toolName: 'bash' }, 'agent-1', null, createStreamMetrics(), 'text', envelope);
    routeStreamEvent('some text', 'agent-1', null, createStreamMetrics(), 'text', envelope);

    expect(seen).toHaveLength(0);
  });
});

// The renderer half of the same contract. Every `if (mainWindow)` arm above is
// unreachable from a null window, so these drive a stub BrowserWindow.
function fakeWindow() {
  const send = vi.fn();
  return { win: { webContents: { send } } as any, send };
}

describe('routeStreamEvent — renderer delivery', () => {
  it('forwards a text chunk with the configured text type', () => {
    const { win, send } = fakeWindow();
    routeStreamEvent('hello', 'agent-1', win, createStreamMetrics(), 'content', envelope);
    expect(send).toHaveBeenCalledWith('chat-stream', {
      type: 'content',
      content: 'hello',
      ...envelope,
    });
  });

  it('defaults the text type to "text"', () => {
    const { win, send } = fakeWindow();
    routeStreamEvent('hi', 'agent-1', win, createStreamMetrics());
    expect(send).toHaveBeenCalledWith('chat-stream', { type: 'text', content: 'hi' });
  });

  it.each([
    ['tool-call-start', 'tool:call', { toolName: 'bash', args: { cmd: 'ls' } }],
    ['tool-call-result', 'tool:result', { toolName: 'bash', result: 'ok' }],
    ['tool-call-error', 'tool:error', { toolName: 'bash', error: 'nope' }],
  ])('emits %s on the bus and forwards it to the renderer', (type, busEvent, payload) => {
    const seen = capture(busEvent);
    const { win, send } = fakeWindow();
    routeStreamEvent({ type, ...payload }, 'agent-1', win, createStreamMetrics(), 'text', envelope);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agentId: 'agent-1', toolName: 'bash' });
    expect(send).toHaveBeenCalledWith('chat-stream', { type, ...payload, ...envelope });
  });

  it('emits an approval request with its call identity', () => {
    const seen = capture('tool:approval-request');
    const { win, send } = fakeWindow();
    routeStreamEvent(
      { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'tc-1', toolName: 'bash', input: {} },
      'agent-1',
      win,
      createStreamMetrics(),
      'text',
      envelope,
    );
    expect(seen[0]).toMatchObject({ approvalId: 'ap-1', toolCallId: 'tc-1', toolName: 'bash' });
    expect(send).toHaveBeenCalled();
  });

  it('emits a denial with its call identity', () => {
    const seen = capture('tool:denied');
    const { win } = fakeWindow();
    routeStreamEvent(
      { type: 'tool-output-denied', toolCallId: 'tc-1', toolName: 'bash' },
      'agent-1',
      win,
      createStreamMetrics(),
    );
    expect(seen[0]).toMatchObject({ toolCallId: 'tc-1', toolName: 'bash' });
  });

  it.each(['usage-total', 'response-messages'])(
    'keeps the backend-only %s signal off the renderer channel',
    (type) => {
      const { win, send } = fakeWindow();
      routeStreamEvent(
        { type, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } },
        'agent-1',
        win,
        createStreamMetrics(),
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('still forwards step-finish, which is not backend-only', () => {
    const { win, send } = fakeWindow();
    const metrics = createStreamMetrics();
    routeStreamEvent({ type: 'step-finish', finishReason: 'stop' }, 'agent-1', win, metrics);
    expect(send).toHaveBeenCalled();
    expect(metrics.finishReason).toBe('stop');
  });

  it('forwards an unstamped event unwrapped when there is no envelope', () => {
    const { win, send } = fakeWindow();
    routeStreamEvent({ type: 'tool-call-start', toolName: 't' }, 'agent-1', win, createStreamMetrics());
    expect(send).toHaveBeenCalledWith('chat-stream', { type: 'tool-call-start', toolName: 't' });
  });

  it('is a no-op on the renderer side when there is no window', () => {
    expect(() =>
      routeStreamEvent('chunk', 'agent-1', null, createStreamMetrics(), 'text', envelope),
    ).not.toThrow();
  });
});

describe('trackUsage — partial usage payloads', () => {
  it('keeps prior values for fields the total omits', () => {
    const metrics = createStreamMetrics();
    metrics.inputTokens = 11;
    metrics.outputTokens = 22;
    metrics.totalTokens = 33;
    trackUsage({ type: 'usage-total', usage: {} }, metrics);
    expect(metrics).toMatchObject({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
    expect(metrics.usageIsTotal).toBe(true);
  });

  it('treats a step with missing usage fields as zero rather than NaN', () => {
    const metrics = createStreamMetrics();
    trackUsage({ type: 'step-finish', usage: {} }, metrics);
    expect(metrics).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('ignores a step-finish that carries no usage at all', () => {
    const metrics = createStreamMetrics();
    metrics.inputTokens = 7;
    trackUsage({ type: 'step-finish' }, metrics);
    expect(metrics.inputTokens).toBe(7);
  });

  it('ignores provider metadata fields of the wrong type', () => {
    const metrics = createStreamMetrics();
    trackUsage(
      { type: 'provider-metadata', cachedTokens: 'lots', cacheWriteTokens: null, cost: '3' },
      metrics,
    );
    expect(metrics.cachedTokens).toBeUndefined();
    expect(metrics.cacheWriteTokens).toBeUndefined();
    expect(metrics.cost).toBeUndefined();
  });
});

describe('emitStreamSentinel / emitCompaction', () => {
  it.each([
    ['start', 'stream:start'],
    ['end', 'stream:end'],
  ])('sends the %s sentinel', (phase, type) => {
    const { win, send } = fakeWindow();
    emitStreamSentinel(win, phase as 'start' | 'end', envelope);
    expect(send).toHaveBeenCalledWith('chat-stream', { type, ...envelope });
  });

  it.each([
    ['start', 'compaction-start'],
    ['end', 'compaction-end'],
  ])('sends the %s compaction marker', (phase, type) => {
    const { win, send } = fakeWindow();
    emitCompaction(win, phase as 'start' | 'end', envelope);
    expect(send).toHaveBeenCalledWith('chat-stream', { type, ...envelope });
  });

  it('degrades to an unstamped payload when no envelope is supplied', () => {
    const { win, send } = fakeWindow();
    emitStreamSentinel(win, 'start');
    expect(send).toHaveBeenCalledWith('chat-stream', { type: 'stream:start' });
  });

  it('does nothing without a window', () => {
    expect(() => emitStreamSentinel(null, 'start', envelope)).not.toThrow();
    expect(() => emitCompaction(null, 'end', envelope)).not.toThrow();
  });
});
