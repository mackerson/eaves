import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import { registerChatHandlers } from './chats';
import * as repositories from '../repositories';
import { logger } from '../services/logger';
import * as fs from 'fs';
import * as path from 'path';
import {
  Chat,
  ChatMessage,
  User,
  Agent
} from '../../shared/types';

// Mock all dependencies
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return '/';
      if (name === 'temp') return '/tmp';
      return '/mock/user/data';
    }),
  },
}));

vi.mock('../repositories', () => ({
  getChannelRepository: vi.fn(),
  getAgentRepository: vi.fn(),
  getSettingsRepository: vi.fn(),
  getUserRepository: vi.fn(),
  getMessageAttachmentRepository: vi.fn(),
}));

vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Create shared mock for ChatService
const mockChatServiceInstance = {
  chatWithAgent: vi.fn(),
  stopStream: vi.fn(),
  generateMetadata: vi.fn(),
  getChatTools: vi.fn(),
  toggleChatTool: vi.fn(),
  clearChatState: vi.fn(),
};

// Mock ChatService as a class
vi.mock('../services/ChatService', () => {
  return {
    ChatService: function() {
      return mockChatServiceInstance;
    }
  };
});

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  default: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('path', async () => {
  // Keep real relative/normalize/isAbsolute (used by isInsideDirectory in the
  // attachment path-containment check); only stub the four the tests drive.
  // Sourced via 'node:path' (unaffected by the 'path' mock) since importOriginal
  // returns empty for this builtin under the happy-dom env.
  const real = (await import('node:path')).default;
  const mocked = {
    relative: real.relative,
    normalize: real.normalize,
    isAbsolute: real.isAbsolute,
    sep: real.sep,
    extname: vi.fn(),
    basename: vi.fn(),
    join: vi.fn(),
    resolve: vi.fn((p: string) => p),
  };
  return { ...mocked, default: mocked };
});
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    default: actual,
    randomUUID: vi.fn(() => 'mock-uuid'),
  };
});

describe('Chat IPC Handlers', () => {
  let mockChatRepo: any;
  let mockAgentRepo: any;
  let mockSettingsRepo: any;
  let mockUserRepo: any;
  let mockAttachmentRepo: any;
  let mockChatService: any;
  let mockGetMainWindow: () => BrowserWindow | null;
  let ipcHandlers: Map<string, Function>;

  const mockUser: User = {
    id: 'user-1',
    name: 'Test User',
    color: '#667eea',
    createdAt: Date.now(),
  };

  const mockAgent: Agent = {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent',
    provider: 'anthropic',
    model: 'claude-3-sonnet',
    temperature: 0.7,
    color: '#667eea',
    createdAt: Date.now(),
  };

  const mockChat: Chat = {
    id: 'chat-1',
    name: 'Test Chat',
    agentId: 'agent-1',
    participants: [],
    messages: [],
    createdAt: Date.now(),
  };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup IPC handler tracking
    ipcHandlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
      ipcHandlers.set(channel, handler);
    });

    // Setup repository mocks — the chat IPC surface now speaks
    // ChannelRepository's direct-channel (chat) projection.
    mockChatRepo = {
      createDirectChat: vi.fn(),
      getDirectChats: vi.fn(),
      getDirectChatById: vi.fn(),
      getDirectChatsByAgentId: vi.fn(),
      updateDirectChat: vi.fn(),
      archiveDirectChat: vi.fn(),
      unarchiveDirectChat: vi.fn(),
      delete: vi.fn(),
      searchDirectChats: vi.fn(),
      getDirectChatsByTags: vi.fn(),
      createDirectMessage: vi.fn(),
      updateMessage: vi.fn(),
      updateMessageText: vi.fn().mockReturnValue({ contentBlocks: null }),
      deleteMessage: vi.fn(),
      addParticipant: vi.fn(),
      // Branch-tree helpers — send-chat-message and add-chat-agent-message
      // call getLatestActiveMessageId to populate parent_message_id; the
      // regenerate/swipe handlers call the others.
      getLatestActiveMessageId: vi.fn().mockReturnValue(null),
      getSiblings: vi.fn().mockReturnValue([]),
      regenerateFrom: vi.fn(),
      switchActiveBranch: vi.fn(),
    };

    mockAgentRepo = {
      getById: vi.fn(),
    };

    mockSettingsRepo = {
      update: vi.fn(),
    };

    mockUserRepo = {
      getCurrent: vi.fn(),
    };

    mockAttachmentRepo = {
      create: vi.fn(),
      getByAssetPointer: vi.fn(),
      updateFile: vi.fn().mockReturnValue(true),
    };

    // Use the shared mock instance
    mockChatService = mockChatServiceInstance;

    vi.mocked(repositories.getChannelRepository).mockReturnValue(mockChatRepo);
    vi.mocked(repositories.getAgentRepository).mockReturnValue(mockAgentRepo);
    vi.mocked(repositories.getSettingsRepository).mockReturnValue(mockSettingsRepo);
    vi.mocked(repositories.getUserRepository).mockReturnValue(mockUserRepo);
    vi.mocked(repositories.getMessageAttachmentRepository).mockReturnValue(mockAttachmentRepo);

    // Setup default return values
    mockUserRepo.getCurrent.mockReturnValue(mockUser);
    mockAgentRepo.getById.mockReturnValue(mockAgent);

    // Setup getMainWindow mock
    mockGetMainWindow = vi.fn(() => null);

    // Register handlers
    registerChatHandlers(mockGetMainWindow);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create-chat', () => {
    it('should create a new chat with valid input', async () => {
      const newChat = { ...mockChat, id: 'chat-new' };
      mockChatRepo.createDirectChat.mockReturnValue(newChat);

      const handler = ipcHandlers.get('create-chat')!;
      const result = await handler({}, { name: 'New Chat', agentId: 'agent-1' });

      expect(result.success).toBe(true);
      expect(result.chat).toEqual(newChat);
      expect(mockChatRepo.createDirectChat).toHaveBeenCalledWith(
        { name: 'New Chat', agentId: 'agent-1', tags: undefined },
        expect.arrayContaining([
          expect.objectContaining({ id: 'user-1', type: 'human' }),
          expect.objectContaining({ id: 'agent-1', type: 'agent' }),
        ])
      );
    });

    it('should create chat without name (use default)', async () => {
      const newChat = { ...mockChat, name: 'Chat with Test Agent' };
      mockChatRepo.createDirectChat.mockReturnValue(newChat);

      const handler = ipcHandlers.get('create-chat')!;
      const result = await handler({}, { agentId: 'agent-1' });

      expect(result.success).toBe(true);
      expect(mockChatRepo.createDirectChat).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Chat with Test Agent' }),
        expect.any(Array)
      );
    });

    it('should create chat with tags', async () => {
      const newChat = { ...mockChat, tags: 'work,important' };
      mockChatRepo.createDirectChat.mockReturnValue(newChat);

      const handler = ipcHandlers.get('create-chat')!;
      const result = await handler({}, { name: 'Tagged Chat', agentId: 'agent-1', tags: 'work,important' });

      expect(result.success).toBe(true);
      expect(mockChatRepo.createDirectChat).toHaveBeenCalledWith(
        expect.objectContaining({ tags: 'work,important' }),
        expect.any(Array)
      );
    });

    it('should fail validation with invalid agentId', async () => {
      const handler = ipcHandlers.get('create-chat')!;
      const result = await handler({}, { name: 'Test', agentId: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockChatRepo.createDirectChat).not.toHaveBeenCalled();
    });

    it('should fail when no current user', async () => {
      mockUserRepo.getCurrent.mockReturnValue(null);

      const handler = ipcHandlers.get('create-chat')!;
      const result = await handler({}, { name: 'Test', agentId: 'agent-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No current user');
    });

    it('should fail when agent not found', async () => {
      mockAgentRepo.getById.mockReturnValue(null);

      const handler = ipcHandlers.get('create-chat')!;
      const result = await handler({}, { name: 'Test', agentId: 'agent-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
    });

    it('should fail validation with name too long', async () => {
      const longName = 'a'.repeat(101);
      const handler = ipcHandlers.get('create-chat')!;
      const result = await handler({}, { name: longName, agentId: 'agent-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('switch-chat', () => {
    it('should switch to existing chat', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(mockChat);

      const handler = ipcHandlers.get('switch-chat')!;
      const result = await handler({}, 'chat-1');

      expect(result.success).toBe(true);
      expect(mockSettingsRepo.update).toHaveBeenCalledWith({ currentChatId: 'chat-1' });
    });

    it('should fail for non-existent chat', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(null);

      const handler = ipcHandlers.get('switch-chat')!;
      const result = await handler({}, 'non-existent');

      expect(result.success).toBe(false);
      expect(mockSettingsRepo.update).not.toHaveBeenCalled();
    });

    it('should fail validation with invalid chatId', async () => {
      const handler = ipcHandlers.get('switch-chat')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('update-chat', () => {
    it('should update chat successfully', async () => {
      const updatedChat = { ...mockChat, name: 'Updated Name' };
      mockChatRepo.updateDirectChat.mockReturnValue(updatedChat);

      const handler = ipcHandlers.get('update-chat')!;
      const result = await handler({}, { chatId: 'chat-1', updates: { name: 'Updated Name' } });

      expect(result.success).toBe(true);
      expect(result.chat).toEqual(updatedChat);
      expect(mockChatRepo.updateDirectChat).toHaveBeenCalledWith('chat-1', { name: 'Updated Name' });
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.updateDirectChat.mockReturnValue(null);

      const handler = ipcHandlers.get('update-chat')!;
      const result = await handler({}, { chatId: 'non-existent', updates: { name: 'Test' } });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat not found');
    });

    it('should update tags', async () => {
      const updatedChat = { ...mockChat, tags: 'updated,tags' };
      mockChatRepo.updateDirectChat.mockReturnValue(updatedChat);

      const handler = ipcHandlers.get('update-chat')!;
      const result = await handler({}, { chatId: 'chat-1', updates: { tags: 'updated,tags' } });

      expect(result.success).toBe(true);
    });
  });

  describe('archive-chat', () => {
    it('should archive chat successfully', async () => {
      const archivedChat = { ...mockChat, archivedAt: Date.now() };
      mockChatRepo.archiveDirectChat.mockReturnValue(archivedChat);

      const handler = ipcHandlers.get('archive-chat')!;
      const result = await handler({}, 'chat-1');

      expect(result.success).toBe(true);
      expect(result.chat).toEqual(archivedChat);
      expect(mockChatRepo.archiveDirectChat).toHaveBeenCalledWith('chat-1');
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.archiveDirectChat.mockReturnValue(null);

      const handler = ipcHandlers.get('archive-chat')!;
      const result = await handler({}, 'non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat not found');
    });
  });

  describe('unarchive-chat', () => {
    it('should unarchive chat successfully', async () => {
      const unarchivedChat = { ...mockChat, archivedAt: undefined };
      mockChatRepo.unarchiveDirectChat.mockReturnValue(unarchivedChat);

      const handler = ipcHandlers.get('unarchive-chat')!;
      const result = await handler({}, 'chat-1');

      expect(result.success).toBe(true);
      expect(result.chat).toEqual(unarchivedChat);
      expect(mockChatRepo.unarchiveDirectChat).toHaveBeenCalledWith('chat-1');
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.unarchiveDirectChat.mockReturnValue(null);

      const handler = ipcHandlers.get('unarchive-chat')!;
      const result = await handler({}, 'non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat not found');
    });
  });

  describe('delete-chat', () => {
    it('should delete chat successfully', async () => {
      mockChatRepo.delete.mockReturnValue(true);

      const handler = ipcHandlers.get('delete-chat')!;
      const result = await handler({}, 'chat-1');

      expect(result.success).toBe(true);
      expect(mockChatRepo.delete).toHaveBeenCalledWith('chat-1');
      expect(mockChatService.clearChatState).toHaveBeenCalledWith('chat-1');
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.delete.mockReturnValue(false);

      const handler = ipcHandlers.get('delete-chat')!;
      const result = await handler({}, 'non-existent');

      expect(result.success).toBe(false);
      expect(mockChatService.clearChatState).not.toHaveBeenCalled();
    });
  });

  describe('get-chats', () => {
    it('should return all chats', async () => {
      const chats = [mockChat, { ...mockChat, id: 'chat-2' }];
      mockChatRepo.getDirectChats.mockReturnValue(chats);

      const handler = ipcHandlers.get('get-chats')!;
      const result = await handler({}, {});

      expect(result.success).toBe(true);
      expect(result.chats).toEqual(chats);
      expect(mockChatRepo.getDirectChats).toHaveBeenCalledWith({});
    });

    it('should include archived chats when requested', async () => {
      const handler = ipcHandlers.get('get-chats')!;
      await handler({}, { includeArchived: true });

      expect(mockChatRepo.getDirectChats).toHaveBeenCalledWith({ includeArchived: true });
    });

    it('should handle undefined options', async () => {
      mockChatRepo.getDirectChats.mockReturnValue([]);

      const handler = ipcHandlers.get('get-chats')!;
      const result = await handler({}, undefined);

      expect(result.success).toBe(true);
      expect(result.chats).toEqual([]);
    });
  });

  describe('get-chat', () => {
    it('should return chat by ID', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(mockChat);

      const handler = ipcHandlers.get('get-chat')!;
      const result = await handler({}, 'chat-1');

      expect(result.success).toBe(true);
      expect(result.chat).toEqual(mockChat);
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(null);

      const handler = ipcHandlers.get('get-chat')!;
      const result = await handler({}, 'non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat not found');
    });
  });

  describe('get-chats-by-agent', () => {
    it('should return chats for agent', async () => {
      const chats = [mockChat];
      mockChatRepo.getDirectChatsByAgentId.mockReturnValue(chats);

      const handler = ipcHandlers.get('get-chats-by-agent')!;
      const result = await handler({}, { agentId: 'agent-1', options: {} });

      expect(result.success).toBe(true);
      expect(result.chats).toEqual(chats);
      expect(mockChatRepo.getDirectChatsByAgentId).toHaveBeenCalledWith('agent-1', {});
    });

    it('should include archived when requested', async () => {
      mockChatRepo.getDirectChatsByAgentId.mockReturnValue([]);

      const handler = ipcHandlers.get('get-chats-by-agent')!;
      await handler({}, { agentId: 'agent-1', options: { includeArchived: true } });

      expect(mockChatRepo.getDirectChatsByAgentId).toHaveBeenCalledWith('agent-1', { includeArchived: true });
    });
  });

  describe('search-chats', () => {
    it('should search chats', async () => {
      const chats = [mockChat];
      mockChatRepo.searchDirectChats.mockReturnValue(chats);

      const handler = ipcHandlers.get('search-chats')!;
      const result = await handler({}, { query: 'test' });

      expect(result.success).toBe(true);
      expect(result.chats).toEqual(chats);
      expect(mockChatRepo.searchDirectChats).toHaveBeenCalledWith('test', { includeArchived: undefined });
    });

    it('should search with includeArchived flag', async () => {
      mockChatRepo.searchDirectChats.mockReturnValue([]);

      const handler = ipcHandlers.get('search-chats')!;
      await handler({}, { query: 'test', includeArchived: true });

      expect(mockChatRepo.searchDirectChats).toHaveBeenCalledWith('test', { includeArchived: true });
    });
  });

  describe('get-chats-by-tags', () => {
    it('should get chats by tags', async () => {
      const chats = [mockChat];
      mockChatRepo.getDirectChatsByTags.mockReturnValue(chats);

      const handler = ipcHandlers.get('get-chats-by-tags')!;
      const result = await handler({}, { tags: ['work', 'important'] });

      expect(result.success).toBe(true);
      expect(result.chats).toEqual(chats);
      expect(mockChatRepo.getDirectChatsByTags).toHaveBeenCalledWith(['work', 'important'], { includeArchived: undefined });
    });

    it('should get chats by tags with includeArchived', async () => {
      mockChatRepo.getDirectChatsByTags.mockReturnValue([]);

      const handler = ipcHandlers.get('get-chats-by-tags')!;
      await handler({}, { tags: ['work'], includeArchived: true });

      expect(mockChatRepo.getDirectChatsByTags).toHaveBeenCalledWith(['work'], { includeArchived: true });
    });
  });

  describe('send-chat-message', () => {
    const mockMessage: ChatMessage = {
      id: 'msg-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderType: 'human',
      senderDisplayName: 'Test User',
      senderColor: '#667eea',
      content: 'Hello',
      timestamp: Date.now(),
    };

    beforeEach(() => {
      mockChatRepo.getDirectChatById.mockReturnValue(mockChat);
      mockChatRepo.createDirectMessage.mockReturnValue(mockMessage);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as any);
    });

    it('should send message with content', async () => {
      const handler = ipcHandlers.get('send-chat-message')!;
      const result = await handler({}, { chatId: 'chat-1', content: 'Hello' });

      expect(result.success).toBe(true);
      expect(result.message).toEqual(mockMessage);
      expect(mockChatRepo.createDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          content: 'Hello',
          senderId: 'user-1',
          senderType: 'human',
        })
      );
    });

    it('should trim content', async () => {
      const handler = ipcHandlers.get('send-chat-message')!;
      await handler({}, { chatId: 'chat-1', content: '  Hello  ' });

      expect(mockChatRepo.createDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '  Hello  ',
          contentBlocks: [{ type: 'text', content: 'Hello' }],
        })
      );
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(null);

      const handler = ipcHandlers.get('send-chat-message')!;
      const result = await handler({}, { chatId: 'chat-1', content: 'Hello' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat not found');
    });

    it('should fail when no current user', async () => {
      mockUserRepo.getCurrent.mockReturnValue(null);

      const handler = ipcHandlers.get('send-chat-message')!;
      const result = await handler({}, { chatId: 'chat-1', content: 'Hello' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No current user');
    });

    it.skip('should handle message with attachments', async () => {
      const mockAttachment = {
        id: 'attach-1',
        messageId: 'msg-1',
        filename: 'test.png',
        storedPath: '/mock/path/test.png',
        mimeType: 'image/png',
        size: 1024,
        attachmentType: 'image',
        metadata: {},
        createdAt: Date.now(),
      };

      mockAttachmentRepo.create.mockReturnValue(mockAttachment);
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
      vi.mocked(path.extname).mockReturnValue('.png');
      vi.mocked(path.basename).mockReturnValue('test.png');
      vi.mocked(path.join).mockReturnValue('/mock/path/test.png');

      const handler = ipcHandlers.get('send-chat-message')!;
      const result = await handler({}, {
        chatId: 'chat-1',
        content: 'Check this out',
        attachments: ['/path/to/test.png'],
      });

      expect(result.success).toBe(true);
      expect(mockAttachmentRepo.create).toHaveBeenCalled();
      expect(mockChatRepo.updateMessage).toHaveBeenCalled();
    });

    it('should handle empty content with attachments', async () => {
      const handler = ipcHandlers.get('send-chat-message')!;
      await handler({}, { chatId: 'chat-1', content: '', attachments: [] });

      expect(mockChatRepo.createDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
        })
      );
    });

    it('should reject the message when an attachment is unreadable', async () => {
      // Upfront validation now rejects the whole batch on stat failure rather
      // than logging + continuing. Better for the user (clear error) and
      // avoids leaving half-processed attachment records.
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('File not found');
      });
      vi.mocked(path.extname).mockReturnValue('.png');
      vi.mocked(path.basename).mockReturnValue('path.png');

      const handler = ipcHandlers.get('send-chat-message')!;
      const result = await handler({}, {
        chatId: 'chat-1',
        content: 'Test',
        attachments: ['/invalid/path.png'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found or unreadable/);
    });
  });

  describe('add-chat-agent-message', () => {
    const mockAgentMessage: ChatMessage = {
      id: 'msg-2',
      chatId: 'chat-1',
      senderId: 'agent-1',
      senderType: 'agent',
      senderDisplayName: 'Test Agent',
      senderColor: '#667eea',
      content: 'Hello from agent',
      timestamp: Date.now(),
    };

    beforeEach(() => {
      mockChatRepo.getDirectChatById.mockReturnValue(mockChat);
      mockChatRepo.createDirectMessage.mockReturnValue(mockAgentMessage);
    });

    it('should add agent message', async () => {
      const handler = ipcHandlers.get('add-chat-agent-message')!;
      const result = await handler({}, {
        chatId: 'chat-1',
        agentId: 'agent-1',
        content: 'Hello from agent',
      });

      expect(result.success).toBe(true);
      expect(result.message).toEqual(mockAgentMessage);
      expect(mockChatRepo.createDirectMessage).toHaveBeenCalled();
    });

    it('should add agent as participant if not already present', async () => {
      const handler = ipcHandlers.get('add-chat-agent-message')!;
      await handler({}, {
        chatId: 'chat-1',
        agentId: 'agent-1',
        content: 'Hello',
      });

      expect(mockChatRepo.addParticipant).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          id: 'agent-1',
          type: 'agent',
          displayName: 'Test Agent',
        })
      );
    });

    it('should not add participant if already present', async () => {
      const chatWithAgent = {
        ...mockChat,
        participants: [{ id: 'agent-1', type: 'agent' as const, displayName: 'Test Agent', joinedAt: Date.now() }],
      };
      mockChatRepo.getDirectChatById.mockReturnValue(chatWithAgent);

      const handler = ipcHandlers.get('add-chat-agent-message')!;
      await handler({}, {
        chatId: 'chat-1',
        agentId: 'agent-1',
        content: 'Hello',
      });

      expect(mockChatRepo.addParticipant).not.toHaveBeenCalled();
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(null);

      const handler = ipcHandlers.get('add-chat-agent-message')!;
      const result = await handler({}, {
        chatId: 'chat-1',
        agentId: 'agent-1',
        content: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat not found');
    });

    it('should fail when agent not found', async () => {
      mockAgentRepo.getById.mockReturnValue(null);

      const handler = ipcHandlers.get('add-chat-agent-message')!;
      const result = await handler({}, {
        chatId: 'chat-1',
        agentId: 'agent-1',
        content: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
    });

    it('should include tool calls and content blocks', async () => {
      const toolCalls = [{ toolName: 'test', args: {}, status: 'completed' as const }];
      const contentBlocks = [{ type: 'text' as const, content: 'Test' }];
      const metrics = { totalTokens: 100 };

      const handler = ipcHandlers.get('add-chat-agent-message')!;
      await handler({}, {
        chatId: 'chat-1',
        agentId: 'agent-1',
        content: 'Hello',
        toolCalls,
        contentBlocks,
        metrics,
      });

      expect(mockChatRepo.createDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCalls,
          contentBlocks,
          metrics,
        })
      );
    });
  });

  describe('add-chat-participant', () => {
    beforeEach(() => {
      mockChatRepo.getDirectChatById.mockReturnValue(mockChat);
    });

    it('should add participant to chat', async () => {
      const handler = ipcHandlers.get('add-chat-participant')!;
      const result = await handler({}, { chatId: 'chat-1', participantId: 'agent-1' });

      expect(result.success).toBe(true);
      expect(mockChatRepo.addParticipant).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          id: 'agent-1',
          type: 'agent',
          displayName: 'Test Agent',
        })
      );
    });

    it('should fail when chat not found', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(null);

      const handler = ipcHandlers.get('add-chat-participant')!;
      const result = await handler({}, { chatId: 'chat-1', participantId: 'agent-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat not found');
    });

    it('should fail when agent not found', async () => {
      mockAgentRepo.getById.mockReturnValue(null);

      const handler = ipcHandlers.get('add-chat-participant')!;
      const result = await handler({}, { chatId: 'chat-1', participantId: 'agent-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
    });
  });

  describe('update-chat-message', () => {
    it('should update message content and text block', async () => {
      const blocks = [{ type: 'text', content: 'Updated content' }];
      mockChatRepo.updateMessageText.mockReturnValue({ contentBlocks: blocks });

      const handler = ipcHandlers.get('update-chat-message')!;
      const result = await handler({}, { messageId: 'msg-1', content: 'Updated content' });

      expect(result.success).toBe(true);
      expect(result.contentBlocks).toEqual(blocks);
      expect(mockChatRepo.updateMessageText).toHaveBeenCalledWith('msg-1', 'Updated content');
    });

    it('should fail when message not found', async () => {
      mockChatRepo.updateMessageText.mockReturnValue(null);

      const handler = ipcHandlers.get('update-chat-message')!;
      const result = await handler({}, { messageId: 'msg-1', content: 'Updated content' });

      expect(result.success).toBe(false);
    });

    it('should reject empty content', async () => {
      const handler = ipcHandlers.get('update-chat-message')!;
      const result = await handler({}, { messageId: 'msg-1', content: '   ' });

      expect(result.success).toBe(false);
      expect(mockChatRepo.updateMessageText).not.toHaveBeenCalled();
    });
  });

  describe('delete-chat-message', () => {
    it('should delete message successfully', async () => {
      mockChatRepo.deleteMessage.mockReturnValue(true);

      const handler = ipcHandlers.get('delete-chat-message')!;
      const result = await handler({}, 'msg-1');

      expect(result.success).toBe(true);
      expect(mockChatRepo.deleteMessage).toHaveBeenCalledWith('msg-1');
    });

    it('should fail when message not found', async () => {
      mockChatRepo.deleteMessage.mockReturnValue(false);

      const handler = ipcHandlers.get('delete-chat-message')!;
      const result = await handler({}, 'non-existent');

      expect(result.success).toBe(false);
    });
  });

  describe('chat-with-agent', () => {
    it('should start chat with agent', async () => {
      mockChatService.chatWithAgent.mockResolvedValue({ success: true });

      const handler = ipcHandlers.get('chat-with-agent')!;
      const result = await handler({}, { chatId: 'chat-1', agentId: 'agent-1' });

      expect(result.success).toBe(true);
      expect(mockChatService.chatWithAgent).toHaveBeenCalledWith('chat-1', 'agent-1');
    });

    it('should fail validation with invalid chatId', async () => {
      const handler = ipcHandlers.get('chat-with-agent')!;
      const result = await handler({}, { chatId: '', agentId: 'agent-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockChatService.chatWithAgent).not.toHaveBeenCalled();
    });

    it('should fail validation with invalid agentId', async () => {
      const handler = ipcHandlers.get('chat-with-agent')!;
      const result = await handler({}, { chatId: 'chat-1', agentId: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockChatService.chatWithAgent).not.toHaveBeenCalled();
    });
  });

  describe('stop-chat-stream', () => {
    it('should stop chat stream', async () => {
      mockChatService.stopStream.mockResolvedValue({ success: true });

      const handler = ipcHandlers.get('stop-chat-stream')!;
      const result = await handler({}, 'chat-1');

      expect(result).toEqual({ success: true });
      expect(mockChatService.stopStream).toHaveBeenCalledWith('chat-1');
    });
  });

  describe('generate-chat-metadata', () => {
    it('should generate chat metadata', async () => {
      const messages = [
        { senderType: 'human', content: 'Hello' },
        { senderType: 'agent', content: 'Hi there!' },
      ];
      mockChatService.generateMetadata.mockResolvedValue({ success: true, title: 'Greeting', tags: ['casual'] });

      const handler = ipcHandlers.get('generate-chat-metadata')!;
      const result = await handler({}, { chatId: 'chat-1', messages });

      expect(result.success).toBe(true);
      expect(mockChatService.generateMetadata).toHaveBeenCalledWith('chat-1', messages);
    });
  });

  describe('get-chat-tools', () => {
    it('should get chat tools', async () => {
      const tools = [{ name: 'tool1', enabled: true }];
      mockChatService.getChatTools.mockResolvedValue({ success: true, tools });

      const handler = ipcHandlers.get('get-chat-tools')!;
      const result = await handler({}, 'chat-1');

      expect(result).toEqual({ success: true, tools });
      expect(mockChatService.getChatTools).toHaveBeenCalledWith('chat-1');
    });
  });

  describe('toggle-chat-tool', () => {
    it('should toggle chat tool', async () => {
      mockChatService.toggleChatTool.mockResolvedValue({ success: true });

      const handler = ipcHandlers.get('toggle-chat-tool')!;
      const result = await handler({}, { chatId: 'chat-1', toolName: 'tool1', enabled: true });

      expect(result).toEqual({ success: true });
      expect(mockChatService.toggleChatTool).toHaveBeenCalledWith('chat-1', 'tool1', true);
    });
  });

  describe('replace-attachment-file', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ size: 2048 } as any);
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
      vi.mocked(path.extname).mockReturnValue('.png');
      vi.mocked(path.basename).mockReturnValue('image.png');
      vi.mocked(path.join).mockReturnValue('/mock/path/image.png');
    });

    it('should replace existing attachment file', async () => {
      const mockAttachment = {
        id: 'attach-1',
        messageId: 'msg-1',
        filename: 'old.png',
        storedPath: '/old/path.png',
        mimeType: 'image/png',
        size: 1024,
        attachmentType: 'image',
        metadata: { asset_pointer: 'test-asset' },
        createdAt: Date.now(),
      };

      mockAttachmentRepo.getByAssetPointer.mockReturnValue(mockAttachment);

      const handler = ipcHandlers.get('replace-attachment-file')!;
      const result = await handler({}, {
        assetPointer: 'test-asset',
        filePath: '/new/path/image.png',
      });

      expect(result.success).toBe(true);
      expect(result.newUrl).toBe('file-service://asset/test-asset');
      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    it('should create new attachment if not found', async () => {
      mockAttachmentRepo.getByAssetPointer.mockReturnValue(null);
      const newAttachment = {
        id: 'attach-new',
        messageId: 'msg-1',
        filename: 'image.png',
        storedPath: '/mock/path/image.png',
        mimeType: 'image/png',
        size: 2048,
        attachmentType: 'image',
        metadata: { asset_pointer: 'test-asset' },
        createdAt: Date.now(),
      };
      mockAttachmentRepo.create.mockReturnValue(newAttachment);

      const handler = ipcHandlers.get('replace-attachment-file')!;
      const result = await handler({}, {
        assetPointer: 'test-asset',
        filePath: '/new/path/image.png',
        messageId: 'msg-1',
      });

      expect(result.success).toBe(true);
      expect(mockAttachmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-1',
          metadata: { asset_pointer: 'test-asset' },
        })
      );
    });

    it('should fail when creating new attachment without messageId', async () => {
      mockAttachmentRepo.getByAssetPointer.mockReturnValue(null);

      const handler = ipcHandlers.get('replace-attachment-file')!;
      const result = await handler({}, {
        assetPointer: 'test-asset',
        filePath: '/new/path/image.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Attachment not found and no messageId provided to create one');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('File error');
      });

      const handler = ipcHandlers.get('replace-attachment-file')!;
      const result = await handler({}, {
        assetPointer: 'test-asset',
        filePath: '/invalid/path.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('File error');
    });

    it('should handle different image types', async () => {
      mockAttachmentRepo.getByAssetPointer.mockReturnValue(null);

      const testCases = [
        { ext: '.jpg', expected: 'image/jpeg' },
        { ext: '.jpeg', expected: 'image/jpeg' },
        { ext: '.gif', expected: 'image/gif' },
        { ext: '.webp', expected: 'image/webp' },
        { ext: '.bmp', expected: 'image/bmp' },
      ];

      for (const testCase of testCases) {
        vi.mocked(path.extname).mockReturnValue(testCase.ext);

        const handler = ipcHandlers.get('replace-attachment-file')!;
        await handler({}, {
          assetPointer: 'test-asset',
          filePath: `/path/image${testCase.ext}`,
          messageId: 'msg-1',
        });

        expect(mockAttachmentRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            mimeType: testCase.expected,
          })
        );
      }
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle repository throwing errors', async () => {
      mockChatRepo.createDirectChat.mockImplementation(() => {
        throw new Error('Database error');
      });

      const handler = ipcHandlers.get('create-chat')!;

      const result = await handler({}, { name: 'Test', agentId: 'agent-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
    });

    it('should log validation failures', async () => {
      const handler = ipcHandlers.get('create-chat')!;
      await handler({}, { name: '', agentId: 'agent-1' });

      expect(logger.warn).toHaveBeenCalledWith(
        '[IPC] create-chat validation failed:',
        expect.any(String)
      );
    });

    it('should log successful operations', async () => {
      const newChat = { ...mockChat, id: 'chat-new' };
      mockChatRepo.createDirectChat.mockReturnValue(newChat);

      const handler = ipcHandlers.get('create-chat')!;
      await handler({}, { name: 'Test', agentId: 'agent-1' });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[IPC] Created chat:')
      );
    });
  });

  describe('regenerate-chat-message / branch swipe', () => {
    it('regenerates an agent message with the next branch index', async () => {
      mockChatRepo.getSiblings.mockReturnValue([
        { id: 'msg-1', senderType: 'agent' },
      ]);
      mockChatRepo.regenerateFrom.mockReturnValue({
        chatId: 'chat-1',
        parentMessageId: 'parent-1',
        nextBranchIndex: 2,
      });
      mockChatRepo.getDirectChatById.mockReturnValue({
        id: 'chat-1',
        agentId: 'agent-1',
      });
      mockChatServiceInstance.chatWithAgent.mockResolvedValue({ success: true });

      const handler = ipcHandlers.get('regenerate-chat-message')!;
      const result = await handler({}, { messageId: 'msg-1' });
      expect(result.success).toBe(true);
      expect(mockChatServiceInstance.chatWithAgent).toHaveBeenCalledWith(
        'chat-1',
        'agent-1',
        { branchOverride: { parentMessageId: 'parent-1', branchIndex: 2 } },
      );
    });

    it('rejects regenerate for missing or human messages', async () => {
      mockChatRepo.getSiblings.mockReturnValue([]);
      const handler = ipcHandlers.get('regenerate-chat-message')!;
      expect(await handler({}, { messageId: 'missing' })).toEqual({
        success: false,
        error: 'Message not found',
      });

      mockChatRepo.getSiblings.mockReturnValue([
        { id: 'msg-h', senderType: 'human' },
      ]);
      expect(await handler({}, { messageId: 'msg-h' })).toEqual({
        success: false,
        error: 'Only agent messages can be regenerated',
      });
    });

    it('switch-active-branch activates the path', async () => {
      mockChatRepo.switchActiveBranch.mockReturnValue(undefined);
      const handler = ipcHandlers.get('switch-active-branch')!;
      expect(await handler({}, { messageId: 'msg-2' })).toEqual({ success: true });
      expect(mockChatRepo.switchActiveBranch).toHaveBeenCalledWith('msg-2');
    });

    it('switch-active-branch surfaces repo errors', async () => {
      mockChatRepo.switchActiveBranch.mockImplementation(() => {
        throw new Error('not in tree');
      });
      const handler = ipcHandlers.get('switch-active-branch')!;
      expect(await handler({}, { messageId: 'msg-2' })).toEqual({
        success: false,
        error: 'not in tree',
      });
    });

    it('swipe-chat-message-branch moves prev/next among siblings', async () => {
      mockChatRepo.getSiblings.mockReturnValue([
        { id: 'b0' },
        { id: 'b1' },
        { id: 'b2' },
      ]);
      mockChatRepo.switchActiveBranch.mockReturnValue(undefined);
      const handler = ipcHandlers.get('swipe-chat-message-branch')!;

      expect(await handler({}, { messageId: 'b1', direction: 'next' })).toEqual({
        success: true,
        switchedToMessageId: 'b2',
      });
      expect(mockChatRepo.switchActiveBranch).toHaveBeenCalledWith('b2');

      expect(await handler({}, { messageId: 'b0', direction: 'prev' })).toMatchObject({
        success: false,
        error: expect.stringMatching(/No sibling prev/),
      });
    });
  });

  describe('duplicate-chat', () => {
    it('clones chat metadata and bulk-copies messages with parent remapping', async () => {
      const source = {
        id: 'chat-1',
        name: 'Source',
        agentId: 'agent-1',
        tags: 'work',
        participants: [{ id: 'agent-1', type: 'agent' }],
        messages: [
          {
            id: 'm1',
            senderId: 'u1',
            senderType: 'human',
            senderDisplayName: 'U',
            senderColor: '#000',
            content: 'hi',
            timestamp: 1,
            parentMessageId: null,
          },
          {
            id: 'm2',
            senderId: 'agent-1',
            senderType: 'agent',
            senderDisplayName: 'A',
            senderColor: '#f00',
            content: 'yo',
            timestamp: 2,
            parentMessageId: 'm1',
          },
        ],
      };
      const copy = { id: 'chat-copy', name: 'Source (copy)', agentId: 'agent-1', messages: [] };
      // The handler re-reads the clone by its new id before returning, so the
      // stub has to answer per-id — a single mockReturnValue would hand back
      // the source and hide that read entirely.
      mockChatRepo.getDirectChatById.mockImplementation((id: string) =>
        id === 'chat-copy' ? copy : source
      );
      mockChatRepo.createDirectChat.mockReturnValue({
        id: 'chat-copy',
        name: 'Source (copy)',
        agentId: 'agent-1',
      });
      mockChatRepo.bulkCreateDirectMessages = vi.fn();

      const handler = ipcHandlers.get('duplicate-chat')!;
      const result = await handler({}, 'chat-1');
      expect(result.success).toBe(true);
      expect(result.chat.id).toBe('chat-copy');
      expect(mockChatRepo.createDirectChat).toHaveBeenCalledWith(
        { name: 'Source (copy)', agentId: 'agent-1', tags: 'work' },
        [{ id: 'agent-1', type: 'agent' }],
      );
      expect(mockChatRepo.bulkCreateDirectMessages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ originalId: 'm1', chatId: 'chat-copy' }),
          expect.objectContaining({ originalId: 'm2', parentMessageId: 'm1' }),
        ]),
      );
    });

    it('fails when source chat is missing', async () => {
      mockChatRepo.getDirectChatById.mockReturnValue(null);
      const handler = ipcHandlers.get('duplicate-chat')!;
      expect(await handler({}, 'missing')).toEqual({
        success: false,
        error: 'Chat not found',
      });
    });
  });
});
