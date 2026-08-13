import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  streamAIResponse,
  resolveSystemAgent,
  settingsRepo,
  channelRepo,
  estimateMessageTokens,
  emitAgentSpend,
  trackUsage,
  createStreamMetrics,
} = vi.hoisted(() => ({
  streamAIResponse: vi.fn(),
  resolveSystemAgent: vi.fn(),
  settingsRepo: { get: vi.fn(() => ({})) },
  channelRepo: { setContextSummary: vi.fn() },
  estimateMessageTokens: vi.fn(),
  emitAgentSpend: vi.fn(),
  trackUsage: vi.fn(),
  createStreamMetrics: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./ai', () => ({ streamAIResponse }));
vi.mock('./systemAgent', () => ({ resolveSystemAgent }));
vi.mock('../repositories', () => ({
  getSettingsRepository: () => settingsRepo,
  getChannelRepository: () => channelRepo,
}));
vi.mock('./contextBudget', () => ({ estimateMessageTokens }));
vi.mock('./streamEventRouter', () => ({
  emitAgentSpend,
  trackUsage,
  createStreamMetrics,
}));

import { maybeCompactHistory, summarySection } from './compaction';
import type { Agent } from '../types';

const agent = { id: 'a1', name: 'Ada', provider: 'anthropic', model: 'm' } as Agent;

describe('summarySection', () => {
  it('wraps the summary for system-prompt injection', () => {
    const s = summarySection('We decided on Postgres.');
    expect(s).toContain('Earlier conversation (summarized)');
    expect(s).toContain('We decided on Postgres.');
  });
});

describe('maybeCompactHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSystemAgent.mockReturnValue(agent);
    // Default: each message costs 100 tokens
    estimateMessageTokens.mockReturnValue(100);
  });

  it('returns unchanged when messages are empty', async () => {
    const r = await maybeCompactHistory({
      agent,
      channelId: 'ch',
      messages: [],
      messageBudget: 1000,
    });
    expect(r).toEqual({ messages: [], didCompact: false });
  });

  it.each(['off', 'manual'] as const)('skips auto-compact when compactionMode=%s (unless force)', async (mode) => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    estimateMessageTokens.mockReturnValue(1000);
    const r = await maybeCompactHistory({
      agent: { ...agent, compactionMode: mode },
      channelId: 'ch',
      messages,
      messageBudget: 100,
    });
    expect(r.didCompact).toBe(false);
    expect(r.messages).toBe(messages);
    expect(streamAIResponse).not.toHaveBeenCalled();
  });

  it('returns as-is when under budget', async () => {
    estimateMessageTokens.mockReturnValue(10);
    const messages = [{ role: 'user', content: 'hi' }];
    const r = await maybeCompactHistory({
      agent,
      channelId: 'ch',
      messages,
      messageBudget: 1000,
    });
    expect(r).toEqual({ messages, didCompact: false });
    expect(streamAIResponse).not.toHaveBeenCalled();
  });

  it('summarizes aged history when over budget', async () => {
    // 5 messages × 100 = 500 tokens; budget 150 → keep ~75 tokens (~1 msg), age 4
    estimateMessageTokens.mockReturnValue(100);
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
      name: `id-${i}`,
    }));

    streamAIResponse.mockImplementation(async function* () {
      yield 'Summary of earlier turns.';
      yield { type: 'usage-total', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      return 'Summary of earlier turns.';
    });

    const onCompacting = vi.fn();
    const r = await maybeCompactHistory({
      agent,
      channelId: 'ch-1',
      messages,
      messageBudget: 150,
      onCompacting,
    });

    expect(r.didCompact).toBe(true);
    expect(r.summary).toBe('Summary of earlier turns.');
    expect(r.messages.length).toBeLessThan(messages.length);
    expect(channelRepo.setContextSummary).toHaveBeenCalledWith(
      'ch-1',
      'Summary of earlier turns.',
      expect.any(String),
    );
    expect(onCompacting).toHaveBeenCalledWith('start');
    expect(onCompacting).toHaveBeenCalledWith('end');
    expect(emitAgentSpend).toHaveBeenCalled();
  });

  it('force overrides compactionMode off', async () => {
    estimateMessageTokens.mockReturnValue(100);
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'new' },
    ];
    streamAIResponse.mockImplementation(async function* () {
      yield 'forced';
      return 'forced';
    });

    const r = await maybeCompactHistory({
      agent: { ...agent, compactionMode: 'off' },
      channelId: 'ch',
      messages,
      messageBudget: 50,
      force: true,
    });
    expect(r.didCompact).toBe(true);
    expect(r.summary).toBe('forced');
  });

  it('falls back to full history when summary is empty or throws', async () => {
    estimateMessageTokens.mockReturnValue(100);
    const messages = Array.from({ length: 4 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));

    streamAIResponse.mockImplementation(async function* () {
      yield '   ';
      return '   ';
    });
    const empty = await maybeCompactHistory({
      agent,
      channelId: 'ch',
      messages,
      messageBudget: 100,
    });
    expect(empty.didCompact).toBe(false);
    expect(empty.messages).toBe(messages);

    streamAIResponse.mockImplementation(async function* () {
      throw new Error('summarizer down');
    });
    const failed = await maybeCompactHistory({
      agent,
      channelId: 'ch',
      messages,
      messageBudget: 100,
    });
    expect(failed.didCompact).toBe(false);
    expect(failed.messages).toBe(messages);
  });

  it('renders array content parts when summarizing', async () => {
    estimateMessageTokens.mockReturnValue(100);
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part A' },
          { type: 'image', url: 'x' },
          { type: 'text', text: 'part B' },
        ],
      },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'recent' },
    ];
    streamAIResponse.mockImplementation(async function* () {
      yield 'sum';
      return 'sum';
    });
    await maybeCompactHistory({
      agent,
      channelId: 'ch',
      messages,
      messageBudget: 100,
    });
    // First call arg: the userContent includes rendered aged messages
    const call = streamAIResponse.mock.calls[0];
    const userMsg = call[2][0].content as string;
    expect(userMsg).toContain('part A');
    expect(userMsg).toContain('part B');
  });
});
