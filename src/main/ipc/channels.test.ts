import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import { registerChannelHandlers } from './channels';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
}));

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../repositories', () => ({
  getChannelRepository: vi.fn(),
  getProjectRepository: vi.fn(),
  getAgentRepository: vi.fn(),
  getSettingsRepository: vi.fn(),
  getUserRepository: vi.fn(),
  getMessageAttachmentRepository: vi.fn(() => ({})),
  getToolStateRepository: vi.fn(() => ({ delete: vi.fn() })),
}));

const mockDispatcher = {
  requestDispatch: vi.fn().mockResolvedValue(undefined),
  dispatchSelectedAgent: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../services/ChannelDispatcher', () => ({
  clearChannelDispatcherState: vi.fn(),
  getChannelDispatcher: () => mockDispatcher,
}));

import {
  getChannelRepository,
  getAgentRepository,
  getSettingsRepository,
  getUserRepository,
} from '../repositories';

describe('Channel IPC Handlers', () => {
  let mockChannelRepo: {
    create: Mock;
    getAll: Mock;
    getById: Mock;
    update: Mock;
    delete: Mock;
    archive: Mock;
    unarchive: Mock;
    search: Mock;
    getByTags: Mock;
    addParticipant: Mock;
    createMessage: Mock;
    updateMessage: Mock;
    updateMessageText: Mock;
    deleteMessage: Mock;
    bulkCreateMessages: Mock;
  };
  let mockSettingsRepo: {
    setCurrentChannel: Mock;
    get: Mock;
    getCurrentState: Mock;
  };
  let mockUserRepo: { getCurrent: Mock; getById: Mock };
  let mockAgentRepo: { getById: Mock };
  let handlers: Map<string, Function>;
  let mockMainWindow: { webContents: { send: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();

    mockChannelRepo = {
      create: vi.fn(),
      getAll: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      search: vi.fn(),
      getByTags: vi.fn(),
      addParticipant: vi.fn(),
      createMessage: vi.fn(),
      updateMessage: vi.fn(),
      updateMessageText: vi.fn().mockReturnValue({ contentBlocks: null }),
      deleteMessage: vi.fn(),
      bulkCreateMessages: vi.fn(),
    };
    mockSettingsRepo = {
      setCurrentChannel: vi.fn(),
      get: vi.fn(),
      getCurrentState: vi.fn(),
    };
    mockUserRepo = { getCurrent: vi.fn(), getById: vi.fn() };
    mockAgentRepo = { getById: vi.fn() };

    (getChannelRepository as Mock).mockReturnValue(mockChannelRepo);
    (getSettingsRepository as Mock).mockReturnValue(mockSettingsRepo);
    (getUserRepository as Mock).mockReturnValue(mockUserRepo);
    (getAgentRepository as Mock).mockReturnValue(mockAgentRepo);

    mockMainWindow = { webContents: { send: vi.fn() } };

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerChannelHandlers(() => mockMainWindow as unknown as BrowserWindow);
  });

  afterEach(() => vi.clearAllMocks());

  describe('create-channel', () => {
    it('should create channel with valid data', async () => {
      const handler = handlers.get('create-channel')!;
      const mockChannel = { id: 'ch-1', name: 'general', type: 'public' };
      const mockUser = { id: 'user-1', name: 'Test User', color: '#fff' };
      mockUserRepo.getCurrent.mockReturnValue(mockUser);
      mockChannelRepo.create.mockReturnValue(mockChannel);

      const result = await handler({}, { name: 'general', type: 'public' });

      expect(result).toEqual({ success: true, channel: mockChannel });
      expect(mockSettingsRepo.setCurrentChannel).toHaveBeenCalledWith('ch-1');
      expect(mockChannelRepo.create).toHaveBeenCalledWith(
        { name: 'general', type: 'public', projectId: undefined },
        expect.arrayContaining([
          expect.objectContaining({ id: 'user-1', type: 'human' }),
        ])
      );
    });

    it('should return error if no current user', async () => {
      const handler = handlers.get('create-channel')!;
      mockUserRepo.getCurrent.mockReturnValue(null);

      const result = await handler({}, { name: 'general', type: 'public' });

      expect(result).toEqual({ success: false, error: 'No current user' });
    });

    it('should reject empty channel name', async () => {
      const handler = handlers.get('create-channel')!;
      const result = await handler({}, { name: '', type: 'public' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('switch-channel', () => {
    it('should switch to existing channel and return it with messages', async () => {
      const handler = handlers.get('switch-channel')!;
      const channel = { id: 'ch-1', name: 'general', messages: [{ id: 'msg-1', content: 'hi' }] };
      mockChannelRepo.getById.mockReturnValue(channel);

      const result = await handler({}, 'ch-1');

      // The renderer hydrates the open channel from this payload — history is
      // not in the list projection, so dropping it re-blanks the channel view.
      expect(result).toEqual({ success: true, channel });
      expect(mockSettingsRepo.setCurrentChannel).toHaveBeenCalledWith('ch-1');
    });

    it('should return failure for non-existent channel', async () => {
      const handler = handlers.get('switch-channel')!;
      mockChannelRepo.getById.mockReturnValue(null);

      const result = await handler({}, 'non-existent');

      expect(result).toEqual({ success: false });
    });

    it('should reject empty channel ID', async () => {
      const handler = handlers.get('switch-channel')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('send-message', () => {
    it('should send message to valid channel', async () => {
      const handler = handlers.get('send-message')!;
      const mockChannel = { id: 'ch-1', name: 'general' };
      const mockUser = { id: 'user-1', name: 'Test', color: '#fff' };
      const mockMessage = { id: 'msg-1', content: 'Hello', senderId: 'user-1' };
      mockChannelRepo.getById.mockReturnValue(mockChannel);
      mockUserRepo.getCurrent.mockReturnValue(mockUser);
      mockChannelRepo.createMessage.mockReturnValue(mockMessage);

      const result = await handler({}, { channelId: 'ch-1', content: 'Hello' });

      expect(result.success).toBe(true);
      expect(result.message).toEqual(mockMessage);
    });

    it('produces a chain-root dispatch intent after persisting (ADR-001 Decision 2)', async () => {
      const handler = handlers.get('send-message')!;
      mockChannelRepo.getById.mockReturnValue({ id: 'ch-1' });
      mockUserRepo.getCurrent.mockReturnValue({ id: 'user-1', name: 'Test', color: '#fff' });
      mockChannelRepo.createMessage.mockReturnValue({ id: 'msg-1' });

      await handler({}, { channelId: 'ch-1', content: '@Bot hello' });

      expect(mockDispatcher.requestDispatch).toHaveBeenCalledWith({
        channelId: 'ch-1',
        triggerMessageId: 'msg-1',
        triggerContent: '@Bot hello',
        senderId: 'user-1',
        senderType: 'human',
        chainDepth: 0,
        addressedAgentId: undefined,
      });
      expect(mockDispatcher.dispatchSelectedAgent).not.toHaveBeenCalled();
    });

    it('a selected-agent send produces a single-target intent shape and runs the selected turn', async () => {
      const handler = handlers.get('send-message')!;
      mockChannelRepo.getById.mockReturnValue({ id: 'ch-1' });
      mockUserRepo.getCurrent.mockReturnValue({ id: 'user-1', name: 'Test', color: '#fff' });
      mockAgentRepo.getById.mockReturnValue({ id: 'agent-1', name: 'Bot' });
      mockChannelRepo.createMessage.mockReturnValue({ id: 'msg-1' });

      await handler({}, { channelId: 'ch-1', content: 'do the thing', agentId: 'agent-1' });

      // addressedAgentId travels in the intent — suppression is intent shape,
      // not persisted metadata (which is kept for observability only).
      expect(mockDispatcher.requestDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ triggerMessageId: 'msg-1', addressedAgentId: 'agent-1' }),
      );
      expect(mockChannelRepo.createMessage).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { participantType: 'human', addressedAgentId: 'agent-1' },
      }));
      expect(mockDispatcher.dispatchSelectedAgent).toHaveBeenCalledWith(
        'ch-1', 'agent-1', 'msg-1', expect.any(AbortSignal),
      );
    });

    it('should return error if channel not found', async () => {
      const handler = handlers.get('send-message')!;
      mockChannelRepo.getById.mockReturnValue(null);
      mockUserRepo.getCurrent.mockReturnValue({ id: 'user-1' });

      const result = await handler({}, { channelId: 'non-existent', content: 'Hello' });

      expect(result).toEqual({ success: false, error: 'Channel not found' });
    });

    it('should return error if no current user', async () => {
      const handler = handlers.get('send-message')!;
      mockChannelRepo.getById.mockReturnValue({ id: 'ch-1' });
      mockUserRepo.getCurrent.mockReturnValue(null);

      const result = await handler({}, { channelId: 'ch-1', content: 'Hello' });

      expect(result).toEqual({ success: false, error: 'No current user' });
    });

    it('should reject empty content', async () => {
      const handler = handlers.get('send-message')!;
      const result = await handler({}, { channelId: 'ch-1', content: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('add-agent-message', () => {
    it('should add agent message and auto-join agent', async () => {
      const handler = handlers.get('add-agent-message')!;
      const mockChannel = { id: 'ch-1', participants: [] };
      const mockAgent = { id: 'agent-1', name: 'Bot', color: '#00f' };
      const mockMessage = { id: 'msg-1', content: 'Response' };
      mockChannelRepo.getById.mockReturnValue(mockChannel);
      mockAgentRepo.getById.mockReturnValue(mockAgent);
      mockChannelRepo.createMessage.mockReturnValue(mockMessage);

      const result = await handler({}, {
        channelId: 'ch-1', agentId: 'agent-1', content: 'Response',
      });

      expect(result.success).toBe(true);
      expect(result.message).toEqual(mockMessage);
      expect(mockChannelRepo.addParticipant).toHaveBeenCalledWith('ch-1', expect.objectContaining({
        id: 'agent-1', type: 'agent', displayName: 'Bot',
      }));
    });

    it('should not re-add existing participant', async () => {
      const handler = handlers.get('add-agent-message')!;
      const mockChannel = { id: 'ch-1', participants: [{ id: 'agent-1', type: 'agent' }] };
      const mockAgent = { id: 'agent-1', name: 'Bot', color: '#00f' };
      mockChannelRepo.getById.mockReturnValue(mockChannel);
      mockAgentRepo.getById.mockReturnValue(mockAgent);
      mockChannelRepo.createMessage.mockReturnValue({ id: 'msg-1' });

      await handler({}, { channelId: 'ch-1', agentId: 'agent-1', content: 'Hi' });

      expect(mockChannelRepo.addParticipant).not.toHaveBeenCalled();
    });

    it('should return error if channel not found', async () => {
      const handler = handlers.get('add-agent-message')!;
      mockChannelRepo.getById.mockReturnValue(null);
      mockAgentRepo.getById.mockReturnValue({ id: 'agent-1' });

      const result = await handler({}, { channelId: 'x', agentId: 'agent-1', content: 'Hi' });

      expect(result).toEqual({ success: false, error: 'Channel not found' });
    });

    it('should return error if agent not found', async () => {
      const handler = handlers.get('add-agent-message')!;
      mockChannelRepo.getById.mockReturnValue({ id: 'ch-1', participants: [] });
      mockAgentRepo.getById.mockReturnValue(null);

      const result = await handler({}, { channelId: 'ch-1', agentId: 'x', content: 'Hi' });

      expect(result).toEqual({ success: false, error: 'Agent not found' });
    });
  });

  describe('add-channel-participant', () => {
    it('should add agent as participant', async () => {
      const handler = handlers.get('add-channel-participant')!;
      mockChannelRepo.getById.mockReturnValue({ id: 'ch-1' });
      mockAgentRepo.getById.mockReturnValue({ id: 'agent-1', name: 'Bot', color: '#00f' });

      const result = await handler({}, { channelId: 'ch-1', participantId: 'agent-1' });

      expect(result).toEqual({ success: true });
      expect(mockChannelRepo.addParticipant).toHaveBeenCalledWith('ch-1', expect.objectContaining({
        id: 'agent-1', type: 'agent',
      }));
    });

    it('should add user as participant when not an agent', async () => {
      const handler = handlers.get('add-channel-participant')!;
      mockChannelRepo.getById.mockReturnValue({ id: 'ch-1' });
      mockAgentRepo.getById.mockReturnValue(null);
      mockUserRepo.getById.mockReturnValue({ id: 'user-2', name: 'User', color: '#0f0' });

      const result = await handler({}, { channelId: 'ch-1', participantId: 'user-2' });

      expect(result).toEqual({ success: true });
      expect(mockChannelRepo.addParticipant).toHaveBeenCalledWith('ch-1', expect.objectContaining({
        id: 'user-2', type: 'human',
      }));
    });

    it('should return error if neither agent nor user found', async () => {
      const handler = handlers.get('add-channel-participant')!;
      mockChannelRepo.getById.mockReturnValue({ id: 'ch-1' });
      mockAgentRepo.getById.mockReturnValue(null);
      mockUserRepo.getById.mockReturnValue(null);

      const result = await handler({}, { channelId: 'ch-1', participantId: 'unknown' });

      expect(result).toEqual({ success: false, error: 'Participant not found' });
    });

    it('should return error if channel not found', async () => {
      const handler = handlers.get('add-channel-participant')!;
      mockChannelRepo.getById.mockReturnValue(null);

      const result = await handler({}, { channelId: 'x', participantId: 'agent-1' });

      expect(result).toEqual({ success: false, error: 'Channel not found' });
    });
  });

  describe('update-channel', () => {
    it('should update channel name', async () => {
      const handler = handlers.get('update-channel')!;
      const mockUpdated = { id: 'ch-1', name: 'renamed' };
      mockChannelRepo.update.mockReturnValue(mockUpdated);

      const result = await handler({}, { channelId: 'ch-1', updates: { name: 'renamed' } });

      expect(result).toEqual(mockUpdated);
    });

    it('should update channel pinned status', async () => {
      const handler = handlers.get('update-channel')!;
      mockChannelRepo.update.mockReturnValue({ id: 'ch-1', pinned: true });

      const result = await handler({}, { channelId: 'ch-1', updates: { pinned: true } });

      expect(result.pinned).toBe(true);
      expect(mockChannelRepo.update).toHaveBeenCalledWith('ch-1', { pinned: true });
    });

    it('should update channel tags with a validated string array', async () => {
      const handler = handlers.get('update-channel')!;
      mockChannelRepo.update.mockReturnValue({ id: 'ch-1', tags: ['work', 'planning'] });

      const result = await handler({}, { channelId: 'ch-1', updates: { tags: ['work', 'planning'] } });

      expect(result.tags).toEqual(['work', 'planning']);
      expect(mockChannelRepo.update).toHaveBeenCalledWith('ch-1', { tags: ['work', 'planning'] });
    });

    it('should accept tags: null to clear the tag list', async () => {
      const handler = handlers.get('update-channel')!;
      mockChannelRepo.update.mockReturnValue({ id: 'ch-1' });

      await handler({}, { channelId: 'ch-1', updates: { tags: null } });

      expect(mockChannelRepo.update).toHaveBeenCalledWith('ch-1', { tags: null });
    });

    it('should reject a non-array tags value', async () => {
      const handler = handlers.get('update-channel')!;

      const result = await handler({}, { channelId: 'ch-1', updates: { tags: 'work, planning' } });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockChannelRepo.update).not.toHaveBeenCalled();
    });

    it('should reject empty-string tags', async () => {
      const handler = handlers.get('update-channel')!;

      const result = await handler({}, { channelId: 'ch-1', updates: { tags: ['ok', ''] } });

      expect(result.success).toBe(false);
      expect(mockChannelRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('get-channels', () => {
    it('should list channels excluding archived by default', async () => {
      const handler = handlers.get('get-channels')!;
      const channels = [{ id: 'ch-1', name: 'general' }];
      mockChannelRepo.getAll.mockReturnValue(channels);

      const result = await handler({}, undefined);

      expect(result).toEqual({ success: true, channels });
      expect(mockChannelRepo.getAll).toHaveBeenCalledWith({ includeArchived: undefined });
    });

    it('should pass includeArchived through', async () => {
      const handler = handlers.get('get-channels')!;
      mockChannelRepo.getAll.mockReturnValue([]);

      const result = await handler({}, { includeArchived: true });

      expect(result.success).toBe(true);
      expect(mockChannelRepo.getAll).toHaveBeenCalledWith({ includeArchived: true });
    });

    it('should reject a non-boolean includeArchived', async () => {
      const handler = handlers.get('get-channels')!;

      const result = await handler({}, { includeArchived: 'yes' });

      expect(result.success).toBe(false);
      expect(mockChannelRepo.getAll).not.toHaveBeenCalled();
    });
  });

  describe('archive-channel', () => {
    it('should archive channel and return it', async () => {
      const handler = handlers.get('archive-channel')!;
      const archived = { id: 'ch-1', name: 'general', archivedAt: 12345 };
      mockChannelRepo.archive.mockReturnValue(archived);

      const result = await handler({}, 'ch-1');

      expect(result).toEqual({ success: true, channel: archived });
      expect(mockChannelRepo.archive).toHaveBeenCalledWith('ch-1');
    });

    it('should return error when channel not found', async () => {
      const handler = handlers.get('archive-channel')!;
      mockChannelRepo.archive.mockReturnValue(null);

      const result = await handler({}, 'non-existent');

      expect(result).toEqual({ success: false, error: 'Channel not found' });
    });

    it('should reject empty channel ID', async () => {
      const handler = handlers.get('archive-channel')!;

      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(mockChannelRepo.archive).not.toHaveBeenCalled();
    });
  });

  describe('unarchive-channel', () => {
    it('should unarchive channel and return it', async () => {
      const handler = handlers.get('unarchive-channel')!;
      const restored = { id: 'ch-1', name: 'general' };
      mockChannelRepo.unarchive.mockReturnValue(restored);

      const result = await handler({}, 'ch-1');

      expect(result).toEqual({ success: true, channel: restored });
      expect(mockChannelRepo.unarchive).toHaveBeenCalledWith('ch-1');
    });

    it('should return error when channel not found', async () => {
      const handler = handlers.get('unarchive-channel')!;
      mockChannelRepo.unarchive.mockReturnValue(null);

      const result = await handler({}, 'non-existent');

      expect(result).toEqual({ success: false, error: 'Channel not found' });
    });
  });

  describe('search-channels', () => {
    it('should search with query and archived scoping', async () => {
      const handler = handlers.get('search-channels')!;
      const channels = [{ id: 'ch-1', name: 'roadmap' }];
      mockChannelRepo.search.mockReturnValue(channels);

      const result = await handler({}, { query: 'road', includeArchived: true });

      expect(result).toEqual({ success: true, channels });
      expect(mockChannelRepo.search).toHaveBeenCalledWith('road', { includeArchived: true });
    });

    it('should default includeArchived to undefined (repo excludes archived)', async () => {
      const handler = handlers.get('search-channels')!;
      mockChannelRepo.search.mockReturnValue([]);

      await handler({}, { query: 'road' });

      expect(mockChannelRepo.search).toHaveBeenCalledWith('road', { includeArchived: undefined });
    });

    it('should reject a missing query', async () => {
      const handler = handlers.get('search-channels')!;

      const result = await handler({}, { includeArchived: true });

      expect(result.success).toBe(false);
      expect(mockChannelRepo.search).not.toHaveBeenCalled();
    });
  });

  describe('get-channels-by-tags', () => {
    it('should fetch channels by tags', async () => {
      const handler = handlers.get('get-channels-by-tags')!;
      const channels = [{ id: 'ch-1', tags: ['work'] }];
      mockChannelRepo.getByTags.mockReturnValue(channels);

      const result = await handler({}, { tags: ['work'], includeArchived: false });

      expect(result).toEqual({ success: true, channels });
      expect(mockChannelRepo.getByTags).toHaveBeenCalledWith(['work'], { includeArchived: false });
    });

    it('should reject a non-array tags value', async () => {
      const handler = handlers.get('get-channels-by-tags')!;

      const result = await handler({}, { tags: 'work' });

      expect(result.success).toBe(false);
      expect(mockChannelRepo.getByTags).not.toHaveBeenCalled();
    });

    it('should reject empty-string tags', async () => {
      const handler = handlers.get('get-channels-by-tags')!;

      const result = await handler({}, { tags: [''] });

      expect(result.success).toBe(false);
      expect(mockChannelRepo.getByTags).not.toHaveBeenCalled();
    });
  });

  describe('delete-channel', () => {
    it('should delete channel', async () => {
      const handler = handlers.get('delete-channel')!;

      const result = await handler({}, 'ch-1');

      expect(result).toEqual({ success: true });
      expect(mockChannelRepo.delete).toHaveBeenCalledWith('ch-1');
    });
  });

  describe('update-message', () => {
    it('should update message content and broadcast', async () => {
      const blocks = [{ type: 'text', content: 'Updated content' }];
      mockChannelRepo.updateMessageText.mockReturnValue({ contentBlocks: blocks });

      const handler = handlers.get('update-message')!;
      const result = await handler({}, { messageId: 'msg-1', content: 'Updated content' });

      expect(result).toEqual({ success: true, contentBlocks: blocks });
      expect(mockChannelRepo.updateMessageText).toHaveBeenCalledWith('msg-1', 'Updated content');
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('message-updated', {
        messageId: 'msg-1',
        contentBlocks: blocks,
        content: 'Updated content',
      });
    });

    it('should fail when message not found', async () => {
      mockChannelRepo.updateMessageText.mockReturnValue(null);

      const handler = handlers.get('update-message')!;
      const result = await handler({}, { messageId: 'msg-1', content: 'Updated content' });

      expect(result.success).toBe(false);
    });
  });

  describe('delete-message', () => {
    it('should delete message', async () => {
      const handler = handlers.get('delete-message')!;

      const result = await handler({}, 'msg-1');

      expect(result).toEqual({ success: true });
      expect(mockChannelRepo.deleteMessage).toHaveBeenCalledWith('msg-1');
    });
  });

  describe('stop-stream', () => {
    it('should return error when no active agent', async () => {
      const handler = handlers.get('stop-stream')!;
      mockSettingsRepo.getCurrentState.mockReturnValue({ channelId: 'ch-1' });

      const result = await handler({}, { channelId: 'ch-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No active agent');
    });

    it('should return error when no active stream', async () => {
      const handler = handlers.get('stop-stream')!;
      mockSettingsRepo.getCurrentState.mockReturnValue({ channelId: 'ch-1', agentId: 'agent-1' });

      const result = await handler({}, { channelId: 'ch-1', agentId: 'agent-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No active stream found');
    });
  });

});
