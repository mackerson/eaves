/**
 * AgentTurnService persistence policies (ADR-001).
 *
 * Mock at the stream/tool/history boundary so we assert what gets persisted
 * (and what is deleted) for each policy — not the AI SDK itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  runStream,
  buildToolset,
  buildSystemPrompt,
  activeToolsFor,
  systemPromptPlumbing,
  buildRequestInfo,
  streamAIResponse,
  channelRepo,
  workDone,
  registryRegister,
  emitStreamAborted,
} = vi.hoisted(() => ({
  runStream: vi.fn(),
  buildToolset: vi.fn(),
  buildSystemPrompt: vi.fn(),
  activeToolsFor: vi.fn(() => () => ['list_tools']),
  systemPromptPlumbing: vi.fn(() => ({})),
  buildRequestInfo: vi.fn(() => ({ toolCount: 0 })),
  streamAIResponse: vi.fn(),
  channelRepo: {
    getById: vi.fn(),
    getConversationById: vi.fn(),
    createMessage: vi.fn(),
    createDirectMessage: vi.fn(),
    updateMessageContentBlocks: vi.fn(),
    addParticipant: vi.fn(),
    deleteMessage: vi.fn(),
  },
  workDone: vi.fn(),
  registryRegister: vi.fn(),
  emitStreamAborted: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/enclave-test', on: vi.fn(), whenReady: () => Promise.resolve() },
  BrowserWindow: class {},
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('../repositories', () => ({
  getChannelRepository: () => channelRepo,
  getMessageAttachmentRepository: () => ({ getById: vi.fn(), getByAssetPointer: vi.fn() }),
}));
vi.mock('../ipc/chatHelpers', () => ({
  runStream,
  buildToolset,
  buildSystemPrompt,
  activeToolsFor,
  systemPromptPlumbing,
  buildRequestInfo,
}));
vi.mock('./MessageFormatter', () => ({
  MessageFormatter: {
    formatMessages: vi.fn(() => ({ messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'SYS' })),
    collectStoppingStrings: vi.fn(() => undefined),
  },
}));
vi.mock('../utils/perspectiveShift', () => ({
  perspectiveShiftMessages: (m: unknown[]) => m,
}));
vi.mock('../utils/stickyProvider', () => ({ resolveStickyProvider: () => undefined }));
vi.mock('../utils/aiErrors', () => ({
  friendlyAIErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../utils/buildRoleplayNote', () => ({ buildRoleplayNote: () => undefined }));
vi.mock('./replayHistory', () => ({
  assembleReplayHistory: vi.fn(async ({ messages }: { messages: unknown[] }) => ({
    messages,
    summary: undefined,
  })),
}));
vi.mock('./replayProjection', () => ({
  createAttachmentLoaders: () => ({}),
  expandImageBlock: () => ({ text: '' }),
  expandFileBlock: () => '',
  projectChatHistory: (rows: unknown[]) => ({
    messages: rows.map((r: any) => ({
      role: r.senderType === 'human' ? 'user' : 'assistant',
      content: r.content,
    })),
    lastUserMessageHasImages: false,
  }),
  scanTurnFailures: (rows: unknown[]) => ({ rows, unresolved: [] }),
  failureSection: () => '',
}));
vi.mock('./compaction', () => ({
  summarySection: (s: string) => `\nSUMMARY:${s}`,
}));
vi.mock('./streamEventRouter', () => ({
  routeStreamEvent: vi.fn(),
  emitStreamStart: vi.fn(),
  emitStreamComplete: vi.fn(),
  emitStreamAborted,
  emitAgentSpend: vi.fn(),
  createStreamMetrics: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  emitCompaction: vi.fn(),
  emitStreamSentinel: vi.fn(),
}));
vi.mock('./contextBudget', () => ({
  resolveTurnBudget: async () => ({
    contextWindow: 8192,
    sizeClass: 'large',
    systemPromptBudget: 2000,
    messageBudget: 4000,
  }),
}));
vi.mock('./ActiveWorkRegistry', () => ({
  getActiveWorkRegistry: () => ({
    start: () => ({ done: workDone }),
  }),
}));
vi.mock('./PendingApprovalRegistry', () => ({
  getPendingApprovalRegistry: () => ({ register: registryRegister }),
}));
vi.mock('./ContentBlocksBuilder', () => ({
  ContentBlocksBuilder: class {
    private text = '';
    private blocks: unknown[] = [];
    handleEvent(e: unknown) {
      if (typeof e === 'string') this.text += e;
    }
    getFullText() {
      return this.text;
    }
    getContentBlocks() {
      return this.blocks;
    }
    getLegacyToolCalls() {
      return [];
    }
    addSystemNote(n: string) {
      this.blocks.push({ type: 'system', content: n });
    }
  },
}));
vi.mock('./ai', () => ({ streamAIResponse }));
vi.mock('./mcp', () => ({ disconnectMCPClients: vi.fn() }));
vi.mock('./WorkSessionService', () => ({ reportSessionBlocked: vi.fn() }));
vi.mock('../../shared/pricing', () => ({ calculateCost: () => 0.01 }));

import { runAgentTurn } from './AgentTurnService';
import type { Agent, Project, Settings } from '../types';

const agent = {
  id: 'agent-1',
  name: 'Ada',
  color: '#f00',
  provider: 'anthropic',
  model: 'claude-test',
  channelBehavior: { respondTo: 'mentions-only', verbosity: 'brief' },
} as Agent;

const project = { id: 'p1', name: 'P', tasks: [], notes: [] } as Project;
const settings = { userName: 'Robin' } as Settings;

const baseChannel = {
  id: 'ch-1',
  name: 'Room',
  participants: [{ id: 'agent-1', type: 'agent', displayName: 'Ada' }],
  messages: [
    {
      id: 'm1',
      senderType: 'human',
      senderId: 'u1',
      senderDisplayName: 'Robin',
      content: 'hello',
    },
  ],
};

const deps = {
  getMainWindow: () =>
    ({
      webContents: { send: vi.fn() },
    }) as never,
  toolStates: new Map(),
};

function streamResult(over: Record<string, unknown> = {}) {
  return {
    response: 'reply',
    contentBlocks: [{ type: 'text', content: 'reply' }],
    metrics: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    responseMessages: [{ role: 'assistant', content: 'reply' }],
    ...over,
  };
}

describe('runAgentTurn — channel-broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelRepo.getById.mockReturnValue(baseChannel);
    buildToolset.mockResolvedValue({
      enabledTools: {},
      mcpClients: [],
      getActiveToolNames: () => [],
      toolSendMode: 'all',
      projectDirectories: [],
      builtinToolCount: 0,
      mcpToolCount: 0,
      totalToolCount: 0,
    });
    buildSystemPrompt.mockResolvedValue('SYS');
    channelRepo.createMessage.mockImplementation((row: { content: string }) => ({
      id: 'msg-out',
      ...row,
    }));
  });

  it('persists a terminal broadcast reply with dispatchedBy metadata', async () => {
    runStream.mockResolvedValue(streamResult());
    const result = await runAgentTurn(
      {
        context: 'channel',
        containerId: 'ch-1',
        agent,
        project,
        settings,
        persistence: 'channel-broadcast',
        abortSignal: new AbortController().signal,
        trigger: { messageId: 'm1' },
      },
      deps,
    );

    expect(result.status).toBe('completed');
    expect(channelRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'ch-1',
        senderId: 'agent-1',
        content: 'reply',
        metadata: expect.objectContaining({
          dispatchedBy: 'channel-dispatcher',
          parentDispatchMessageId: 'm1',
        }),
      }),
    );
    expect(workDone).toHaveBeenCalled();
  });

  it('skips empty broadcast turns (no row, status empty)', async () => {
    runStream.mockResolvedValue(streamResult({ response: '   ', contentBlocks: [] }));
    const result = await runAgentTurn(
      {
        context: 'channel',
        containerId: 'ch-1',
        agent,
        project,
        settings,
        persistence: 'channel-broadcast',
        abortSignal: new AbortController().signal,
      },
      deps,
    );
    expect(result.status).toBe('empty');
    expect(channelRepo.createMessage).not.toHaveBeenCalled();
  });

  it('registers pending approvals on the persisted broadcast message', async () => {
    runStream.mockResolvedValue(
      streamResult({
        pendingApprovals: [
          { approvalId: 'ap1', toolCallId: 'tc1', toolName: 'bash', input: {} },
        ],
      }),
    );
    await runAgentTurn(
      {
        context: 'channel',
        containerId: 'ch-1',
        agent,
        project,
        settings,
        persistence: 'channel-broadcast',
        abortSignal: new AbortController().signal,
      },
      deps,
    );
    expect(registryRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'ap1',
        context: 'channel',
        contextId: 'ch-1',
        messageId: 'msg-out',
      }),
    );
  });

  it('returns aborted without persisting when the signal is set post-stream', async () => {
    const ac = new AbortController();
    ac.abort();
    runStream.mockResolvedValue(streamResult());
    const result = await runAgentTurn(
      {
        context: 'channel',
        containerId: 'ch-1',
        agent,
        project,
        settings,
        persistence: 'channel-broadcast',
        abortSignal: ac.signal,
      },
      deps,
    );
    expect(result.status).toBe('aborted');
    expect(channelRepo.createMessage).not.toHaveBeenCalled();
    expect(emitStreamAborted).toHaveBeenCalled();
  });
});

describe('runAgentTurn — channel-selected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelRepo.getById.mockReturnValue({
      ...baseChannel,
      participants: [{ id: 'other', type: 'agent', displayName: 'Other' }],
    });
    buildToolset.mockResolvedValue({
      enabledTools: {},
      mcpClients: [],
      getActiveToolNames: () => [],
      toolSendMode: 'all',
      projectDirectories: [],
      builtinToolCount: 0,
      mcpToolCount: 0,
      totalToolCount: 0,
    });
    buildSystemPrompt.mockResolvedValue('SYS');
    channelRepo.createMessage.mockReturnValue({ id: 'draft-1', content: '', isDraft: true });
  });

  it('joins the channel, drafts, finalizes, and does not set dispatchedBy', async () => {
    runStream.mockResolvedValue(streamResult());
    const result = await runAgentTurn(
      {
        context: 'channel',
        containerId: 'ch-1',
        agent,
        project,
        settings,
        persistence: 'channel-selected',
        abortSignal: new AbortController().signal,
      },
      deps,
    );
    expect(channelRepo.addParticipant).toHaveBeenCalledWith(
      'ch-1',
      expect.objectContaining({ id: 'agent-1', type: 'agent' }),
    );
    expect(channelRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ isDraft: true, content: '' }),
    );
    expect(channelRepo.updateMessageContentBlocks).toHaveBeenCalledWith(
      'draft-1',
      expect.any(Array),
      'reply',
      false,
      expect.anything(),
      expect.anything(),
    );
    expect(result.status).toBe('completed');
    expect(result.message).toMatchObject({ id: 'draft-1', isDraft: false });
  });

  it('deletes the draft on empty turn (ADR-001)', async () => {
    runStream.mockResolvedValue(streamResult({ response: '', contentBlocks: [] }));
    const result = await runAgentTurn(
      {
        context: 'channel',
        containerId: 'ch-1',
        agent,
        project,
        settings,
        persistence: 'channel-selected',
        abortSignal: new AbortController().signal,
      },
      deps,
    );
    expect(result.status).toBe('empty');
    expect(channelRepo.deleteMessage).toHaveBeenCalledWith('draft-1');
    expect(channelRepo.updateMessageContentBlocks).not.toHaveBeenCalled();
  });

  it('deletes the draft on abort and on stream error throw', async () => {
    const ac = new AbortController();
    ac.abort();
    runStream.mockResolvedValue(streamResult());
    const aborted = await runAgentTurn(
      {
        context: 'channel',
        containerId: 'ch-1',
        agent,
        project,
        settings,
        persistence: 'channel-selected',
        abortSignal: ac.signal,
      },
      deps,
    );
    expect(aborted.status).toBe('aborted');
    expect(channelRepo.deleteMessage).toHaveBeenCalledWith('draft-1');

    vi.clearAllMocks();
    channelRepo.getById.mockReturnValue(baseChannel);
    channelRepo.createMessage.mockReturnValue({ id: 'draft-2' });
    buildToolset.mockResolvedValue({
      enabledTools: {},
      mcpClients: [],
      getActiveToolNames: () => [],
      toolSendMode: 'all',
      projectDirectories: [],
      builtinToolCount: 0,
      mcpToolCount: 0,
      totalToolCount: 0,
    });
    runStream.mockRejectedValue(new Error('stream boom'));
    await expect(
      runAgentTurn(
        {
          context: 'channel',
          containerId: 'ch-1',
          agent,
          project,
          settings,
          persistence: 'channel-selected',
          abortSignal: new AbortController().signal,
        },
        deps,
      ),
    ).rejects.toThrow('stream boom');
    expect(channelRepo.deleteMessage).toHaveBeenCalledWith('draft-2');
  });
});

describe('runAgentTurn — chat-assistant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelRepo.getConversationById.mockReturnValue({
      id: 'chat-1',
      participants: [],
      messages: [
        {
          id: 'um1',
          senderType: 'human',
          senderId: 'u1',
          content: 'hi',
        },
      ],
    });
    buildToolset.mockResolvedValue({
      enabledTools: {},
      mcpClients: [],
      getActiveToolNames: () => [],
      toolSendMode: 'all',
      projectDirectories: [],
      builtinToolCount: 0,
      mcpToolCount: 0,
      totalToolCount: 0,
    });
    buildSystemPrompt.mockResolvedValue('SYS');
    channelRepo.createDirectMessage.mockImplementation((row: object) => ({
      id: 'am1',
      ...row,
    }));
    streamAIResponse.mockImplementation(async function* () {
      yield 'Hello';
      yield { type: 'response-messages', messages: [{ role: 'assistant', content: 'Hello' }] };
      return 'Hello';
    });
  });

  it('persists assistant reply and returns completed', async () => {
    const result = await runAgentTurn(
      {
        context: 'chat',
        containerId: 'chat-1',
        agent,
        project,
        settings,
        persistence: 'chat-assistant',
        abortSignal: new AbortController().signal,
      },
      deps,
    );
    expect(result.status).toBe('completed');
    expect(channelRepo.createDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        senderId: 'agent-1',
        content: 'Hello',
        parentMessageId: 'um1',
        branchIndex: 0,
      }),
    );
    expect(result.response).toBe('Hello');
  });

  it('honors branchOverride for regenerate linkage', async () => {
    await runAgentTurn(
      {
        context: 'chat',
        containerId: 'chat-1',
        agent,
        project,
        settings,
        persistence: 'chat-assistant',
        abortSignal: new AbortController().signal,
        branchOverride: { parentMessageId: 'parent-x', branchIndex: 2 },
      },
      deps,
    );
    expect(channelRepo.createDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: 'parent-x',
        branchIndex: 2,
      }),
    );
  });

  it('reports aborted when signal is set after stream completes', async () => {
    const ac = new AbortController();
    streamAIResponse.mockImplementation(async function* () {
      yield 'partial';
      ac.abort();
      return 'partial';
    });
    const result = await runAgentTurn(
      {
        context: 'chat',
        containerId: 'chat-1',
        agent,
        project,
        settings,
        persistence: 'chat-assistant',
        abortSignal: ac.signal,
      },
      deps,
    );
    expect(result.status).toBe('aborted');
    expect(channelRepo.createDirectMessage).toHaveBeenCalled(); // partial kept
    expect(emitStreamAborted).toHaveBeenCalled();
  });

  it('rejects wrong context/persistence pairings and missing channel/chat', async () => {
    await expect(
      runAgentTurn(
        {
          context: 'channel',
          containerId: 'x',
          agent,
          project,
          settings,
          persistence: 'chat-assistant',
          abortSignal: new AbortController().signal,
        },
        deps,
      ),
    ).rejects.toThrow(/requires context 'chat'/);

    channelRepo.getById.mockReturnValue(null);
    await expect(
      runAgentTurn(
        {
          context: 'channel',
          containerId: 'missing',
          agent,
          project,
          settings,
          persistence: 'channel-broadcast',
          abortSignal: new AbortController().signal,
        },
        deps,
      ),
    ).rejects.toThrow(/Channel not found/);

    // Chat-assistant catches missing chat and returns status:'error' (persists
    // an error notice path) rather than throwing out of runAgentTurn.
    channelRepo.getConversationById.mockReturnValue(null);
    const missing = await runAgentTurn(
      {
        context: 'chat',
        containerId: 'missing',
        agent,
        project,
        settings,
        persistence: 'chat-assistant',
        abortSignal: new AbortController().signal,
      },
      deps,
    );
    expect(missing.status).toBe('error');
    expect(missing.errorMessage).toMatch(/Chat not found/i);
  });
});
