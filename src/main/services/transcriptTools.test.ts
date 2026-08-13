import { describe, it, expect, vi, beforeEach } from 'vitest';

const { transcriptRepo, summarizeTranscript } = vi.hoisted(() => ({
  transcriptRepo: {
    search: vi.fn(),
    readAround: vi.fn(),
    participatingChannels: vi.fn(),
  },
  summarizeTranscript: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../repositories', () => ({
  getTranscriptSearchRepository: () => transcriptRepo,
}));

vi.mock('./transcriptSummary', () => ({ summarizeTranscript }));

import { createTranscriptTools } from './transcriptTools';

const exec = async (tool: { execute?: (...args: any[]) => any }, args: unknown) =>
  tool.execute!(args as never, {} as never);

const AGENT = 'agent-1';

function hit(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'm-1',
    channelId: 'ch-1',
    channelName: 'Engineering',
    channelType: 'public',
    sender: 'Aria',
    senderType: 'agent',
    content: 'we chose sqlite',
    timestamp: 1_700_000_000_000,
    score: -3.2,
    before: [],
    after: [],
    ...overrides,
  };
}

describe('createTranscriptTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('search_conversations', () => {
    it('passes the calling agent and options through to the repository', async () => {
      transcriptRepo.search.mockReturnValue([]);
      const tools = createTranscriptTools(AGENT);

      await exec(tools.search_conversations, {
        query: 'sqlite', limit: 5, contextBefore: 1, contextAfter: 3, channelId: 'ch-9',
      });

      expect(transcriptRepo.search).toHaveBeenCalledWith(AGENT, 'sqlite', {
        limit: 5, contextBefore: 1, contextAfter: 3, channelId: 'ch-9',
      });
    });

    it('scopes to the calling agent even if another id is supplied in args', async () => {
      // The agent id is bound at tool construction, never taken from the model.
      transcriptRepo.search.mockReturnValue([]);
      const tools = createTranscriptTools(AGENT);

      await exec(tools.search_conversations, { query: 'x', agentId: 'agent-99' });

      expect(transcriptRepo.search).toHaveBeenCalledWith(AGENT, 'x', expect.any(Object));
    });

    it('returns hits with ISO timestamps and a stable shape', async () => {
      transcriptRepo.search.mockReturnValue([
        hit({
          before: [{ messageId: 'm-0', sender: 'Mike', senderType: 'human', content: 'which db?', timestamp: 1_700_000_000_000 }],
          after: [{ messageId: 'm-2', sender: 'Mike', senderType: 'human', content: 'good', timestamp: 1_700_000_002_000 }],
        }),
      ]);
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.search_conversations, { query: 'sqlite' });

      expect(result.success).toBe(true);
      expect(result.hitCount).toBe(1);
      expect(result.hits[0]).toMatchObject({
        messageId: 'm-1',
        channelId: 'ch-1',
        channelName: 'Engineering',
        conversationType: 'public',
        sender: 'Aria',
        content: 'we chose sqlite',
        timestamp: '2023-11-14T22:13:20.000Z',
      });
      expect(result.hits[0].before[0]).toEqual({
        messageId: 'm-0', sender: 'Mike', senderType: 'human',
        content: 'which db?', timestamp: '2023-11-14T22:13:20.000Z',
      });
      expect(result.hits[0].after[0].messageId).toBe('m-2');
    });

    it('does not leak the bm25 score to the model', async () => {
      // An internal ranking number is noise the model cannot act on, and it
      // invites bogus reasoning about "confidence".
      transcriptRepo.search.mockReturnValue([hit()]);
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.search_conversations, { query: 'sqlite' });
      expect(result.hits[0]).not.toHaveProperty('score');
    });

    it('explains how to recover when nothing matched', async () => {
      transcriptRepo.search.mockReturnValue([]);
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.search_conversations, { query: 'nothing' });

      expect(result).toMatchObject({ success: true, hitCount: 0, hits: [] });
      expect(result.note).toMatch(/list_my_conversations/);
    });
  });

  describe('read_conversation_at', () => {
    it('returns the window around the target', async () => {
      transcriptRepo.readAround.mockReturnValue({
        channelId: 'ch-1',
        channelName: 'Engineering',
        target: 'm-5',
        messages: [
          { messageId: 'm-4', sender: 'Mike', senderType: 'human', content: 'a', timestamp: 1_700_000_000_000 },
          { messageId: 'm-5', sender: 'Aria', senderType: 'agent', content: 'b', timestamp: 1_700_000_001_000 },
        ],
      });
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.read_conversation_at, { messageId: 'm-5', before: 1, after: 1 });

      expect(transcriptRepo.readAround).toHaveBeenCalledWith(AGENT, 'm-5', { before: 1, after: 1 });
      expect(result).toMatchObject({ success: true, channelId: 'ch-1', target: 'm-5', messageCount: 2 });
      expect(result.messages.map((m: { messageId: string }) => m.messageId)).toEqual(['m-4', 'm-5']);
    });

    it('gives one indistinguishable error for missing and forbidden messages', async () => {
      // A different message for "exists but not yours" would let an agent probe
      // for conversations it cannot read.
      transcriptRepo.readAround.mockReturnValue(null);
      const tools = createTranscriptTools(AGENT);

      const missing = await exec(tools.read_conversation_at, { messageId: 'nope' });
      const forbidden = await exec(tools.read_conversation_at, { messageId: 'm-secret' });

      expect(missing).toEqual({
        success: false,
        error: 'No such message in any conversation you participate in',
      });
      expect(forbidden).toEqual(missing);
    });
  });

  describe('summarize_conversation_at', () => {
    const page = {
      channelId: 'ch-1',
      channelName: 'Engineering',
      target: 'm-5',
      messages: [
        { messageId: 'm-4', sender: 'Mike', senderType: 'human', content: 'a', timestamp: 1_700_000_000_000 },
        { messageId: 'm-5', sender: 'Aria', senderType: 'agent', content: 'b', timestamp: 1_700_000_001_000 },
      ],
    };

    it('reads a wider default window than read_conversation_at', async () => {
      // Summarising a ten-message window is pointless; the tool exists for
      // stretches big enough that condensing pays for itself.
      transcriptRepo.readAround.mockReturnValue(page);
      summarizeTranscript.mockResolvedValue({ status: 'summarized', summary: 's', messageCount: 2, charsIn: 9000 });
      const tools = createTranscriptTools(AGENT);

      await exec(tools.summarize_conversation_at, { messageId: 'm-5' });

      expect(transcriptRepo.readAround).toHaveBeenCalledWith(AGENT, 'm-5', { before: 25, after: 25 });
    });

    it('returns the summary and flags that it is not a transcript', async () => {
      transcriptRepo.readAround.mockReturnValue(page);
      summarizeTranscript.mockResolvedValue({
        status: 'summarized', summary: 'they chose the queue design', messageCount: 2, charsIn: 9000,
      });
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.summarize_conversation_at, { messageId: 'm-5', focus: 'the queue' });

      expect(summarizeTranscript).toHaveBeenCalledWith({
        channelName: 'Engineering', messages: page.messages, focus: 'the queue',
      });
      expect(result).toMatchObject({
        success: true,
        summarized: true,
        summary: 'they chose the queue design',
        channelName: 'Engineering',
        target: 'm-5',
      });
      expect(result.note).toMatch(/read_conversation_at/);
      expect(result).not.toHaveProperty('messages');
    });

    it('falls back to the transcript when the stretch is too short to be worth a call', async () => {
      transcriptRepo.readAround.mockReturnValue(page);
      summarizeTranscript.mockResolvedValue({ status: 'too-short', reason: 'only 40 characters' });
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.summarize_conversation_at, { messageId: 'm-5' });

      // Declining to spend is not a reason to answer with nothing.
      expect(result).toMatchObject({ success: true, summarized: false, reason: 'only 40 characters' });
      expect(result.messages.map((m: { messageId: string }) => m.messageId)).toEqual(['m-4', 'm-5']);
    });

    it('falls back to the transcript when the summary call is unavailable', async () => {
      transcriptRepo.readAround.mockReturnValue(page);
      summarizeTranscript.mockResolvedValue({ status: 'unavailable', reason: 'The summary call failed' });
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.summarize_conversation_at, { messageId: 'm-5' });

      expect(result).toMatchObject({ success: true, summarized: false, reason: 'The summary call failed' });
      expect(result.messages).toHaveLength(2);
    });

    it('stops summarizing after a per-turn cap and hands back the transcript', async () => {
      // The cache cannot stop a loop that varies `focus` — every variation is a
      // real cache miss and a real model call. This is the backstop.
      transcriptRepo.readAround.mockReturnValue(page);
      summarizeTranscript.mockResolvedValue({ status: 'summarized', summary: 's', messageCount: 2, charsIn: 9000 });
      const tools = createTranscriptTools(AGENT);

      for (let i = 0; i < 5; i++) {
        const ok = await exec(tools.summarize_conversation_at, { messageId: 'm-5', focus: `angle ${i}` });
        expect(ok.summarized).toBe(true);
      }
      expect(summarizeTranscript).toHaveBeenCalledTimes(5);

      const capped = await exec(tools.summarize_conversation_at, { messageId: 'm-5', focus: 'angle 6' });

      expect(capped).toMatchObject({ success: true, summarized: false });
      expect(capped.reason).toMatch(/this turn/);
      expect(capped.messages).toHaveLength(2);
      expect(summarizeTranscript).toHaveBeenCalledTimes(5);
    });

    it('counts only successful summaries against the cap', async () => {
      // A stretch too short to summarize cost nothing, so it must not consume
      // the budget for one that would have been worth it.
      transcriptRepo.readAround.mockReturnValue(page);
      summarizeTranscript.mockResolvedValue({ status: 'too-short', reason: 'too short' });
      const tools = createTranscriptTools(AGENT);

      for (let i = 0; i < 8; i++) {
        await exec(tools.summarize_conversation_at, { messageId: 'm-5', focus: `angle ${i}` });
      }

      summarizeTranscript.mockResolvedValue({ status: 'summarized', summary: 's', messageCount: 2, charsIn: 9000 });
      const result = await exec(tools.summarize_conversation_at, { messageId: 'm-5' });
      expect(result.summarized).toBe(true);
    });

    it('gives each turn its own budget', async () => {
      transcriptRepo.readAround.mockReturnValue(page);
      summarizeTranscript.mockResolvedValue({ status: 'summarized', summary: 's', messageCount: 2, charsIn: 9000 });

      const firstTurn = createTranscriptTools(AGENT);
      for (let i = 0; i < 6; i++) {
        await exec(firstTurn.summarize_conversation_at, { messageId: 'm-5', focus: `angle ${i}` });
      }

      // A fresh toolset is built per turn, so the counter resets with it.
      const secondTurn = createTranscriptTools(AGENT);
      const result = await exec(secondTurn.summarize_conversation_at, { messageId: 'm-5' });
      expect(result.summarized).toBe(true);
    });

    it('refuses a message outside the agent\'s conversations without calling the model', async () => {
      transcriptRepo.readAround.mockReturnValue(null);
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.summarize_conversation_at, { messageId: 'm-secret' });

      expect(result).toEqual({
        success: false,
        error: 'No such message in any conversation you participate in',
      });
      expect(summarizeTranscript).not.toHaveBeenCalled();
    });
  });

  describe('list_my_conversations', () => {
    it('lists the agent\'s conversations', async () => {
      transcriptRepo.participatingChannels.mockReturnValue([
        { id: 'ch-1', name: 'Engineering', type: 'public', messageCount: 12 },
        { id: 'ch-2', name: 'Mike', type: 'direct', messageCount: 3 },
      ]);
      const tools = createTranscriptTools(AGENT);

      const result = await exec(tools.list_my_conversations, {});

      expect(transcriptRepo.participatingChannels).toHaveBeenCalledWith(AGENT);
      expect(result).toEqual({
        success: true,
        conversationCount: 2,
        conversations: [
          { channelId: 'ch-1', name: 'Engineering', type: 'public', messageCount: 12 },
          { channelId: 'ch-2', name: 'Mike', type: 'direct', messageCount: 3 },
        ],
      });
    });

    it('handles an agent with no conversations', async () => {
      transcriptRepo.participatingChannels.mockReturnValue([]);
      const tools = createTranscriptTools(AGENT);

      expect(await exec(tools.list_my_conversations, {})).toEqual({
        success: true,
        conversationCount: 0,
        conversations: [],
      });
    });
  });
});
