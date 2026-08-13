import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptMessage } from '../repositories/TranscriptSearchRepository';

const { streamAIResponse, resolveSystemAgent, emitAgentSpend, trackUsage, settingsGet } = vi.hoisted(() => ({
  streamAIResponse: vi.fn(),
  resolveSystemAgent: vi.fn(),
  emitAgentSpend: vi.fn(),
  trackUsage: vi.fn(),
  settingsGet: vi.fn(() => ({})),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./ai', () => ({ streamAIResponse }));
vi.mock('./systemAgent', () => ({ resolveSystemAgent }));
vi.mock('./streamEventRouter', () => ({
  emitAgentSpend,
  trackUsage,
  createStreamMetrics: () => ({ inputTokens: 0, outputTokens: 0 }),
}));
vi.mock('../repositories', () => ({
  getSettingsRepository: () => ({ get: settingsGet }),
}));

import {
  summarizeTranscript,
  clearSummaryCache,
  MIN_CHARS_TO_SUMMARIZE,
} from './transcriptSummary';

const AGENT = { id: 'sys-1', name: 'System', provider: 'anthropic', model: 'claude-sonnet-4' };

/** Enough text that summarising is worth a call. */
function longMessages(count = 12): TranscriptMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    messageId: `m-${i}`,
    sender: i % 2 ? 'Aria' : 'Mike',
    senderType: (i % 2 ? 'agent' : 'human') as TranscriptMessage['senderType'],
    content: `A sufficiently long message about the queue design, number ${i}, `
      + 'repeated to clear the minimum length that makes a summary worthwhile.',
    timestamp: 1_700_000_000_000 + i * 1000,
  }));
}

function streamOf(...chunks: string[]) {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

describe('summarizeTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSummaryCache();
    resolveSystemAgent.mockReturnValue(AGENT);
  });

  it('summarizes a long stretch and reports the spend', async () => {
    streamAIResponse.mockImplementation(streamOf('we chose ', 'the queue design'));

    const result = await summarizeTranscript({ channelName: 'Engineering', messages: longMessages() });

    expect(result).toMatchObject({ status: 'summarized', summary: 'we chose the queue design', messageCount: 12 });
    expect(emitAgentSpend).toHaveBeenCalledWith(AGENT, expect.anything(), { kind: 'transcript-summary' });
  });

  it('runs non-interactively so it cannot raise an approval prompt', async () => {
    // Nothing is watching a background recall call; a tool that could block on
    // approval here would hang the turn.
    streamAIResponse.mockImplementation(streamOf('summary'));

    await summarizeTranscript({ channelName: 'Engineering', messages: longMessages() });

    const options = streamAIResponse.mock.calls[0].at(-1);
    expect(options).toMatchObject({ nonInteractive: true, contextLabel: 'transcript-summary' });
  });

  it('declines to spend a model call on a short stretch', async () => {
    const result = await summarizeTranscript({
      channelName: 'Engineering',
      messages: [{
        messageId: 'm-1', sender: 'Mike', senderType: 'human',
        content: 'short', timestamp: 1,
      }],
    });

    expect(result.status).toBe('too-short');
    expect(streamAIResponse).not.toHaveBeenCalled();
    expect(emitAgentSpend).not.toHaveBeenCalled();
  });

  it('names the threshold it declined against', async () => {
    const result = await summarizeTranscript({
      channelName: 'Engineering',
      messages: [{ messageId: 'm-1', sender: 'Mike', senderType: 'human', content: 'tiny', timestamp: 1 }],
    });

    expect(result.status === 'too-short' && result.reason).toContain(String(MIN_CHARS_TO_SUMMARIZE));
  });

  it('passes the focus through to the model', async () => {
    streamAIResponse.mockImplementation(streamOf('summary'));

    await summarizeTranscript({
      channelName: 'Engineering',
      messages: longMessages(),
      focus: 'why we rejected the queue design',
    });

    const [, , messages] = streamAIResponse.mock.calls[0];
    expect(messages[0].content).toContain('why we rejected the queue design');
  });

  describe('caching', () => {
    it('reuses a summary for the same excerpt', async () => {
      streamAIResponse.mockImplementation(streamOf('cached summary'));
      const input = { channelName: 'Engineering', messages: longMessages() };

      const first = await summarizeTranscript(input);
      const second = await summarizeTranscript(input);

      expect(first).toEqual(second);
      expect(streamAIResponse).toHaveBeenCalledTimes(1);
    });

    it('re-summarizes when a message in the excerpt was edited', async () => {
      // The key is the content, not the ids — a stale summary of edited text is
      // worse than the call it saved.
      streamAIResponse.mockImplementation(streamOf('first'));
      const messages = longMessages();
      await summarizeTranscript({ channelName: 'Engineering', messages });

      const edited = messages.map((m, i) => (i === 0 ? { ...m, content: `${m.content} EDITED` } : m));
      streamAIResponse.mockImplementation(streamOf('second'));
      const result = await summarizeTranscript({ channelName: 'Engineering', messages: edited });

      expect(streamAIResponse).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ status: 'summarized', summary: 'second' });
    });

    it('re-summarizes when the focus changes', async () => {
      streamAIResponse.mockImplementation(streamOf('unfocused'));
      const messages = longMessages();
      await summarizeTranscript({ channelName: 'Engineering', messages });

      streamAIResponse.mockImplementation(streamOf('focused'));
      const result = await summarizeTranscript({ channelName: 'Engineering', messages, focus: 'the deadline' });

      expect(streamAIResponse).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ summary: 'focused' });
    });

    it('stays bounded as a long session accumulates summaries', async () => {
      let n = 0;
      streamAIResponse.mockImplementation(() => streamOf(`summary ${n++}`)());

      const inputs = Array.from({ length: 70 }, (_, i) => ({
        channelName: 'Engineering',
        messages: longMessages().map(m => ({ ...m, content: `${m.content} variant ${i}` })),
      }));
      for (const input of inputs) await summarizeTranscript(input);

      // The oldest entry must have been evicted, so it costs a fresh call.
      const callsBefore = streamAIResponse.mock.calls.length;
      await summarizeTranscript(inputs[0]);
      expect(streamAIResponse.mock.calls.length).toBe(callsBefore + 1);

      // ...while a recent one is still cached.
      await summarizeTranscript(inputs[69]);
      expect(streamAIResponse.mock.calls.length).toBe(callsBefore + 1);
    });
  });

  describe('failure paths', () => {
    it('reports unavailable when no system agent is configured', async () => {
      resolveSystemAgent.mockReturnValue(null);

      const result = await summarizeTranscript({ channelName: 'Engineering', messages: longMessages() });

      expect(result).toEqual({ status: 'unavailable', reason: 'No system agent is configured to run the summary' });
      expect(streamAIResponse).not.toHaveBeenCalled();
    });

    it('does not throw when the model call fails, and still reports the spend', async () => {
      // A half-finished call burned tokens. Swallowing the spend is how it goes
      // missing from the ledger.
      streamAIResponse.mockImplementation(async function* () {
        yield 'partial';
        throw new Error('upstream 502');
      });

      const result = await summarizeTranscript({ channelName: 'Engineering', messages: longMessages() });

      expect(result).toEqual({ status: 'unavailable', reason: 'The summary call failed' });
      expect(emitAgentSpend).toHaveBeenCalledWith(AGENT, expect.anything(), { kind: 'transcript-summary' });
    });

    it('treats an empty completion as unavailable rather than a valid summary', async () => {
      streamAIResponse.mockImplementation(streamOf('   '));

      const result = await summarizeTranscript({ channelName: 'Engineering', messages: longMessages() });

      expect(result).toEqual({ status: 'unavailable', reason: 'The summary came back empty' });
    });

    it('does not cache a failed call', async () => {
      streamAIResponse.mockImplementation(async function* () {
        throw new Error('upstream 502');
        // eslint-disable-next-line no-unreachable
        yield '';
      });
      const input = { channelName: 'Engineering', messages: longMessages() };
      await summarizeTranscript(input);

      streamAIResponse.mockImplementation(streamOf('recovered'));
      expect(await summarizeTranscript(input)).toMatchObject({ status: 'summarized', summary: 'recovered' });
    });
  });
});
