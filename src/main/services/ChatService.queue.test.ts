/**
 * Per-chat turn queueing.
 *
 * The behavior this replaces: a second request for a chat already running a
 * turn aborted the first. With two surfaces on one conversation (desktop and
 * a messaging bridge) that meant whoever typed second cut the other off
 * mid-sentence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock factories are hoisted above plain consts — vi.hoisted keeps the
// spy defined by the time the factory runs.
const { runAgentTurn } = vi.hoisted(() => ({ runAgentTurn: vi.fn() }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/enclave-test', isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));
vi.mock('./AgentTurnService', () => ({ runAgentTurn }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('./streamEventRouter', () => ({
  createStreamMetrics: () => ({}),
  emitStreamSentinel: vi.fn(),
}));
vi.mock('../utils/aiErrors', () => ({
  friendlyAIErrorMessage: (e: Error) => e.message,
  summarizeProviderError: () => ({}),
}));

const channelRepo = vi.hoisted(() => ({
  getDirectChatById: vi.fn(() => ({ id: 'c1' })),
  createDirectMessage: vi.fn(),
  getConversationById: vi.fn(),
  getTagUsage: vi.fn(() => []),
  update: vi.fn(),
}));
const toolStateRepo = vi.hoisted(() => ({ delete: vi.fn() }));
const settingsRepo = vi.hoisted(() => ({
  get: vi.fn(() => ({})),
  getCurrentState: vi.fn(() => ({ projectId: 'p1' })),
}));
const projectRepo = vi.hoisted(() => ({
  getById: vi.fn(() => ({ id: 'p1', name: 'P' })),
}));
const agentRepo = vi.hoisted(() => ({
  getById: vi.fn((id: string) => ({ id, name: 'A', provider: 'anthropic', model: 'm' })),
}));

vi.mock('../repositories', () => ({
  getSettingsRepository: () => settingsRepo,
  getProjectRepository: () => projectRepo,
  getAgentRepository: () => agentRepo,
  getChannelRepository: () => channelRepo,
  getToolStateRepository: () => toolStateRepo,
}));

vi.mock('./approvalResume', () => ({
  closeSupersededApprovals: vi.fn().mockResolvedValue(undefined),
}));

import { ChatService } from './ChatService';

/**
 * Poll until `check` passes. chatWithAgent does async setup (toolset build,
 * dynamic imports) before reaching runAgentTurn, so a fixed number of ticks
 * is not a reliable "has it started yet" signal.
 */
async function waitFor(check: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A turn that finishes only when its returned `finish` is called. */
function deferredTurn() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  return { gate, finish };
}

describe('ChatService turn queueing', () => {
  let service: ChatService;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but leaves queued mockImplementationOnce
    // entries in place, and these tests deliberately leave some unconsumed —
    // 'drops turns queued behind a stopped one' passes precisely because its
    // second implementation never runs. A leftover shifts every subsequent
    // test's implementations by one: the turn meant to block lands on the call
    // meant to return immediately, and the test deadlocks on a gate nothing
    // will open. It only ever passed because the next test happened to absorb
    // the spare; reordering the file broke it. mockReset drains the queue.
    runAgentTurn.mockReset();
    service = new ChatService(() => null);
  });

  it('runs a second turn after the first instead of aborting it', async () => {
    const order: string[] = [];
    const first = deferredTurn();

    runAgentTurn
      .mockImplementationOnce(async () => {
        order.push('first:start');
        await first.gate;
        order.push('first:end');
        return { turnId: '1', status: 'completed', response: 'a', contentBlocks: [] };
      })
      .mockImplementationOnce(async () => {
        order.push('second:start');
        return { turnId: '2', status: 'completed', response: 'b', contentBlocks: [] };
      });

    const a = service.chatWithAgent('c1', 'a1');
    await waitFor(() => order.includes('first:start'), 'first turn to start');

    const b = service.chatWithAgent('c1', 'a1');
    // Give the second every chance to jump the queue before asserting it didn't.
    await new Promise((r) => setTimeout(r, 50));

    // The second turn must not have started while the first is still running.
    expect(order).toEqual(['first:start']);

    first.finish();
    const [ra, rb] = await Promise.all([a, b]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(ra.success).toBe(true);
    expect(rb.success).toBe(true);
  });

  it('rejects past the queue ceiling rather than stacking silently', async () => {
    const first = deferredTurn();
    runAgentTurn.mockImplementation(async () => {
      await first.gate;
      return { turnId: 'x', status: 'completed', response: '', contentBlocks: [] };
    });

    const running = service.chatWithAgent('c1', 'a1');
    await waitFor(() => runAgentTurn.mock.calls.length === 1, 'first turn to start');

    const queued = Array.from({ length: 5 }, () => service.chatWithAgent('c1', 'a1'));
    await new Promise((r) => setTimeout(r, 20));

    const overflow = await service.chatWithAgent('c1', 'a1');
    expect(overflow.success).toBe(false);
    expect(overflow.error).toMatch(/queued turns/i);

    first.finish();
    await Promise.all([running, ...queued]);
  });

  // The bug this guards: the stopped turn's own cleanup ran BEFORE the queued
  // turn resumed, so clearing the cancellation flag there let the queued turn
  // wake to an already-erased flag and run anyway.
  it('drops turns queued behind a stopped one', async () => {
    const first = deferredTurn();
    let secondStarted = false;

    runAgentTurn
      .mockImplementationOnce(async () => {
        await first.gate;
        return { turnId: '1', status: 'aborted', response: '', contentBlocks: [] };
      })
      .mockImplementationOnce(async () => {
        secondStarted = true;
        return { turnId: '2', status: 'completed', response: '', contentBlocks: [] };
      });

    const a = service.chatWithAgent('c1', 'a1');
    await waitFor(() => runAgentTurn.mock.calls.length === 1, 'first turn to start');
    const b = service.chatWithAgent('c1', 'a1');
    await new Promise((r) => setTimeout(r, 20));

    await service.stopStream('c1');
    first.finish();

    const [, rb] = await Promise.all([a, b]);
    expect(secondStarted).toBe(false);
    expect(rb.aborted).toBe(true);
  });

  // A stop must not poison the chat forever — the next message still runs.
  it('accepts a new turn after a stopped chain has drained', async () => {
    const first = deferredTurn();
    runAgentTurn
      .mockImplementationOnce(async () => {
        await first.gate;
        return { turnId: '1', status: 'aborted', response: '', contentBlocks: [] };
      })
      .mockImplementation(async () => ({ turnId: 'n', status: 'completed', response: 'ok', contentBlocks: [] }));

    const a = service.chatWithAgent('c1', 'a1');
    await waitFor(() => runAgentTurn.mock.calls.length === 1, 'first turn to start');
    const b = service.chatWithAgent('c1', 'a1');
    await new Promise((r) => setTimeout(r, 20));
    await service.stopStream('c1');
    first.finish();
    await Promise.all([a, b]);

    const fresh = await service.chatWithAgent('c1', 'a1');
    expect(fresh.success).toBe(true);
  });

  it('keeps separate chats independent', async () => {
    const held = deferredTurn();
    runAgentTurn
      .mockImplementationOnce(async () => {
        await held.gate;
        return { turnId: '1', status: 'completed', response: '', contentBlocks: [] };
      })
      .mockImplementationOnce(async () => ({ turnId: '2', status: 'completed', response: '', contentBlocks: [] }));

    const blocked = service.chatWithAgent('c1', 'a1');
    await waitFor(() => runAgentTurn.mock.calls.length === 1, 'first turn to start');

    // A different chat must not wait on c1's turn.
    const other = await service.chatWithAgent('c2', 'a1');
    expect(other.success).toBe(true);

    held.finish();
    await blocked;
  });

  it('maps aborted / error turn statuses into IPC envelopes', async () => {
    runAgentTurn.mockResolvedValueOnce({
      turnId: '1',
      status: 'aborted',
      response: '',
      contentBlocks: [],
    });
    expect(await service.chatWithAgent('c1', 'a1')).toMatchObject({
      success: false,
      aborted: true,
    });

    runAgentTurn.mockResolvedValueOnce({
      turnId: '2',
      status: 'error',
      errorMessage: 'provider down',
      response: '',
      contentBlocks: [],
    });
    expect(await service.chatWithAgent('c1', 'a1')).toEqual({
      success: false,
      error: 'provider down',
    });
  });

  it('threads branchOverride into runAgentTurn for regenerate', async () => {
    runAgentTurn.mockResolvedValue({
      turnId: '1',
      status: 'completed',
      response: 'regen',
      contentBlocks: [],
    });
    const branchOverride = { parentMessageId: 'p1', branchIndex: 3 };
    await service.chatWithAgent('c1', 'a1', { branchOverride });
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: 'c1',
        persistence: 'chat-assistant',
        branchOverride,
      }),
      expect.objectContaining({ toolStates: expect.any(Map) }),
    );
  });

  it('failBeforeTurn when project or agent is missing', async () => {
    projectRepo.getById.mockReturnValueOnce(null);
    const noProject = await service.chatWithAgent('c1', 'a1');
    expect(noProject.success).toBe(false);
    expect(noProject.error).toMatch(/No active project/i);
    expect(channelRepo.createDirectMessage).toHaveBeenCalled(); // agent resolved → error notice

    agentRepo.getById.mockReturnValueOnce(null);
    projectRepo.getById.mockReturnValue({ id: 'p1', name: 'P' });
    const noAgent = await service.chatWithAgent('c1', 'missing');
    expect(noAgent.success).toBe(false);
    expect(noAgent.error).toMatch(/Agent not found/i);
    // No agent → no in-chat notice row
  });

  it('stopStream aborts active controller; clearChatState aborts and clears tool state', async () => {
    const first = deferredTurn();
    runAgentTurn.mockImplementationOnce(async (req: { abortSignal: AbortSignal }) => {
      await first.gate;
      return {
        turnId: '1',
        status: req.abortSignal.aborted ? 'aborted' : 'completed',
        response: '',
        contentBlocks: [],
      };
    });

    const running = service.chatWithAgent('c1', 'a1');
    await waitFor(() => runAgentTurn.mock.calls.length === 1, 'turn start');

    expect(await service.stopStream('c1')).toEqual({ success: true });
    expect(await service.stopStream('c1')).toEqual({
      success: false,
      error: 'No active stream found',
    });
    first.finish();
    await running;

    service.clearChatState('c1');
    expect(toolStateRepo.delete).toHaveBeenCalledWith('c1');
  });
});
