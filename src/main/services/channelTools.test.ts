import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  requestChannelDispatch,
  channelRepo,
  agentRepo,
  userRepo,
  emitEvent,
} = vi.hoisted(() => ({
  requestChannelDispatch: vi.fn(),
  channelRepo: {
    getById: vi.fn(),
    getAll: vi.fn(),
    create: vi.fn(),
    createMessage: vi.fn(),
    addParticipant: vi.fn(),
    getMessagesByChannelId: vi.fn(),
  },
  agentRepo: {
    getById: vi.fn(),
    getAll: vi.fn(),
  },
  userRepo: {
    getAll: vi.fn(),
  },
  emitEvent: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../repositories', () => ({
  getChannelRepository: () => channelRepo,
  getAgentRepository: () => agentRepo,
  getUserRepository: () => userRepo,
}));

vi.mock('./EventBus', () => ({
  eventBus: { emitEvent },
}));

vi.mock('./ChannelDispatcher', () => ({
  requestChannelDispatch,
}));

import { createChannelTools } from './channelTools';

const exec = async (tool: { execute?: (...args: any[]) => any }, args: unknown) =>
  tool.execute!(args as never, {} as never);

describe('createChannelTools', () => {
  const agentId = 'agent-1';
  const currentChannelId = 'ch-current';

  beforeEach(() => {
    vi.clearAllMocks();
    agentRepo.getById.mockReturnValue({
      id: agentId,
      name: 'Alice',
      color: '#f00',
    });
  });

  describe('channel_send_message', () => {
    it('blocks send to the current channel (ADR-001: write reply, do not tool-post)', async () => {
      const tools = createChannelTools(agentId, currentChannelId);
      const result = await exec(tools.channel_send_message, {
        channelId: currentChannelId,
        content: 'hi @Bob',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/current channel/i);
      expect(channelRepo.createMessage).not.toHaveBeenCalled();
      expect(requestChannelDispatch).not.toHaveBeenCalled();
    });

    it('fails when channel or agent is missing, or caller is not a participant', async () => {
      const tools = createChannelTools(agentId, currentChannelId);

      channelRepo.getById.mockReturnValue(null);
      expect(
        await exec(tools.channel_send_message, { channelId: 'other', content: 'x' }),
      ).toEqual({ success: false, error: 'Channel not found' });

      channelRepo.getById.mockReturnValue({ id: 'other', participants: [] });
      agentRepo.getById.mockReturnValueOnce(null);
      expect(
        await exec(tools.channel_send_message, { channelId: 'other', content: 'x' }),
      ).toEqual({ success: false, error: 'Agent not found' });

      agentRepo.getById.mockReturnValue({ id: agentId, name: 'Alice', color: '#f00' });
      channelRepo.getById.mockReturnValue({
        id: 'other',
        participants: [{ id: 'someone-else' }],
      });
      expect(
        await exec(tools.channel_send_message, { channelId: 'other', content: 'x' }),
      ).toEqual({ success: false, error: 'You are not a participant in this channel' });

      expect(requestChannelDispatch).not.toHaveBeenCalled();
    });

    it('posts and dispatches as a chain-root intent (depth 0)', async () => {
      const tools = createChannelTools(agentId, currentChannelId);
      channelRepo.getById.mockReturnValue({
        id: 'ch-target',
        participants: [{ id: agentId }],
      });
      channelRepo.createMessage.mockReturnValue({ id: 'msg-1' });

      const result = await exec(tools.channel_send_message, {
        channelId: 'ch-target',
        content: 'hello @Bob',
      });

      expect(result).toEqual({ success: true, messageId: 'msg-1' });
      expect(channelRepo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'ch-target',
          senderId: agentId,
          senderType: 'agent',
          content: 'hello @Bob',
        }),
      );
      expect(requestChannelDispatch).toHaveBeenCalledWith({
        channelId: 'ch-target',
        triggerMessageId: 'msg-1',
        triggerContent: 'hello @Bob',
        senderId: agentId,
        senderType: 'agent',
        chainDepth: 0,
      });
    });

    it('allows send when no currentChannelId is scoped', async () => {
      const tools = createChannelTools(agentId);
      channelRepo.getById.mockReturnValue({
        id: 'ch-target',
        participants: [{ id: agentId }],
      });
      channelRepo.createMessage.mockReturnValue({ id: 'msg-2' });
      const result = await exec(tools.channel_send_message, {
        channelId: 'ch-target',
        content: 'unscoped',
      });
      expect(result.success).toBe(true);
      expect(requestChannelDispatch).toHaveBeenCalled();
    });
  });

  describe('channel_list', () => {
    it('returns only channels the caller participates in', async () => {
      const tools = createChannelTools(agentId);
      channelRepo.getAll.mockReturnValue([
        {
          id: 'a',
          name: 'A',
          type: 'public',
          participants: [
            { id: agentId, displayName: 'Alice', type: 'agent' },
            { id: 'u1', displayName: 'User', type: 'human' },
          ],
        },
        {
          id: 'b',
          name: 'B',
          type: 'project',
          participants: [{ id: 'other', displayName: 'Other', type: 'agent' }],
        },
      ]);

      const result = await exec(tools.channel_list, {});
      expect(result.channelCount).toBe(1);
      expect(result.channels).toHaveLength(1);
      expect(result.channels[0].id).toBe('a');
      expect(result.channels[0].participantCount).toBe(2);
    });
  });

  describe('channel_create', () => {
    it('fails when agent missing; otherwise creates with caller as participant', async () => {
      agentRepo.getById.mockReturnValueOnce(null);
      const tools = createChannelTools(agentId);
      expect(await exec(tools.channel_create, { name: 'N' })).toEqual({
        success: false,
        error: 'Agent not found',
      });

      agentRepo.getById.mockReturnValue({ id: agentId, name: 'Alice', color: '#f00' });
      channelRepo.create.mockReturnValue({ id: 'ch-new', name: 'N' });
      const result = await exec(tools.channel_create, { name: 'N', type: 'project' });
      expect(result).toEqual({ success: true, channelId: 'ch-new', name: 'N' });
      expect(channelRepo.create).toHaveBeenCalledWith(
        { name: 'N', type: 'project' },
        [expect.objectContaining({ id: agentId, type: 'agent', displayName: 'Alice' })],
      );
      expect(emitEvent).toHaveBeenCalledWith('channel:created', {
        channelId: 'ch-new',
        name: 'N',
      });
    });
  });

  describe('channel_invite', () => {
    it('requires channel membership and resolves agent then user by name (case-insensitive)', async () => {
      const tools = createChannelTools(agentId);

      channelRepo.getById.mockReturnValue(null);
      expect(
        await exec(tools.channel_invite, { channelId: 'c', participantName: 'Bob' }),
      ).toEqual({ success: false, error: 'Channel not found' });

      channelRepo.getById.mockReturnValue({ id: 'c', participants: [] });
      expect(
        await exec(tools.channel_invite, { channelId: 'c', participantName: 'Bob' }),
      ).toEqual({ success: false, error: 'You are not a participant in this channel' });

      channelRepo.getById.mockReturnValue({
        id: 'c',
        participants: [{ id: agentId }],
      });
      agentRepo.getAll.mockReturnValue([{ id: 'agent-bob', name: 'Bob', color: '#0f0' }]);
      expect(
        await exec(tools.channel_invite, { channelId: 'c', participantName: 'bob' }),
      ).toEqual({ success: true, invited: 'Bob', type: 'agent' });
      expect(channelRepo.addParticipant).toHaveBeenCalledWith(
        'c',
        expect.objectContaining({ id: 'agent-bob', type: 'agent' }),
      );

      agentRepo.getAll.mockReturnValue([]);
      userRepo.getAll.mockReturnValue([{ id: 'u1', name: 'Robin', color: '#00f' }]);
      expect(
        await exec(tools.channel_invite, { channelId: 'c', participantName: 'ROBIN' }),
      ).toEqual({ success: true, invited: 'Robin', type: 'human' });

      userRepo.getAll.mockReturnValue([]);
      expect(
        await exec(tools.channel_invite, { channelId: 'c', participantName: 'Nobody' }),
      ).toEqual({ success: false, error: 'No agent or user found with name "Nobody"' });
    });
  });

  describe('channel_history', () => {
    it('clamps limit and maps messages; rejects non-participants', async () => {
      const tools = createChannelTools(agentId);
      channelRepo.getById.mockReturnValue({
        id: 'c',
        name: 'Room',
        participants: [],
      });
      expect(await exec(tools.channel_history, { channelId: 'c' })).toEqual({
        success: false,
        error: 'You are not a participant in this channel',
      });

      channelRepo.getById.mockReturnValue({
        id: 'c',
        name: 'Room',
        participants: [{ id: agentId }],
      });
      channelRepo.getMessagesByChannelId.mockReturnValue([
        {
          id: 'm1',
          senderDisplayName: 'Alice',
          senderType: 'agent',
          content: 'hi',
          timestamp: 1_700_000_000_000,
        },
      ]);

      const result = await exec(tools.channel_history, { channelId: 'c', limit: 999 });
      expect(channelRepo.getMessagesByChannelId).toHaveBeenCalledWith('c', 50);
      expect(result.channelName).toBe('Room');
      expect(result.messageCount).toBe(1);
      expect(result.messages[0]).toMatchObject({
        id: 'm1',
        sender: 'Alice',
        content: 'hi',
      });

      await exec(tools.channel_history, { channelId: 'c', limit: 0 });
      expect(channelRepo.getMessagesByChannelId).toHaveBeenLastCalledWith('c', 1);
    });

    it('reports a missing channel before the participant check', async () => {
      const tools = createChannelTools(agentId);
      channelRepo.getById.mockReturnValue(null);
      expect(await exec(tools.channel_history, { channelId: 'gone' })).toEqual({
        success: false,
        error: 'Channel not found',
      });
    });

    it('defaults to the last 20 messages when no limit is given', async () => {
      const tools = createChannelTools(agentId);
      channelRepo.getById.mockReturnValue({
        id: 'c',
        name: 'Room',
        participants: [{ id: agentId }],
      });
      channelRepo.getMessagesByChannelId.mockReturnValue([]);

      await exec(tools.channel_history, { channelId: 'c' });
      expect(channelRepo.getMessagesByChannelId).toHaveBeenLastCalledWith('c', 20);
    });
  });
});
