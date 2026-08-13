import { describe, it, expect, vi, beforeEach } from 'vitest';

// approvalResume owns only the resume-specific work — the stream drive lives
// in the turn core's runStream (ADR-001).
// These tests pin that contract: message rebuild + tool-approval-response
// injection, new-message persistence tagged resumedFromApproval, chat vs
// channel push behavior, chained-approval re-registration, post-restart
// reconstruction from the persisted contentBlock, and the ADR-001 empty-turn
// policy (nothing persists).

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const runStream = vi.fn();
const buildRequestInfo = vi.fn(() => ({
  contextWindow: 0,
  sizeClass: 'large',
  systemPromptTokens: 0,
  messageBudget: 0,
  messagesTotal: 0,
  messagesSent: 0,
  toolsIncluded: false,
  toolCount: 0,
}));
vi.mock('../ipc/chatHelpers', () => ({
  runStream: (...args: unknown[]) => runStream(...args),
  buildToolset: vi.fn(async () => ({
    enabledTools: {},
    mcpClients: [],
    projectDirectories: [],
    builtinToolCount: 0,
    mcpToolCount: 0,
    totalToolCount: 0,
  })),
  buildSystemPrompt: vi.fn(async () => 'SYS'),
  // Always a callable — activeToolsFor gates unconditionally and its return
  // type is non-optional; undefined would assert a contract that is now gone.
  activeToolsFor: vi.fn(() => () => []),
  // Pure wiring from toolset+budget; buildSystemPrompt is stubbed anyway.
  systemPromptPlumbing: () => ({}),
  buildRequestInfo: (...args: unknown[]) => buildRequestInfo(...(args as [])),
}));

// One repository: a chat IS a `channels` row with type='direct', so
// ChannelRepository carries both the channel API and the chat projection.
const channelRepo = {
  getById: vi.fn(),
  getMessagesByChannelId: vi.fn(),
  createMessage: vi.fn(),
  updateMessageContentBlocks: vi.fn(),
  // chat projection
  getDirectChatById: vi.fn(),
  createDirectMessage: vi.fn(),
  updateMessage: vi.fn(),
  getLatestActiveMessageId: vi.fn(() => 'msg-latest'),
};
const agentRepo = { getById: vi.fn() };
const settingsRepo = { get: vi.fn(() => ({ userName: 'Robin' })), getCurrentState: vi.fn(() => ({ projectId: 'proj-1' })) };
const projectRepo = { getById: vi.fn(() => ({ id: 'proj-1', name: 'P', tasks: [], notes: [] })) };
vi.mock('../repositories', () => ({
  getChannelRepository: () => channelRepo,
  getAgentRepository: () => agentRepo,
  getSettingsRepository: () => settingsRepo,
  getProjectRepository: () => projectRepo,
}));

vi.mock('../utils/buildRoleplayNote', () => ({
  buildRoleplayNote: () => undefined,
}));
vi.mock('./ChannelDispatcher', () => ({
  buildChannelBehaviorNote: () => 'NOTE',
}));
vi.mock('../utils/perspectiveShift', () => ({
  perspectiveShiftMessages: (messages: unknown[]) => messages,
}));
vi.mock('../utils/sanitizeResponseMessages', () => ({
  sanitizeResponseMessagesForReplay: (messages: unknown[]) => messages,
}));
// Real emitStreamSentinel: the assertions below read the sentinels off the
// fake window, and a vi.fn() here would silently swallow them.
vi.mock('./streamEventRouter', () => ({
  emitCompaction: vi.fn(),
  emitStreamSentinel: (
    win: { webContents: { send: (channel: string, payload: unknown) => void } } | null,
    phase: 'start' | 'end',
    envelope?: Record<string, unknown>,
  ) => {
    if (!win) return;
    win.webContents.send('chat-stream', {
      type: phase === 'start' ? 'stream:start' : 'stream:end',
      ...envelope,
    });
  },
}));
vi.mock('./compaction', () => ({
  maybeCompactHistory: async ({ messages }: { messages: unknown[] }) => ({ messages, summary: null }),
  summarySection: () => '',
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

const registry = { register: vi.fn(), resolve: vi.fn() };
vi.mock('./PendingApprovalRegistry', () => ({
  getPendingApprovalRegistry: () => registry,
}));

import { resumeAfterApproval, resumeAfterApprovals, closeSupersededApprovals } from './approvalResume';

const APPROVAL_ID = 'ap-1';
const TOOL_CALL_ID = 'tc-1';
const AGENT_ID = 'agent-1';
const CHAT_ID = 'chat-1';
const CHANNEL_ID = 'ch-1';
const ORIG_MSG_ID = 'msg-orig';

const agent = {
  id: AGENT_ID, name: 'Ally', color: '#fff', provider: 'ollama', model: 'm',
};

function pendingBlock(status = 'pending') {
  return {
    type: 'tool-approval',
    approval: {
      approvalId: APPROVAL_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'bash',
      input: { command: 'echo hi' },
      status,
    },
  };
}

// Assistant turn that suspended: SDK-shape responseMessages carrying the
// unresolved tool-call the approval-response must bind to.
function suspendedMessage(sender: Record<string, unknown> = {}) {
  return {
    id: ORIG_MSG_ID,
    senderId: AGENT_ID,
    senderType: 'agent',
    senderDisplayName: 'Ally',
    content: '',
    contentBlocks: [pendingBlock()],
    responseMessages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: TOOL_CALL_ID, toolName: 'bash', input: {} }],
      },
    ],
    metadata: {},
    ...sender,
  };
}

function chatFixture() {
  return {
    id: CHAT_ID,
    participants: [],
    messages: [
      { id: 'msg-h1', senderId: 'user-1', senderType: 'human', content: 'run it', metadata: {} },
      suspendedMessage(),
    ],
  };
}

function channelFixture() {
  return {
    id: CHANNEL_ID,
    projectId: 'proj-1',
    participants: [],
    messages: [
      { id: 'msg-h1', senderId: 'user-1', senderType: 'human', senderDisplayName: 'Robin', content: 'run it', metadata: {} },
      suspendedMessage(),
    ],
  };
}

function chatEntry() {
  return {
    approvalId: APPROVAL_ID,
    toolCallId: TOOL_CALL_ID,
    toolName: 'bash',
    input: { command: 'echo hi' },
    context: 'chat' as const,
    contextId: CHAT_ID,
    agentId: AGENT_ID,
    messageId: ORIG_MSG_ID,
    createdAt: 0,
  };
}

function channelEntry() {
  return { ...chatEntry(), context: 'channel' as const, contextId: CHANNEL_ID };
}

function streamResult(overrides: Record<string, unknown> = {}) {
  return {
    response: 'continuation text',
    metrics: { inputTokens: 1, outputTokens: 2, totalTokens: 3, finishReason: 'stop' },
    contentBlocks: [{ type: 'text', content: 'continuation text' }],
    responseMessages: [{ role: 'assistant', content: 'continuation text' }],
    pendingApprovals: undefined,
    streamError: undefined,
    ...overrides,
  };
}

let sends: Array<{ channel: string; payload: unknown }>;
const mainWindow = {
  webContents: { send: (channel: string, payload: unknown) => sends.push({ channel, payload }) },
} as never;
const getMainWindow = () => mainWindow;

function decision(approved = true) {
  return { approved, decidedBy: 'user-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  sends = [];
  agentRepo.getById.mockReturnValue(agent);
  settingsRepo.get.mockReturnValue({ userName: 'Robin' });
  settingsRepo.getCurrentState.mockReturnValue({ projectId: 'proj-1' });
  projectRepo.getById.mockReturnValue({ id: 'proj-1', name: 'P', tasks: [], notes: [] });
  channelRepo.getDirectChatById.mockReturnValue(chatFixture());
  channelRepo.getLatestActiveMessageId.mockReturnValue('msg-latest');
  channelRepo.createDirectMessage.mockReturnValue({ id: 'msg-new' });
  channelRepo.getById.mockReturnValue(channelFixture());
  channelRepo.getMessagesByChannelId.mockReturnValue(channelFixture().messages);
  channelRepo.createMessage.mockReturnValue({ id: 'msg-new' });
  runStream.mockResolvedValue(streamResult());
});

describe('resumeAfterApproval — chat context', () => {
  it('re-streams via the turn core with the injected approval-response and envelope', async () => {
    const res = await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res.success).toBe(true);
    expect(runStream).toHaveBeenCalledTimes(1);
    const opts = runStream.mock.calls[0][0] as {
      formattedResult: { messages: Array<{ role?: string; content?: unknown }> };
      envelope: { turnId: string; agentId: string; containerId: string; context: string };
    };

    // ADR-001 envelope stamps the resume turn.
    expect(opts.envelope).toMatchObject({ agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
    expect(opts.envelope.turnId).toBeTruthy();

    const messages = opts.formattedResult.messages;
    // Final message is the tool-approval-response the SDK resumes on.
    const last = messages[messages.length - 1] as { role: string; content: Array<Record<string, unknown>> };
    expect(last.role).toBe('tool');
    expect(last.content[0]).toMatchObject({
      type: 'tool-approval-response', approvalId: APPROVAL_ID, approved: true,
    });
    // The assistant message carrying the tool-call gained the matching
    // tool-approval-request part (else the SDK validator rejects the prompt).
    const assistant = messages.find(m =>
      m.role === 'assistant' && Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some(p => p.type === 'tool-call'),
    ) as { content: Array<{ type?: string; approvalId?: string; toolCallId?: string }> };
    expect(assistant.content).toContainEqual({
      type: 'tool-approval-request', approvalId: APPROVAL_ID, toolCallId: TOOL_CALL_ID,
    });
  });

  // A resume is a real billed request running the same windowing pipeline as
  // any other turn. It used to be the one turn shape reporting no context
  // telemetry at all, so the UI showed nothing for it.
  it('reports context telemetry for the resumed turn', async () => {
    await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(),
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    const opts = runStream.mock.calls[0][0] as { requestInfo?: Record<string, unknown> };
    expect(opts.requestInfo).toBeDefined();

    const [args] = buildRequestInfo.mock.calls[0] as [{
      messagesTotal: number; messagesSent: number; activeToolNames: string[];
    }];
    // Sent is what survived windowing; total is what there was to send. The
    // approval response is appended to both, so total can never trail sent.
    expect(args.messagesTotal).toBeGreaterThanOrEqual(args.messagesSent);
    expect(Array.isArray(args.activeToolNames)).toBe(true);
  });

  it('persists the continuation as a NEW chat message tagged resumedFromApproval', async () => {
    await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(channelRepo.createDirectMessage).toHaveBeenCalledTimes(1);
    const created = channelRepo.createDirectMessage.mock.calls[0][0];
    expect(created).toMatchObject({
      chatId: CHAT_ID,
      senderId: AGENT_ID,
      senderType: 'agent',
      parentMessageId: 'msg-latest',
      metadata: { participantType: 'agent', resumedFromApproval: APPROVAL_ID },
      content: 'continuation text',
    });
    // Chat context pushes no channel broadcast; the live stream + sentinels
    // carry the update.
    expect(sends.filter(s => s.channel === 'channel-message-added')).toHaveLength(0);
    const sentinels = sends.filter(s => s.channel === 'chat-stream').map(s => s.payload);
    // Envelope-stamped so the renderer can tell which surface this brackets.
    expect(sentinels[0]).toMatchObject({ type: 'stream:start', context: 'chat', containerId: CHAT_ID });
    expect(sentinels[sentinels.length - 1]).toMatchObject({ type: 'stream:end', context: 'chat', containerId: CHAT_ID });
  });

  it('updates the original tool-approval block with the decision', async () => {
    await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: { approved: false, reason: 'nope', decidedBy: 'user-1' },
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(channelRepo.updateMessage).toHaveBeenCalledWith(ORIG_MSG_ID, expect.anything());
    const { contentBlocks } = channelRepo.updateMessage.mock.calls[0][1];
    expect(contentBlocks[0].approval).toMatchObject({
      approvalId: APPROVAL_ID, status: 'denied', reason: 'nope', decidedBy: 'user-1',
    });
  });

  it('re-registers chained approvals against the new message', async () => {
    runStream.mockResolvedValue(streamResult({
      pendingApprovals: [{ approvalId: 'ap-2', toolCallId: 'tc-2', toolName: 'bash', input: {} }],
    }));

    await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(registry.register).toHaveBeenCalledWith({
      approvalId: 'ap-2', toolCallId: 'tc-2', toolName: 'bash', input: {},
      context: 'chat', contextId: CHAT_ID, agentId: AGENT_ID, messageId: 'msg-new',
    });
  });

  it('never persists an empty resume turn (ADR-001)', async () => {
    runStream.mockResolvedValue(streamResult({
      response: '', contentBlocks: [], responseMessages: undefined,
    }));

    const res = await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res.success).toBe(true);
    expect(channelRepo.createDirectMessage).not.toHaveBeenCalled();
    expect(channelRepo.createMessage).not.toHaveBeenCalled();
    // The stream still settles cleanly for the renderer.
    expect(sends.filter(s => s.channel === 'chat-stream').map(s => (s.payload as { type?: string }).type)).toContain('stream:end');
  });

  it('reconstructs the entry from the persisted contentBlock after restart', async () => {
    const res = await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: undefined,
      fallbackContext: { context: 'chat', contextId: CHAT_ID, agentId: AGENT_ID, messageId: ORIG_MSG_ID },
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res.success).toBe(true);
    // The reconstructed toolCallId came from the persisted block and bound the
    // approval-response.
    const opts = runStream.mock.calls[0][0] as { formattedResult: { messages: Array<Record<string, unknown>> } };
    const last = opts.formattedResult.messages[opts.formattedResult.messages.length - 1] as { content: Array<Record<string, unknown>> };
    expect(last.content[0]).toMatchObject({ type: 'tool-approval-response', approvalId: APPROVAL_ID });
    expect(channelRepo.createDirectMessage).toHaveBeenCalledTimes(1);
  });

  it('fails closed when neither registry entry nor fallback context exists', async () => {
    const res = await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: undefined,
      getMainWindow,
      toolStates: new Map(),
    });
    expect(res.success).toBe(false);
    expect(runStream).not.toHaveBeenCalled();
  });

  it('returns the error and still ends the stream when runStream throws', async () => {
    runStream.mockRejectedValue(new Error('provider exploded'));

    const res = await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res).toEqual({ success: false, error: 'provider exploded' });
    expect(channelRepo.createDirectMessage).not.toHaveBeenCalled();
    expect(sends.filter(s => s.channel === 'chat-stream').map(s => (s.payload as { type?: string }).type)).toContain('stream:end');
  });
});

describe('resumeAfterApproval — channel context', () => {
  it('persists a dispatcher-tagged continuation and pushes channel-message-added', async () => {
    const res = await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: channelEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res.success).toBe(true);
    expect(channelRepo.createMessage).toHaveBeenCalledTimes(1);
    expect(channelRepo.createMessage.mock.calls[0][0]).toMatchObject({
      channelId: CHANNEL_ID,
      senderId: AGENT_ID,
      senderType: 'agent',
      metadata: {
        participantType: 'agent',
        dispatchedBy: 'channel-dispatcher',
        resumedFromApproval: APPROVAL_ID,
      },
    });
    const broadcast = sends.find(s => s.channel === 'channel-message-added');
    expect(broadcast?.payload).toMatchObject({ channelId: CHANNEL_ID, message: { id: 'msg-new' } });
    // Envelope carries channel context.
    const opts = runStream.mock.calls[0][0] as { envelope: Record<string, unknown> };
    expect(opts.envelope).toMatchObject({ containerId: CHANNEL_ID, context: 'channel' });
  });

  it('marks the decision via updateMessageContentBlocks without re-finalizing the draft', async () => {
    await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: channelEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(channelRepo.updateMessageContentBlocks).toHaveBeenCalledTimes(1);
    const args = channelRepo.updateMessageContentBlocks.mock.calls[0];
    expect(args[0]).toBe(ORIG_MSG_ID);
    expect(args[1][0].approval.status).toBe('approved');
    // isDraft must stay undefined — a decision is not a draft finalization.
    expect(args[3]).toBeUndefined();
  });

  it('re-registers chained approvals with channel context', async () => {
    runStream.mockResolvedValue(streamResult({
      pendingApprovals: [{ approvalId: 'ap-2', toolCallId: 'tc-2', toolName: 'bash', input: {} }],
    }));

    await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: channelEntry(),
      getMainWindow,
      toolStates: new Map(),
    });

    expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: 'ap-2', context: 'channel', contextId: CHANNEL_ID, messageId: 'msg-new',
    }));
  });
});

describe('closeSupersededApprovals', () => {
  const strandedChat = () => ({
    messages: [{
      id: 'msg-1',
      content: 'assistant text',
      metrics: undefined,
      contentBlocks: [
        { type: 'text', content: 'x' },
        { type: 'tool-approval', approval: { approvalId: 'appr_22', toolCallId: 'call_22', toolName: 'bash', input: {}, status: 'pending' } },
      ],
      responseMessages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'x' },
          { type: 'tool-call', toolCallId: 'call_22', toolName: 'bash', input: {} },
          { type: 'tool-approval-request', toolCallId: 'call_22', approvalId: 'appr_22' },
          { type: 'tool-call', toolCallId: 'call_23', toolName: 'bash', input: {} },
        ] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_23', toolName: 'bash', output: { type: 'json', value: { ok: true } } }] },
      ],
    }],
  });

  it('marks a stranded chat approval denied, keeping the call it stranded', async () => {
    channelRepo.getDirectChatById.mockReturnValue(strandedChat());
    const closed = await closeSupersededApprovals('chat', 'chat-1');

    expect(closed).toBe(1);
    expect(registry.resolve).toHaveBeenCalledWith('appr_22');
    expect(channelRepo.updateMessage).toHaveBeenCalledTimes(1);

    const [msgId, updates] = channelRepo.updateMessage.mock.calls[0];
    expect(msgId).toBe('msg-1');
    const appr = updates.contentBlocks.find((b: any) => b.type === 'tool-approval').approval;
    expect(appr.status).toBe('denied');
    expect(appr.decidedBy).toBe('system');

    // Only the moot approval-request goes. call_22's tool-call stays so replay
    // can answer it — that is how the agent learns it asked to run something
    // the user never acted on.
    const assistantTypes = updates.responseMessages[0].content.map((p: any) => [p.type, p.toolCallId]);
    expect(assistantTypes).toEqual([
      ['text', undefined],
      ['tool-call', 'call_22'],
      ['tool-call', 'call_23'],
    ]);
    expect(updates.responseMessages[1].content[0].toolCallId).toBe('call_23');
  });

  it('is a no-op when there are no pending approvals', async () => {
    channelRepo.getDirectChatById.mockReturnValue({
      messages: [{ id: 'm', contentBlocks: [{ type: 'text', content: 'hi' }], responseMessages: [] }],
    });
    const closed = await closeSupersededApprovals('chat', 'chat-1');
    expect(closed).toBe(0);
    expect(channelRepo.updateMessage).not.toHaveBeenCalled();
  });
});

// Deciding approvals one at a time is what made parallel approvals fragile:
// each resume ran one tool and persisted its result on its own row, leaving the
// shared assistant message's calls answered non-adjacently. Answering them
// together is the structural fix, not just fewer clicks.
describe('resumeAfterApprovals — batch', () => {
  const second = () => ({
    ...chatEntry(),
    approvalId: 'appr-2',
    toolCallId: 'toolu_second',
    toolName: 'edit_file',
  });

  it('resumes once for the whole batch', async () => {
    const res = await resumeAfterApprovals({
      decisions: [
        { approvalId: APPROVAL_ID, decision: decision(true), registryEntry: chatEntry() },
        { approvalId: 'appr-2', decision: decision(true), registryEntry: second() },
      ],
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res.success).toBe(true);
    expect(runStream).toHaveBeenCalledTimes(1);
  });

  it('sends every approval-response in one tool message', async () => {
    await resumeAfterApprovals({
      decisions: [
        { approvalId: APPROVAL_ID, decision: decision(true), registryEntry: chatEntry() },
        { approvalId: 'appr-2', decision: decision(false), registryEntry: second() },
      ],
      getMainWindow,
      toolStates: new Map(),
    });

    const opts = runStream.mock.calls[0][0] as {
      formattedResult: { messages: Array<{ role?: string; content?: Array<Record<string, unknown>> }> };
    };
    const messages = opts.formattedResult.messages;
    const last = messages[messages.length - 1]!;

    expect(last.role).toBe('tool');
    expect(last.content).toHaveLength(2);
    expect(last.content).toEqual([
      expect.objectContaining({ type: 'tool-approval-response', approvalId: APPROVAL_ID, approved: true }),
      expect.objectContaining({ type: 'tool-approval-response', approvalId: 'appr-2', approved: false }),
    ]);
  });

  it('marks every decision on the original message, not just the first', async () => {
    // A turn that raised two approvals carries a pending block for each.
    const twoPending = suspendedMessage();
    twoPending.contentBlocks = [
      pendingBlock(),
      {
        type: 'tool-approval',
        approval: {
          approvalId: 'appr-2', toolCallId: 'toolu_second',
          toolName: 'edit_file', input: {}, status: 'pending',
        },
      },
    ];
    channelRepo.getDirectChatById.mockReturnValue({
      id: CHAT_ID, participants: [], messages: [twoPending],
    });

    await resumeAfterApprovals({
      decisions: [
        { approvalId: APPROVAL_ID, decision: decision(true), registryEntry: chatEntry() },
        { approvalId: 'appr-2', decision: decision(false), registryEntry: second() },
      ],
      getMainWindow,
      toolStates: new Map(),
    });

    // Both blocks decided — a batch that recorded only the first would leave
    // the rest showing as pending forever in the UI.
    // Each decision does its own read-modify-write of the message's blocks;
    // in production the next read sees the previous write, so assert across
    // the writes rather than within a single one.
    const written = channelRepo.updateMessage.mock.calls
      .flatMap((call: unknown[]) => ((call[1] as { contentBlocks?: unknown[] })?.contentBlocks ?? []) as Array<{ type: string; approval?: { approvalId: string; status: string } }>)
      .filter(b => b.type === 'tool-approval');
    // `some`, not `find`: the repo mock returns a fixed snapshot, so each
    // write carries its own decision and the other still pending. Production
    // reads back the previous write; what matters here is that BOTH decisions
    // were written at all.
    expect(written.some(b => b.approval?.approvalId === APPROVAL_ID && b.approval.status === 'approved')).toBe(true);
    expect(written.some(b => b.approval?.approvalId === 'appr-2' && b.approval.status === 'denied')).toBe(true);
  });

  it('refuses a batch spanning two conversations', async () => {
    const res = await resumeAfterApprovals({
      decisions: [
        { approvalId: APPROVAL_ID, decision: decision(true), registryEntry: chatEntry() },
        { approvalId: 'appr-2', decision: decision(true), registryEntry: { ...second(), contextId: 'chat-other' } },
      ],
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/same conversation/i);
    expect(runStream).not.toHaveBeenCalled();
  });

  it('refuses an empty batch', async () => {
    const res = await resumeAfterApprovals({ decisions: [], getMainWindow, toolStates: new Map() });
    expect(res.success).toBe(false);
    expect(runStream).not.toHaveBeenCalled();
  });

  it('names a missing approval rather than silently resuming the rest', async () => {
    const res = await resumeAfterApprovals({
      decisions: [
        { approvalId: APPROVAL_ID, decision: decision(true), registryEntry: chatEntry() },
        { approvalId: 'appr-gone', decision: decision(true) },
      ],
      getMainWindow,
      toolStates: new Map(),
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('appr-gone');
    expect(runStream).not.toHaveBeenCalled();
  });

  it('still works through the single-approval entry point', async () => {
    const res = await resumeAfterApproval({
      approvalId: APPROVAL_ID,
      decision: decision(true),
      registryEntry: chatEntry(),
      getMainWindow,
      toolStates: new Map(),
    });
    expect(res.success).toBe(true);
    const opts = runStream.mock.calls[0][0] as {
      formattedResult: { messages: Array<{ content?: Array<Record<string, unknown>> }> };
    };
    const last = opts.formattedResult.messages.at(-1)!;
    expect(last.content).toHaveLength(1);
  });
});
