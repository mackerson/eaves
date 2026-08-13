import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedAgent, seedChannel } from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./database', () => ({ getDatabase: vi.fn() }));

// The real repository, real SQL, real FTS — but built per call rather than via
// the cached singleton, which would otherwise hold the first test's closed
// database for the whole file.
vi.mock('../repositories', async () => {
  const actual = await vi.importActual<typeof import('../repositories/TranscriptSearchRepository')>(
    '../repositories/TranscriptSearchRepository',
  );
  return {
    getTranscriptSearchRepository: () => new actual.TranscriptSearchRepository(),
    getSettingsRepository: () => ({ get: () => ({}) }),
  };
});

// The summariser itself is real — only the model call underneath it is stubbed,
// so the threshold, the cache and the transcript fallback all run for real.
const { streamAIResponse } = vi.hoisted(() => ({ streamAIResponse: vi.fn() }));
vi.mock('./ai', () => ({ streamAIResponse }));
vi.mock('./systemAgent', () => ({
  resolveSystemAgent: () => ({ id: 'sys-1', name: 'System', provider: 'anthropic', model: 'claude-sonnet-4' }),
}));
vi.mock('./streamEventRouter', () => ({
  emitAgentSpend: vi.fn(),
  trackUsage: vi.fn(),
  createStreamMetrics: () => ({ inputTokens: 0, outputTokens: 0 }),
}));

import { createTranscriptTools } from './transcriptTools';
import { clearSummaryCache, MIN_CHARS_TO_SUMMARIZE } from './transcriptSummary';

/**
 * The unit tests either stub the repository (tools) or call it directly
 * (repository). This one runs the real chain — tool → repository → FTS5 →
 * SQLite — because the interesting failures live in the wiring: a default that
 * never reaches the query, a column that isn't selected, an id that doesn't
 * round-trip from a search hit into the follow-up read.
 */

const exec = async (tool: { execute?: (...args: any[]) => any }, args: unknown) =>
  tool.execute!(args as never, {} as never);

const AGENT = 'agent-1';
let clock = 1_700_000_000_000;

function say(db: Database.Database, channelId: string, who: string, content: string): string {
  clock += 1000;
  const id = `m-${clock}`;
  db.prepare(`
    INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name,
                          content, timestamp, is_draft, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active')
  `).run(id, channelId, who, who === 'Mike' ? 'human' : 'agent', who, content, clock);
  return id;
}

describe('transcript tools against a real database', () => {
  let db: Database.Database | null = null;
  let tools: ReturnType<typeof createTranscriptTools>;

  beforeEach(async () => {
    clock = 1_700_000_000_000;
    clearSummaryCache();
    streamAIResponse.mockReset();
    db = createTestDatabase();
    seedAgent(db, AGENT);
    seedChannel(db, 'ch-eng', { name: 'Engineering' });
    db.prepare(`
      INSERT INTO channel_participants (channel_id, participant_id, participant_type, joined_at)
      VALUES ('ch-eng', ?, 'agent', ?)
    `).run(AGENT, Date.now());

    const databaseModule = await import('./database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    tools = createTranscriptTools(AGENT);
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
  });

  it('searches, then pages outward from the hit it returned', async () => {
    say(db!, 'ch-eng', 'Mike', 'what did we land on for the oplog?');
    say(db!, 'ch-eng', 'Aria', 'we went with sqlite and a change table');
    say(db!, 'ch-eng', 'Mike', 'and conflict resolution?');
    say(db!, 'ch-eng', 'Aria', 'last write wins, ties broken on device id');
    say(db!, 'ch-eng', 'Mike', 'good enough');

    const found = await exec(tools.search_conversations, { query: 'conflict', contextAfter: 1 });

    expect(found.success).toBe(true);
    expect(found.hitCount).toBe(1);
    const hit = found.hits[0];
    expect(hit.content).toBe('and conflict resolution?');
    expect(hit.channelName).toBe('Engineering');
    expect(hit.after[0].content).toBe('last write wins, ties broken on device id');

    // The id from the hit must be usable verbatim in the follow-up read.
    const page = await exec(tools.read_conversation_at, { messageId: hit.messageId, before: 2, after: 2 });

    expect(page.success).toBe(true);
    expect(page.channelName).toBe('Engineering');
    expect(page.messages.map((m: { content: string }) => m.content)).toEqual([
      'what did we land on for the oplog?',
      'we went with sqlite and a change table',
      'and conflict resolution?',
      'last write wins, ties broken on device id',
      'good enough',
    ]);
  });

  it('finds a message written after the tools were built', async () => {
    // The index is trigger-driven, so recall must not depend on when the
    // toolset happened to be constructed for the turn.
    expect((await exec(tools.search_conversations, { query: 'ptarmigan' })).hitCount).toBe(0);
    say(db!, 'ch-eng', 'Aria', 'a note about the ptarmigan migration');
    expect((await exec(tools.search_conversations, { query: 'ptarmigan' })).hitCount).toBe(1);
  });

  it('lists the conversation and scopes a search to it', async () => {
    say(db!, 'ch-eng', 'Aria', 'the axolotl benchmark finished');

    const list = await exec(tools.list_my_conversations, {});
    expect(list.conversations).toEqual([
      { channelId: 'ch-eng', name: 'Engineering', type: 'public', messageCount: 1 },
    ]);

    const scoped = await exec(tools.search_conversations, {
      query: 'axolotl', channelId: list.conversations[0].channelId,
    });
    expect(scoped.hitCount).toBe(1);
  });

  it('refuses a message in a conversation the agent never joined', async () => {
    seedChannel(db!, 'ch-secret', { name: 'Secret' });
    const secretId = say(db!, 'ch-secret', 'Mike', 'the narwhal budget is confidential');

    expect((await exec(tools.search_conversations, { query: 'narwhal' })).hitCount).toBe(0);
    expect(await exec(tools.read_conversation_at, { messageId: secretId })).toEqual({
      success: false,
      error: 'No such message in any conversation you participate in',
    });
  });

  it('treats FTS5 syntax in a query as literal words, not operators', async () => {
    say(db!, 'ch-eng', 'Aria', 'zebra crossing');

    const result = await exec(tools.search_conversations, { query: 'NEAR("q" AND *' });
    expect(result.success).toBe(true);
    expect(result.hitCount).toBe(0);

    // The flip side, and the reason the above is 0 rather than an error: every
    // token is quoted into a prefix term, so an operator word is searched for
    // as a word. Note that makes it a *prefix* — a query of "AND" also finds
    // "andouille", which is the same behaviour any other token gets.
    say(db!, 'ch-eng', 'Aria', 'the AND gate finally works');
    expect((await exec(tools.search_conversations, { query: 'AND' })).hitCount).toBe(1);
  });

  it('hands back the transcript when a stretch is too short to be worth summarizing', async () => {
    const id = say(db!, 'ch-eng', 'Mike', 'short exchange, nothing to condense');

    const result = await exec(tools.summarize_conversation_at, { messageId: id });

    expect(result).toMatchObject({ success: true, summarized: false });
    expect(result.messages).toHaveLength(1);
    expect(streamAIResponse).not.toHaveBeenCalled();
  });

  it('summarizes a stretch long enough to pay for the call, and caches it', async () => {
    const filler = 'a genuinely long line of discussion about the queue design that carries detail. ';
    let anchor = '';
    for (let i = 0; i < 20; i++) {
      const id = say(db!, 'ch-eng', i % 2 ? 'Aria' : 'Mike', `${filler}${i}`);
      if (i === 10) anchor = id;
    }
    streamAIResponse.mockImplementation(async function* () { yield 'they chose the queue design'; });

    const first = await exec(tools.summarize_conversation_at, {
      messageId: anchor, focus: 'the queue design',
    });

    expect(first).toMatchObject({
      success: true, summarized: true, summary: 'they chose the queue design', channelName: 'Engineering',
    });
    expect(first).not.toHaveProperty('messages');

    // The excerpt the summariser saw must be the real window, over the threshold.
    const [, , messages] = streamAIResponse.mock.calls[0];
    expect(messages[0].content).toContain('the queue design');
    expect(messages[0].content.length).toBeGreaterThan(MIN_CHARS_TO_SUMMARIZE);

    // Same excerpt again is free.
    await exec(tools.summarize_conversation_at, { messageId: anchor, focus: 'the queue design' });
    expect(streamAIResponse).toHaveBeenCalledTimes(1);
  });
});