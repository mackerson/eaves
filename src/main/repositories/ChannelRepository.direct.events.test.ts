import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelRepository } from './ChannelRepository';
import { runMigrations } from '../services/migrations';
import { eventBus } from '../services/EventBus';

// Mock the logger to avoid Electron app dependency
vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the database service
vi.mock('../services/database', () => ({
  getDatabase: vi.fn(),
}));

// Pins the event contract on the chat side of ChannelRepository's
// direct-channel projection: createDirectMessage emits exactly one
// message:created with context 'chat' (never a draft), update paths stay
// silent, and bulk import bypasses the event bus entirely — so the
// ChannelDispatcher never sees chat traffic as dispatchable.
describe('ChannelRepository direct-channel (chat) event contract', () => {
  let db: Database.Database;
  let repository: ChannelRepository;
  let created: any[];
  let updated: any[];
  let offCreated: () => void;
  let offUpdated: () => void;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db, 0);

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, model, temperature, color, created_at)
      VALUES ('agent-1', 'Test Agent', 'A test agent', 'anthropic', 'claude-3-sonnet', 0.7, '#667eea', ?)
    `).run(Date.now());

    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    repository = new ChannelRepository();

    // eventBus is a process-wide singleton — capture payloads per test and
    // detach in afterEach so tests can't observe each other's emissions
    created = [];
    updated = [];
    offCreated = eventBus.onEvent('message:created', (event) => created.push(event.data));
    offUpdated = eventBus.onEvent('message:updated', (event) => updated.push(event.data));
  });

  afterEach(() => {
    offCreated();
    offUpdated();
    db.close();
    vi.clearAllMocks();
  });

  describe('createDirectMessage', () => {
    it('emits exactly one message:created with context chat and isDraft false', () => {
      const chat = repository.createDirectChat({ name: 'Test Chat', agentId: 'agent-1' });
      const timestamp = Date.now();

      const message = repository.createDirectMessage({
        chatId: chat.id,
        senderId: 'user',
        senderType: 'human',
        senderDisplayName: 'Test User',
        content: 'Hello @Bob',
        timestamp,
        metadata: { source: 'renderer' },
      });

      expect(created).toHaveLength(1);
      expect(created[0]).toEqual({
        id: message.id,
        chatId: chat.id,
        senderId: 'user',
        senderType: 'human',
        senderDisplayName: 'Test User',
        content: 'Hello @Bob',
        timestamp,
        metadata: { source: 'renderer' },
        context: 'chat',
        isDraft: false,
      });
      // Chat payloads carry chatId, never channelId — the dispatcher's
      // context filter is the only thing between chats and @mention dispatch
      expect(created[0]).not.toHaveProperty('channelId');
      expect(updated).toHaveLength(0);
    });
  });

  describe('update paths', () => {
    it('never emits message:updated from any update path', () => {
      const chat = repository.createDirectChat({ name: 'Test Chat', agentId: 'agent-1' });
      const message = repository.createDirectMessage({
        chatId: chat.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Test Agent',
        content: 'Original',
        timestamp: Date.now(),
      });
      created.length = 0;

      // Bare-string overload — content only
      repository.updateMessage(message.id, 'Updated content');
      // Object form with all fields
      repository.updateMessage(message.id, {
        content: 'Updated again',
        contentBlocks: [{ type: 'text', text: 'Updated again' }],
        responseMessages: [{ role: 'assistant', content: 'Updated again' }],
      });
      // User-edit path
      repository.updateMessageText(message.id, 'Edited by user');

      expect(updated).toHaveLength(0);
      expect(created).toHaveLength(0);
    });
  });

  describe('bulkCreateDirectMessages', () => {
    it('does not emit message:created', () => {
      const chat = repository.createDirectChat({ name: 'Import Chat', agentId: 'agent-1' });

      const ids = repository.bulkCreateDirectMessages([
        {
          chatId: chat.id,
          senderId: 'user',
          senderType: 'human',
          senderDisplayName: 'Test User',
          content: 'Imported 1',
          timestamp: Date.now(),
        },
        {
          chatId: chat.id,
          senderId: 'agent-1',
          senderType: 'agent',
          senderDisplayName: 'Test Agent',
          content: 'Imported 2',
          timestamp: Date.now() + 1000,
        },
      ]);

      expect(ids).toHaveLength(2);
      expect(repository.getMessagesByChatId(chat.id)).toHaveLength(2);
      expect(created).toHaveLength(0);
      expect(updated).toHaveLength(0);
    });
  });
});
