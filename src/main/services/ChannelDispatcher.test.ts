import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Characterization tests for the ChannelDispatcher dispatch contract
// (ADR-001 Decision 2): dispatch is an explicit requestDispatch(intent) call,
// and nothing on the EventBus starts a turn. The message:created /
// message:updated emissions below are negative controls — they pin that
// storage events stay dispatch-inert.

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  // Attachment loaders resolve the store directory via app.getPath at turn
  // time.
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// AI/stream boundary — the dispatcher's only observable "a dispatch happened"
// side effects are runStream + channelRepo.createMessage.
const runStream = vi.fn();
const buildToolset = vi.fn();
const buildSystemPrompt = vi.fn();
vi.mock('../ipc/chatHelpers', () => ({
  runStream: (...args: unknown[]) => runStream(...args),
  buildToolset: (...args: unknown[]) => buildToolset(...args),
  buildSystemPrompt: (...args: unknown[]) => buildSystemPrompt(...args),
  // Always a callable — the real activeToolsFor gates unconditionally now and
  // its return type is non-optional, so a mock yielding undefined would be
  // asserting a contract the production code no longer has.
  activeToolsFor: vi.fn(() => () => []),
  // Pure wiring from toolset+budget; buildSystemPrompt is stubbed anyway.
  systemPromptPlumbing: () => ({}),
  buildRequestInfo: vi.fn(() => ({
    contextWindow: 0,
    sizeClass: 'large',
    systemPromptTokens: 0,
    messageBudget: 0,
    messagesTotal: 0,
    messagesSent: 0,
    toolsIncluded: false,
    toolCount: 0,
  })),
}));

const channelRepo = {
  getById: vi.fn(),
  createMessage: vi.fn(),
  updateMessageContentBlocks: vi.fn(),
  addParticipant: vi.fn(),
  deleteMessage: vi.fn(),
};
const agentRepo = { getById: vi.fn() };
const settingsRepo = { get: vi.fn(), getCurrentState: vi.fn() };
const projectRepo = { getById: vi.fn() };
// The channel history builder constructs attachment loaders per turn — the
// repository accessor must exist even though these fixtures carry no
// file-service:// blocks.
const attachmentRepo = { getById: vi.fn(() => null), getByAssetPointer: vi.fn(() => null) };
vi.mock('../repositories', () => ({
  getChannelRepository: () => channelRepo,
  getAgentRepository: () => agentRepo,
  getSettingsRepository: () => settingsRepo,
  getProjectRepository: () => projectRepo,
  getMessageAttachmentRepository: () => attachmentRepo,
}));

vi.mock('./MessageFormatter', () => ({
  MessageFormatter: { formatMessages: vi.fn(() => ({ messages: [], systemPrompt: 'SYS' })) },
}));
vi.mock('../utils/perspectiveShift', () => ({
  perspectiveShiftMessages: (messages: unknown[]) => messages,
}));
vi.mock('../utils/stickyProvider', () => ({
  resolveStickyProvider: () => undefined,
}));
vi.mock('../utils/aiErrors', () => ({
  friendlyAIErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('./compaction', () => ({
  maybeCompactHistory: async ({ messages }: { messages: unknown[] }) => ({ messages, summary: null }),
  summarySection: () => '',
}));
vi.mock('./streamEventRouter', () => ({
  emitCompaction: vi.fn(),
  emitStreamAborted: vi.fn(),
}));
const testBudget = {
  contextWindow: 8192,
  sizeClass: 'standard',
  systemPromptBudget: 2000,
  messageBudget: 4000,
};
vi.mock('./contextBudget', () => ({
  computeContextBudget: () => testBudget,
  // The turn paths call resolveTurnBudget (detect-then-compute); it must
  // resolve to the same shape computeContextBudget would.
  resolveTurnBudget: async () => testBudget,
  windowMessages: (messages: unknown[]) => messages,
  estimateTokens: () => 42,
}));
vi.mock('./modelContext', () => ({
  detectModelContext: async () => null,
  resolveDetectEndpoint: () => undefined,
}));
vi.mock('./PendingApprovalRegistry', () => ({
  getPendingApprovalRegistry: () => ({ register: vi.fn() }),
}));

import { ChannelDispatcher, type DispatchIntent } from './ChannelDispatcher';
import { eventBus } from './EventBus';
import { logger } from './logger';

const CHANNEL_ID = 'ch-1';
const ALLY = 'agent-ally';
const WATCHER = 'agent-watcher';
const HUMAN = 'user-1';

type AgentFixture = {
  id: string;
  name: string;
  provider: string;
  model: string;
  color: string;
  channelBehavior: { respondTo: 'mentions-only' | 'all'; verbosity: 'brief' | 'normal' | 'verbose' };
};

let agents: Record<string, AgentFixture>;
let messageSeq: number;

function makeChannel() {
  return {
    id: CHANNEL_ID,
    name: 'test-channel',
    type: 'project' as const,
    projectId: 'proj-1',
    participants: [
      { id: HUMAN, type: 'human' as const, displayName: 'Robin', joinedAt: 0 },
      { id: ALLY, type: 'agent' as const, displayName: 'Ally', joinedAt: 0 },
      { id: WATCHER, type: 'agent' as const, displayName: 'Watcher', joinedAt: 0 },
    ],
    messages: [],
    createdAt: 0,
  };
}

// A human channel send at chain root — the shape 'send-message' produces.
function makeIntent(overrides: Partial<DispatchIntent> = {}): DispatchIntent {
  return {
    channelId: CHANNEL_ID,
    triggerMessageId: `msg-${++messageSeq}`,
    triggerContent: 'hello',
    senderId: HUMAN,
    senderType: 'human',
    chainDepth: 0,
    ...overrides,
  };
}

// Mirrors the exact channel-shaped, non-draft payload
// ChannelRepository.createMessage emits — the forged-event shape from #39.
function emitCreated(overrides: Record<string, unknown> = {}): string {
  const id = `msg-${++messageSeq}`;
  eventBus.emitEvent('message:created', {
    id,
    channelId: CHANNEL_ID,
    senderId: HUMAN,
    senderType: 'human',
    senderDisplayName: 'Robin',
    content: 'hello',
    timestamp: Date.now(),
    metadata: {},
    context: 'channel',
    isDraft: false,
    ...overrides,
  });
  return (overrides.id as string) ?? id;
}

// Mirrors the exact payload ChannelRepository.updateMessageContentBlocks emits
// on the is_draft 1→0 transition: draftFinalized flag, no isDraft field.
function emitUpdated(overrides: Record<string, unknown> = {}): string {
  const id = `msg-${++messageSeq}`;
  eventBus.emitEvent('message:updated', {
    id,
    channelId: CHANNEL_ID,
    senderId: WATCHER,
    senderType: 'agent',
    senderDisplayName: 'Watcher',
    content: 'done',
    metadata: {},
    context: 'channel',
    draftFinalized: true,
    ...overrides,
  });
  return (overrides.id as string) ?? id;
}

// Let any stray async work (chained intents, would-be bus handlers) drain so
// negative assertions ("did NOT dispatch") are meaningful.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

const dispatched = () => runStream.mock.calls.map((call) => (call[0] as { agent: AgentFixture }).agent.id);

describe('ChannelDispatcher', () => {
  let dispatcher: ChannelDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    messageSeq = 0;
    agents = {
      [ALLY]: {
        id: ALLY, name: 'Ally', provider: 'anthropic', model: 'test-model', color: '#f00',
        channelBehavior: { respondTo: 'mentions-only', verbosity: 'brief' },
      },
      [WATCHER]: {
        id: WATCHER, name: 'Watcher', provider: 'anthropic', model: 'test-model', color: '#0f0',
        channelBehavior: { respondTo: 'mentions-only', verbosity: 'brief' },
      },
    };
    channelRepo.getById.mockImplementation(() => makeChannel());
    channelRepo.createMessage.mockImplementation((message: Record<string, unknown>) => ({ id: `agent-msg-${++messageSeq}`, ...message }));
    agentRepo.getById.mockImplementation((id: string) => agents[id] ?? null);
    settingsRepo.get.mockReturnValue({ userName: 'Robin' });
    settingsRepo.getCurrentState.mockReturnValue({ projectId: 'proj-1' });
    projectRepo.getById.mockReturnValue({ id: 'proj-1', name: 'Test Project' });
    buildToolset.mockResolvedValue({
      enabledTools: {},
      projectDirectories: [],
      builtinToolCount: 0,
      mcpToolCount: 0,
      totalToolCount: 0,
    });
    buildSystemPrompt.mockResolvedValue('SYSTEM');
    runStream.mockResolvedValue({
      response: 'ack',
      contentBlocks: [],
      metrics: { duration: 1 },
      responseMessages: [],
    });

    dispatcher = new ChannelDispatcher(() => null);
    dispatcher.start();
  });

  afterEach(() => {
    dispatcher.stop();
  });

  describe('EventBus is storage-only (ADR-001 Decision 3, anti-#39)', () => {
    it('a channel-shaped non-draft message:created never dispatches — even with a mention', async () => {
      emitCreated({ content: '@Ally hi' });
      emitCreated({ content: '', senderId: ALLY, senderType: 'agent', isDraft: true });
      await settle();
      expect(runStream).not.toHaveBeenCalled();
      // The dispatcher does not consume storage events at all.
      expect(channelRepo.getById).not.toHaveBeenCalled();
    });

    it('message:updated(draftFinalized) never dispatches', async () => {
      emitUpdated({ content: 'all done, over to @Ally' });
      await settle();
      expect(runStream).not.toHaveBeenCalled();
      expect(channelRepo.getById).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('never dispatches back to the intent sender (self-mention skip)', async () => {
      await dispatcher.requestDispatch(makeIntent({
        triggerContent: 'thinking about @Ally', senderId: ALLY, senderType: 'agent',
      }));
      expect(runStream).not.toHaveBeenCalled();
    });

    it('broadcast replies are terminal: a completed dispatch produces no further turns', async () => {
      // Terminality is structural: a broadcast turn persists its reply and
      // produces no chained intent, so nothing re-enters dispatch. The
      // dispatchedBy metadata it stamps is observability only — no guard
      // reads it.
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally hi' }));
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(channelRepo.createMessage).toHaveBeenCalledTimes(1);
      await settle();
      expect(runStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('chain depth', () => {
    it('drops an intent at depth 3 before target resolution, with a warn', async () => {
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally hi', chainDepth: 3 }));
      expect(runStream).not.toHaveBeenCalled();
      expect(channelRepo.getById).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        '[ChannelDispatcher] Max chain depth reached',
        expect.objectContaining({ depth: 3 }),
      );

      // Positive control: depth 2 still dispatches, so the drop above is the
      // depth guard, not a target-resolution miss.
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally hi', chainDepth: 2 }));
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(dispatched()).toEqual([ALLY]);
    });
  });

  describe('cooldown and active dispatches (warn-logging backstops)', () => {
    it('skips a second intent while a dispatch for the same agent+channel is in flight', async () => {
      let resolveStream!: (value: unknown) => void;
      runStream.mockImplementationOnce(() => new Promise((resolve) => { resolveStream = resolve; }));

      const first = dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally first' }));
      await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(1));

      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally second' }));
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[ChannelDispatcher] Backstop: dispatch already in flight, skipping',
        expect.objectContaining({ dispatchKey: `${CHANNEL_ID}:${ALLY}` }),
      );

      resolveStream({ response: 'ack', contentBlocks: [], metrics: {}, responseMessages: [] });
      await first;
      expect(channelRepo.createMessage).toHaveBeenCalledTimes(1);
    });

    it('skips a second intent inside the 2s cooldown after a completed dispatch', async () => {
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally first' }));
      expect(channelRepo.createMessage).toHaveBeenCalledTimes(1);

      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally again' }));
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[ChannelDispatcher] Backstop: cooldown active, skipping',
        expect.objectContaining({ dispatchKey: `${CHANNEL_ID}:${ALLY}` }),
      );
    });
  });

  describe('target resolution', () => {
    it('dispatches an @mentioned participant and stamps loop-prevention metadata', async () => {
      const intent = makeIntent({ triggerContent: '@Ally what do you think?' });
      await dispatcher.requestDispatch(intent);
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(dispatched()).toEqual([ALLY]);

      expect(channelRepo.createMessage).toHaveBeenCalledTimes(1);
      expect(channelRepo.createMessage).toHaveBeenCalledWith(expect.objectContaining({
        channelId: CHANNEL_ID,
        senderId: ALLY,
        senderType: 'agent',
        metadata: expect.objectContaining({
          dispatchedBy: 'channel-dispatcher',
          parentDispatchMessageId: intent.triggerMessageId,
        }),
      }));
    });

    it('ignores @mentions that match no channel participant', async () => {
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Nobody are you there?' }));
      expect(runStream).not.toHaveBeenCalled();
    });

    it("dispatches respondTo:'all' participants on a mention-free intent", async () => {
      agents[WATCHER].channelBehavior.respondTo = 'all';
      await dispatcher.requestDispatch(makeIntent({ triggerContent: 'no mentions here at all' }));
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(dispatched()).toEqual([WATCHER]);
    });

    it("dedupes an agent that is both @mentioned and respondTo:'all'", async () => {
      agents[WATCHER].channelBehavior.respondTo = 'all';
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Watcher hi' }));
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(dispatched()).toEqual([WATCHER]);
    });

    it("dispatches both a mentioned agent and a distinct respondTo:'all' agent", async () => {
      agents[WATCHER].channelBehavior.respondTo = 'all';
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally please review' }));
      expect(runStream).toHaveBeenCalledTimes(2);
      expect(new Set(dispatched())).toEqual(new Set([ALLY, WATCHER]));
    });
  });

  describe('selected-agent intent shape (addressedAgentId)', () => {
    it("suppresses respondTo:'all' broadcast for an addressed human send", async () => {
      agents[WATCHER].channelBehavior.respondTo = 'all';
      await dispatcher.requestDispatch(makeIntent({ triggerContent: 'no mentions here', addressedAgentId: ALLY }));
      expect(runStream).not.toHaveBeenCalled();
    });

    it('excludes the addressed agent even when @mentioned (its single turn runs via dispatchSelectedAgent)', async () => {
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally hi', addressedAgentId: ALLY }));
      expect(runStream).not.toHaveBeenCalled();
    });

    it("excludes an addressed agent that is also respondTo:'all'", async () => {
      agents[ALLY].channelBehavior.respondTo = 'all';
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally hi', addressedAgentId: ALLY }));
      expect(runStream).not.toHaveBeenCalled();
    });

    it('still dispatches explicit @mentions of other agents in an addressed send', async () => {
      agents[WATCHER].channelBehavior.respondTo = 'all';
      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Watcher take a look', addressedAgentId: ALLY }));
      // Watcher fires once via its mention — not a second time via
      // respondTo:'all', which the addressed send suppresses.
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(dispatched()).toEqual([WATCHER]);
    });
  });

  describe('dispatchSelectedAgent (server-side selected-agent turn)', () => {
    it('produces draft → finalize with the renderer-parity shape: no dispatchedBy, finalize via updateMessageContentBlocks', async () => {
      const win = { webContents: { send: vi.fn() } };
      const selDispatcher = new ChannelDispatcher(() => win as never);
      await selDispatcher.dispatchSelectedAgent(CHANNEL_ID, ALLY, 'trigger-1');

      // Empty draft first — its message:created emission is dispatch-inert
      // (storage-only bus). NO dispatchedBy: the finalized reply is not
      // terminal — @mentions inside it chain via the chained intent.
      expect(channelRepo.createMessage).toHaveBeenCalledTimes(1);
      const draftArg = channelRepo.createMessage.mock.calls[0][0] as Record<string, unknown>;
      expect(draftArg).toMatchObject({
        channelId: CHANNEL_ID,
        senderId: ALLY,
        senderType: 'agent',
        content: '',
        isDraft: true,
        metadata: { participantType: 'agent' },
      });
      expect((draftArg.metadata as Record<string, unknown>).dispatchedBy).toBeUndefined();
      const draftId = (channelRepo.createMessage.mock.results[0].value as { id: string }).id;

      expect(dispatched()).toEqual([ALLY]);

      // Finalize goes through updateMessageContentBlocks so the repository
      // emits message:updated(draftFinalized) — pinned storage contract for
      // side services (activity, shadow, sync), and not a dispatch hook.
      expect(channelRepo.updateMessageContentBlocks).toHaveBeenCalledWith(
        draftId, [], 'ack', false, { duration: 1 }, [],
      );

      // Both renderer pushes the turn owns: the draft announce, then the
      // finalize that swaps the draft for its content.
      expect(win.webContents.send).toHaveBeenCalledWith('channel-message-added', {
        channelId: CHANNEL_ID,
        message: expect.objectContaining({ id: draftId, isDraft: true }),
      });
      expect(win.webContents.send).toHaveBeenCalledWith('message-updated', {
        messageId: draftId,
        contentBlocks: [],
        content: 'ack',
        isDraft: false,
        metrics: { duration: 1 },
      });
    });

    it('chains @mentions in the finalized reply: a chained intent dispatches them, parented to the reply id', async () => {
      runStream.mockResolvedValueOnce({
        response: 'all done, over to @Watcher',
        contentBlocks: [],
        metrics: { duration: 1 },
        responseMessages: [],
      });
      await dispatcher.dispatchSelectedAgent(CHANNEL_ID, ALLY, 'trigger-5');
      const draftId = (channelRepo.createMessage.mock.results[0].value as { id: string }).id;

      // The chained dispatch is fire-and-forget — wait for the second turn.
      await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(2));
      expect(dispatched()).toEqual([ALLY, WATCHER]);
      await vi.waitFor(() => expect(channelRepo.createMessage).toHaveBeenCalledTimes(2));
      expect(channelRepo.createMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        channelId: CHANNEL_ID,
        senderId: WATCHER,
        metadata: expect.objectContaining({
          dispatchedBy: 'channel-dispatcher',
          parentDispatchMessageId: draftId,
        }),
      }));
    });

    it('does not chain a self-mention: a reply mentioning its own author never re-dispatches it', async () => {
      runStream.mockResolvedValueOnce({
        response: 'speaking as @Ally here',
        contentBlocks: [],
        metrics: { duration: 1 },
        responseMessages: [],
      });
      await dispatcher.dispatchSelectedAgent(CHANNEL_ID, ALLY, 'trigger-6');
      await settle();
      expect(runStream).toHaveBeenCalledTimes(1);
    });

    it('deletes the dangling draft and persists a dispatcher-tagged error notice on failure', async () => {
      runStream.mockRejectedValueOnce(new Error('boom'));
      await dispatcher.dispatchSelectedAgent(CHANNEL_ID, ALLY, 'trigger-9');

      const draftId = (channelRepo.createMessage.mock.results[0].value as { id: string }).id;
      expect(channelRepo.deleteMessage).toHaveBeenCalledWith(draftId);
      expect(channelRepo.updateMessageContentBlocks).not.toHaveBeenCalled();
      // Error notice reproduces dispatchAgentResponse's shape: terminal
      // (dispatchedBy) + parented to the triggering human message.
      expect(channelRepo.createMessage).toHaveBeenCalledTimes(2);
      expect(channelRepo.createMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        channelId: CHANNEL_ID,
        senderId: ALLY,
        content: '[Error: boom]',
        metadata: expect.objectContaining({
          dispatchedBy: 'channel-dispatcher',
          parentDispatchMessageId: 'trigger-9',
        }),
      }));
    });

    it('pushes the error notice via channel-message-added so the renderer gets a terminal signal', async () => {
      const win = { webContents: { send: vi.fn() } };
      const selDispatcher = new ChannelDispatcher(() => win as never);
      runStream.mockRejectedValueOnce(new Error('boom'));
      await selDispatcher.dispatchSelectedAgent(CHANNEL_ID, ALLY, 'trigger-10');

      const notice = channelRepo.createMessage.mock.results[1].value as { id: string };
      expect(win.webContents.send).toHaveBeenCalledWith('channel-message-added', {
        channelId: CHANNEL_ID,
        message: expect.objectContaining({ id: notice.id }),
      });
      expect(win.webContents.send).not.toHaveBeenCalledWith('message-updated', expect.anything());
    });

    it('honors an abort that raced a cleanly-ending stream: draft deleted, no finalize, no error notice, no chained intent', async () => {
      const controller = new AbortController();
      controller.abort();
      await dispatcher.dispatchSelectedAgent(CHANNEL_ID, ALLY, 'trigger-11', controller.signal);
      await settle();

      const draftId = (channelRepo.createMessage.mock.results[0].value as { id: string }).id;
      expect(channelRepo.deleteMessage).toHaveBeenCalledWith(draftId);
      expect(channelRepo.updateMessageContentBlocks).not.toHaveBeenCalled();
      expect(channelRepo.createMessage).toHaveBeenCalledTimes(1);
      expect(runStream).toHaveBeenCalledTimes(1);
    });

    it('holds the activeDispatches key: broadcast intents for the agent skip during a selected turn', async () => {
      let resolveStream!: (value: unknown) => void;
      runStream.mockImplementationOnce(() => new Promise((resolve) => { resolveStream = resolve; }));

      const turn = dispatcher.dispatchSelectedAgent(CHANNEL_ID, ALLY, 'trigger-2');
      await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(1));

      await dispatcher.requestDispatch(makeIntent({ triggerContent: '@Ally poke' }));
      expect(runStream).toHaveBeenCalledTimes(1);

      resolveStream({ response: 'ack', contentBlocks: [], metrics: {}, responseMessages: [] });
      await turn;
    });
  });
});
