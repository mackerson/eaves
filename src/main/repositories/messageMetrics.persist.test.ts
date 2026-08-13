import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelRepository } from './ChannelRepository';
import { runMigrations } from '../services/migrations';
import { MessageMetricsObjectSchema } from '../../shared/validation';
import type { MessageMetrics } from '../types';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

/**
 * Metrics survival, end to end.
 *
 * The schema round-trip tests in shared/validation.test.ts check Zod in
 * isolation, which is not where the bug lived. `requestInfo` was lost because
 * the *renderer* save path runs the payload through Zod on the way to storage
 * while the main-process turn path does not — so a field missing from the
 * schema vanished on one path and survived on the other, and every unit test
 * of either half passed.
 *
 * These tests walk the whole path: validate as the IPC layer does, persist,
 * read back from SQLite, and compare. That is the only shape of test that
 * would have caught it.
 */
describe('message metrics persistence', () => {
  let db: Database.Database;
  let repository: ChannelRepository;
  let channelId: string;

  const fullMetrics: MessageMetrics = {
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    timeToComplete: 8123,
    finishReason: 'stop',
    model: 'claude-opus-5',
    cost: 0.0241,
    requestInfo: {
      contextWindow: 200000,
      sizeClass: 'large',
      systemPromptTokens: 151,
      messageBudget: 150000,
      messagesTotal: 40,
      messagesSent: 12,
      toolsIncluded: true,
      toolCount: 35,
    },
    servedProvider: 'GMICloud',
    cachedTokens: 8002,
    cacheWriteTokens: 1024,
  };

  const persistAndRead = (metrics: unknown): MessageMetrics | undefined => {
    repository.createMessage({
      channelId,
      senderId: 'agent-1',
      senderType: 'agent',
      senderDisplayName: 'Ally',
      content: 'done',
      timestamp: Date.now(),
      metrics: metrics as MessageMetrics,
    } as never);
    const messages = repository.getMessagesByChannelId(channelId);
    return messages[messages.length - 1].metrics;
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db, 0);
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repository = new ChannelRepository();
    channelId = repository.create({ name: 'metrics', type: 'public' }).id;
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('round-trips the full metrics shape through SQLite', () => {
    expect(persistAndRead(fullMetrics)).toEqual(fullMetrics);
  });

  // The renderer save path (addAgentMessage / addChatAgentMessage /
  // updateMessageContentBlocks) validates before persisting. This is the exact
  // sequence that used to drop requestInfo.
  it('survives the renderer save path — validate, then persist', () => {
    const validated = MessageMetricsObjectSchema.parse(fullMetrics);
    const read = persistAndRead(validated);

    expect(read).toEqual(fullMetrics);
    expect(read?.requestInfo?.toolCount).toBe(35);
    expect(read?.cacheWriteTokens).toBe(1024);
  });

  it('agrees between the validated and unvalidated paths', () => {
    // The regression was a *divergence* between the two paths, not a total
    // loss — asserting they match is what pins it.
    const viaMain = persistAndRead(fullMetrics);
    const viaRenderer = persistAndRead(MessageMetricsObjectSchema.parse(fullMetrics));
    expect(viaRenderer).toEqual(viaMain);
  });

  it('keeps the nested requestInfo intact rather than flattening it', () => {
    const read = persistAndRead(fullMetrics);
    expect(read?.requestInfo).toEqual(fullMetrics.requestInfo);
  });

  it('carries the debug system prompt when present', () => {
    const withPrompt: MessageMetrics = {
      ...fullMetrics,
      requestInfo: { ...fullMetrics.requestInfo!, systemPrompt: 'you are helpful' },
    };
    expect(persistAndRead(withPrompt)?.requestInfo?.systemPrompt).toBe('you are helpful');
  });

  it('handles a message with no metrics at all', () => {
    expect(persistAndRead(undefined)).toBeUndefined();
  });

  it('handles a sparse turn that never reported cache or provider data', () => {
    const sparse: MessageMetrics = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const read = persistAndRead(MessageMetricsObjectSchema.parse(sparse));
    expect(read).toEqual(sparse);
    expect(read?.cachedTokens).toBeUndefined();
  });

  /**
   * usageIsTotal is StreamMetrics-only bookkeeping — true once the SDK's
   * summed whole-turn usage lands. The turn paths hand their StreamMetrics
   * object straight to the repository, so it currently reaches storage on the
   * main path and is stripped on the renderer path.
   *
   * Pinned rather than asserted-away: this documents the asymmetry as known
   * and would fail if someone made the two paths agree without deciding which
   * way they should agree.
   */
  it('pins usageIsTotal: reaches storage unvalidated, stripped when validated', () => {
    const withFlag = { ...fullMetrics, usageIsTotal: true };

    expect((persistAndRead(withFlag) as Record<string, unknown>).usageIsTotal).toBe(true);

    const validated = MessageMetricsObjectSchema.parse(withFlag);
    expect((persistAndRead(validated) as Record<string, unknown>).usageIsTotal).toBeUndefined();
  });
});
