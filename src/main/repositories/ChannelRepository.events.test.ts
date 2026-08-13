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

// Pins the event contract the ChannelDispatcher relies on: exactly one
// message:created per insert (with context + isDraft), and message:updated
// only on the real draft → finalized transition.
describe('ChannelRepository event contract', () => {
  let db: Database.Database;
  let repository: ChannelRepository;
  let created: any[];
  let updated: any[];
  let offCreated: () => void;
  let offUpdated: () => void;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db, 0);

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

  describe('createMessage', () => {
    it('emits exactly one message:created with context channel and payload intact', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });
      const timestamp = Date.now();

      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Hello @Bob',
        timestamp,
        metadata: { dispatchedBy: 'channel-dispatcher', chainDepth: 2 },
      });

      expect(created).toHaveLength(1);
      expect(created[0]).toEqual({
        id: message.id,
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Hello @Bob',
        timestamp,
        metadata: { dispatchedBy: 'channel-dispatcher', chainDepth: 2 },
        context: 'channel',
        isDraft: false,
      });
      expect(updated).toHaveLength(0);
    });

    it('reports isDraft true when creating a draft placeholder', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: '',
        timestamp: Date.now(),
        isDraft: true,
      });

      expect(created).toHaveLength(1);
      expect(created[0].isDraft).toBe(true);
      expect(created[0].context).toBe('channel');
    });
  });

  describe('updateMessageContentBlocks', () => {
    const createDraft = (channelId: string) =>
      repository.createMessage({
        channelId,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: '',
        timestamp: Date.now(),
        isDraft: true,
        metadata: { requestId: 'req-1' },
      });

    it('emits message:updated with draftFinalized on the is_draft 1 → 0 transition', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });
      const draft = createDraft(channel.id);

      repository.updateMessageContentBlocks(draft.id, [{ type: 'text', text: 'Done @Bob' }], 'Done @Bob', false);

      expect(updated).toHaveLength(1);
      expect(updated[0]).toEqual({
        id: draft.id,
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Done @Bob',
        metadata: { requestId: 'req-1' },
        context: 'channel',
        draftFinalized: true,
      });
    });

    it('does not emit when isDraft is undefined (plain content update)', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });
      const draft = createDraft(channel.id);

      repository.updateMessageContentBlocks(draft.id, [], 'streaming chunk', undefined);

      expect(updated).toHaveLength(0);
    });

    it('does not emit on a draft → draft update', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });
      const draft = createDraft(channel.id);

      repository.updateMessageContentBlocks(draft.id, [], 'partial', true);

      expect(updated).toHaveLength(0);
    });

    it('does not emit when finalizing with empty content', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });
      const draft = createDraft(channel.id);

      repository.updateMessageContentBlocks(draft.id, [], '', false);

      expect(updated).toHaveLength(0);
    });

    it('does not re-emit when an already-finalized message is saved with isDraft false', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });
      const draft = createDraft(channel.id);

      repository.updateMessageContentBlocks(draft.id, [], 'Done @Bob', false);
      repository.updateMessageContentBlocks(draft.id, [], 'Done @Bob', false);

      expect(updated).toHaveLength(1);
    });

    it('does not emit for a message created non-draft and updated with isDraft false', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });
      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'user',
        senderType: 'human',
        senderDisplayName: 'User',
        content: 'hi',
        timestamp: Date.now(),
      });

      repository.updateMessageContentBlocks(message.id, [], 'hi edited', false);

      expect(updated).toHaveLength(0);
    });
  });

  describe('bulkCreateMessages', () => {
    it('does not emit message:created', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const ids = repository.bulkCreateMessages([
        {
          channelId: channel.id,
          senderId: 'agent-1',
          senderType: 'agent',
          senderDisplayName: 'Agent 1',
          content: 'Imported 1',
          timestamp: Date.now(),
        },
        {
          channelId: channel.id,
          senderId: 'user',
          senderType: 'human',
          senderDisplayName: 'User',
          content: 'Imported 2',
          timestamp: Date.now() + 1000,
        },
      ]);

      expect(ids).toHaveLength(2);
      expect(repository.getMessagesByChannelId(channel.id)).toHaveLength(2);
      expect(created).toHaveLength(0);
      expect(updated).toHaveLength(0);
    });
  });
});
