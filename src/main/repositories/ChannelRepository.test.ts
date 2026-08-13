import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelRepository } from './ChannelRepository';
import { runMigrations } from '../services/migrations';
import { Participant } from '../types';

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

describe('ChannelRepository', () => {
  let db: Database.Database;
  let repository: ChannelRepository;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');

    // Run the production migrations (projects, channels, channel_participants,
    // messages, ...) instead of hand-rolled DDL, so this fixture can't drift
    // from migrations.ts.
    runMigrations(db, 0);

    // Mock getDatabase to return our test database
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    repository = new ChannelRepository();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a public channel without projectId', () => {
      const result = repository.create({
        name: 'announcements',
        type: 'public',
      });

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^channel-/);
      expect(result.name).toBe('announcements');
      expect(result.type).toBe('public');
      expect(result.projectId).toBeUndefined();
      expect(result.createdAt).toBeDefined();
      expect(result.participants).toEqual([]);
      expect(result.messages).toEqual([]);
    });

    it('should create a project channel with projectId', () => {
      // Create a project first
      const now = Date.now();
      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run('project-123', 'Test Project', 'A test project', now);

      const result = repository.create({
        name: 'project-discussion',
        type: 'project',
        projectId: 'project-123',
      });

      expect(result.type).toBe('project');
      expect(result.projectId).toBe('project-123');
      expect(result.name).toBe('project-discussion');
    });

    it('should create a direct channel', () => {
      const result = repository.create({
        name: 'direct-chat',
        type: 'direct',
      });

      expect(result.type).toBe('direct');
      expect(result.name).toBe('direct-chat');
    });

    it('should create channel with initial participants', () => {
      const participants: Participant[] = [
        {
          id: 'agent-1',
          type: 'agent',
          displayName: 'Agent 1',
          color: '#667eea',
          joinedAt: Date.now(),
        },
        {
          id: 'user',
          type: 'human',
          displayName: 'Test User',
          color: '#2563eb',
          joinedAt: Date.now(),
        },
      ];

      const result = repository.create(
        {
          name: 'group-chat',
          type: 'direct',
        },
        participants
      );

      expect(result.participants).toHaveLength(2);
      expect(result.participants[0].id).toBe('agent-1');
      expect(result.participants[0].type).toBe('agent');
      expect(result.participants[0].displayName).toBe('Agent 1');
      expect(result.participants[1].id).toBe('user');
    });

    it('should persist channel to database', () => {
      const result = repository.create({
        name: 'test-channel',
        type: 'public',
      });

      const dbRow = db.prepare('SELECT * FROM channels WHERE id = ?').get(result.id) as any;

      expect(dbRow).toBeDefined();
      expect(dbRow.name).toBe('test-channel');
      expect(dbRow.type).toBe('public');
      expect(dbRow.project_id).toBeNull();
    });

    it('should generate unique IDs for each channel', () => {
      const channel1 = repository.create({ name: 'channel-1', type: 'public' });
      const channel2 = repository.create({ name: 'channel-2', type: 'public' });

      expect(channel1.id).not.toBe(channel2.id);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no channels exist', () => {
      const result = repository.getAll();

      expect(result).toEqual([]);
    });

    it('should return all channels', () => {
      repository.create({ name: 'channel-1', type: 'public' });
      repository.create({ name: 'channel-2', type: 'public' });
      repository.create({ name: 'channel-3', type: 'project' });

      const result = repository.getAll();

      expect(result).toHaveLength(3);
      expect(result.map((c) => c.name)).toContain('channel-1');
      expect(result.map((c) => c.name)).toContain('channel-2');
      expect(result.map((c) => c.name)).toContain('channel-3');
    });

    it("excludes direct channels — they are owned by the Chats projection", () => {
      repository.create({ name: 'channel-1', type: 'public' });
      repository.create({ name: 'direct-chat', type: 'direct' });

      const result = repository.getAll();

      expect(result).toHaveLength(1);
      expect(result.map((c) => c.name)).toEqual(['channel-1']);
      expect(result.map((c) => c.name)).not.toContain('direct-chat');
    });

    it('should return channels in creation order', () => {
      const ch1 = repository.create({ name: 'first', type: 'public' });
      const ch2 = repository.create({ name: 'second', type: 'public' });
      const ch3 = repository.create({ name: 'third', type: 'public' });

      const result = repository.getAll();

      expect(result[0].name).toBe('first');
      expect(result[1].name).toBe('second');
      expect(result[2].name).toBe('third');
    });

    it('should not include messages by default', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      // Add a message
      repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Test message',
        timestamp: Date.now(),
      });

      const result = repository.getAll();

      expect(result[0].messages).toHaveLength(0);
    });

    it('should include messages when includeMessages is true', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Test message',
        timestamp: Date.now(),
      });

      const result = repository.getAll({ includeMessages: true });

      expect(result[0].messages).toHaveLength(1);
    });

    it('should respect messageLimit option', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      // Add multiple messages
      for (let i = 0; i < 10; i++) {
        repository.createMessage({
          channelId: channel.id,
          senderId: 'agent-1',
          senderType: 'agent',
          senderDisplayName: 'Agent 1',
          content: `Message ${i}`,
          timestamp: Date.now() + i * 1000,
        });
      }

      const result = repository.getAll({ includeMessages: true, messageLimit: 3 });

      expect(result[0].messages).toHaveLength(3);
    });

    it('should include participants in results', () => {
      const participants: Participant[] = [
        {
          id: 'agent-1',
          type: 'agent',
          displayName: 'Agent 1',
          color: '#667eea',
          joinedAt: Date.now(),
        },
      ];

      repository.create(
        {
          name: 'test-channel',
          type: 'public',
        },
        participants
      );

      const result = repository.getAll();

      expect(result[0].participants).toHaveLength(1);
      expect(result[0].participants[0].id).toBe('agent-1');
    });
  });

  // A work session is a channels row like everything else, so every query that
  // means "rooms" has to exclude it — otherwise delegated sessions show up in
  // the channel list, in search, and under tag filters.
  describe('work sessions stay off the channel surface', () => {
    const seedWorkSession = () => {
      db.prepare(`
        INSERT INTO channels (id, name, type, created_at, tags)
        VALUES ('ws-1', 'work: fix the thing', 'work', 1, '["urgent"]')
      `).run();
    };

    it('excludes them from getAll', () => {
      repository.create({ name: 'general', type: 'public' });
      seedWorkSession();

      const all = repository.getAll();
      expect(all.map(c => c.type)).toEqual(['public']);
    });

    it('excludes them from search', () => {
      repository.create({ name: 'fix the thing', type: 'public' });
      seedWorkSession();

      const found = repository.search('fix the thing');
      expect(found.map(c => c.name)).toEqual(['fix the thing']);
    });

    it('excludes them from tag filtering', () => {
      const channel = repository.create({ name: 'ops', type: 'public' });
      repository.update(channel.id, { tags: ['urgent'] });
      seedWorkSession();

      const found = repository.getByTags(['urgent']);
      expect(found.map(c => c.name)).toEqual(['ops']);
    });

    it('still reads one directly by id', () => {
      seedWorkSession();
      const session = repository.getById('ws-1');
      expect(session?.type).toBe('work');
    });
  });

  describe('getById', () => {
    it('should return null for non-existent channel', () => {
      const result = repository.getById('non-existent-id');

      expect(result).toBeNull();
    });

    it('should return channel by ID', () => {
      const created = repository.create({ name: 'test-channel', type: 'public' });

      const result = repository.getById(created.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(created.id);
      expect(result?.name).toBe('test-channel');
      expect(result?.type).toBe('public');
    });

    it('should include messages by default', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Test message',
        timestamp: Date.now(),
      });

      const result = repository.getById(channel.id);

      expect(result?.messages).toHaveLength(1);
    });

    it('should exclude messages when includeMessages is false', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Test message',
        timestamp: Date.now(),
      });

      const result = repository.getById(channel.id, { includeMessages: false });

      expect(result?.messages).toHaveLength(0);
    });

    it('should respect custom messageLimit', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      for (let i = 0; i < 10; i++) {
        repository.createMessage({
          channelId: channel.id,
          senderId: 'agent-1',
          senderType: 'agent',
          senderDisplayName: 'Agent 1',
          content: `Message ${i}`,
          timestamp: Date.now() + i * 1000,
        });
      }

      const result = repository.getById(channel.id, { messageLimit: 5 });

      expect(result?.messages).toHaveLength(5);
    });

    it('should include participants', () => {
      const participants: Participant[] = [
        {
          id: 'agent-1',
          type: 'agent',
          displayName: 'Agent 1',
          color: '#667eea',
          joinedAt: Date.now(),
        },
      ];

      const channel = repository.create(
        {
          name: 'test-channel',
          type: 'public',
        },
        participants
      );

      const result = repository.getById(channel.id);

      expect(result?.participants).toHaveLength(1);
      expect(result?.participants[0].id).toBe('agent-1');
    });

    it('should return all channel properties', () => {
      const now = Date.now();
      const created = repository.create({
        name: 'full-test',
        type: 'direct',
      });

      const result = repository.getById(created.id);

      expect(result).toEqual({
        id: created.id,
        name: 'full-test',
        type: 'direct',
        projectId: undefined,
        pinned: false,
        participants: [],
        messages: [],
        createdAt: expect.any(Number),
      });
    });
  });

  describe('update', () => {
    it('should update channel name', () => {
      const channel = repository.create({ name: 'original-name', type: 'public' });

      const result = repository.update(channel.id, { name: 'updated-name' });

      expect(result?.name).toBe('updated-name');
    });

    it('should persist name update to database', () => {
      const channel = repository.create({ name: 'original-name', type: 'public' });

      repository.update(channel.id, { name: 'updated-name' });

      const dbRow = db.prepare('SELECT name FROM channels WHERE id = ?').get(channel.id) as any;
      expect(dbRow.name).toBe('updated-name');
    });

    it('should return null for non-existent channel', () => {
      const result = repository.update('non-existent-id', { name: 'new-name' });

      expect(result).toBeNull();
    });

    it('should return full channel object after update', () => {
      const channel = repository.create({
        name: 'test',
        type: 'public',
      });

      const result = repository.update(channel.id, { name: 'updated' });

      expect(result?.id).toBe(channel.id);
      expect(result?.type).toBe('public');
      expect(result?.name).toBe('updated');
    });

    it('should handle empty updates', () => {
      const channel = repository.create({ name: 'test', type: 'public' });

      const result = repository.update(channel.id, {});

      expect(result?.id).toBe(channel.id);
      expect(result?.name).toBe('test');
    });

    it('should preserve other properties when updating', () => {
      const now = Date.now();
      const channel = repository.create({
        name: 'original',
        type: 'direct',
      });

      repository.update(channel.id, { name: 'updated' });

      const result = repository.getById(channel.id);

      expect(result?.type).toBe('direct');
      expect(result?.createdAt).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should delete channel', () => {
      const channel = repository.create({ name: 'to-delete', type: 'public' });

      const result = repository.delete(channel.id);

      expect(result).toBe(true);
    });

    it('should remove channel from database', () => {
      const channel = repository.create({ name: 'to-delete', type: 'public' });

      repository.delete(channel.id);

      const dbRow = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
      expect(dbRow).toBeUndefined();
    });

    it('should return false for non-existent channel', () => {
      const result = repository.delete('non-existent-id');

      expect(result).toBe(false);
    });

    it('should delete associated messages', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const msg1 = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Message 1',
        timestamp: Date.now(),
      });

      const msg2 = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-2',
        senderType: 'agent',
        senderDisplayName: 'Agent 2',
        content: 'Message 2',
        timestamp: Date.now() + 1000,
      });

      repository.delete(channel.id);

      const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE channel_id = ?').get(channel.id) as any;
      expect(msgCount.count).toBe(0);
    });

    it('should delete associated participants', () => {
      const participants: Participant[] = [
        {
          id: 'agent-1',
          type: 'agent',
          displayName: 'Agent 1',
          color: '#667eea',
          joinedAt: Date.now(),
        },
      ];

      const channel = repository.create(
        {
          name: 'test-channel',
          type: 'public',
        },
        participants
      );

      repository.delete(channel.id);

      const participantCount = db.prepare('SELECT COUNT(*) as count FROM channel_participants WHERE channel_id = ?').get(channel.id) as any;
      expect(participantCount.count).toBe(0);
    });

    it('should only delete specified channel', () => {
      const channel1 = repository.create({ name: 'channel-1', type: 'public' });
      const channel2 = repository.create({ name: 'channel-2', type: 'public' });

      repository.delete(channel1.id);

      const remaining = repository.getAll();

      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(channel2.id);
    });
  });

  describe('Channel Types', () => {
    it('should support public channel type', () => {
      const channel = repository.create({ name: 'public-channel', type: 'public' });

      expect(channel.type).toBe('public');

      const fetched = repository.getById(channel.id);
      expect(fetched?.type).toBe('public');
    });

    it('should support project channel type', () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run('project-1', 'Test Project', 'A project', now);

      const channel = repository.create({
        name: 'project-channel',
        type: 'project',
        projectId: 'project-1',
      });

      expect(channel.type).toBe('project');
      expect(channel.projectId).toBe('project-1');
    });

    it('should support direct channel type', () => {
      const channel = repository.create({ name: 'direct-channel', type: 'direct' });

      expect(channel.type).toBe('direct');

      const fetched = repository.getById(channel.id);
      expect(fetched?.type).toBe('direct');
    });
  });

  describe('Participants', () => {
    it('should add participant to channel', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const participant: Participant = {
        id: 'agent-1',
        type: 'agent',
        displayName: 'Agent 1',
        color: '#667eea',
        joinedAt: Date.now(),
      };

      repository.addParticipant(channel.id, participant);

      const updated = repository.getById(channel.id);

      expect(updated?.participants).toHaveLength(1);
      expect(updated?.participants[0].id).toBe('agent-1');
    });

    it('should handle multiple participants', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const participants: Participant[] = [
        {
          id: 'agent-1',
          type: 'agent',
          displayName: 'Agent 1',
          color: '#667eea',
          joinedAt: Date.now(),
        },
        {
          id: 'user',
          type: 'human',
          displayName: 'User',
          color: '#2563eb',
          joinedAt: Date.now() + 1000,
        },
        {
          id: 'agent-2',
          type: 'agent',
          displayName: 'Agent 2',
          color: '#ec4899',
          joinedAt: Date.now() + 2000,
        },
      ];

      for (const p of participants) {
        repository.addParticipant(channel.id, p);
      }

      const updated = repository.getById(channel.id);

      expect(updated?.participants).toHaveLength(3);
      expect(updated?.participants.map((p) => p.id)).toContain('agent-1');
      expect(updated?.participants.map((p) => p.id)).toContain('user');
      expect(updated?.participants.map((p) => p.id)).toContain('agent-2');
    });

    it('should preserve participant metadata', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const participant: Participant = {
        id: 'agent-1',
        type: 'agent',
        displayName: 'My Custom Name',
        color: '#ff5722',
        joinedAt: 12345678,
      };

      repository.addParticipant(channel.id, participant);

      const updated = repository.getById(channel.id);
      const p = updated?.participants[0];

      expect(p?.displayName).toBe('My Custom Name');
      expect(p?.color).toBe('#ff5722');
      expect(p?.type).toBe('agent');
    });

    it('should handle participant type as human', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const participant: Participant = {
        id: 'user',
        type: 'human',
        displayName: 'John Doe',
        color: '#2563eb',
        joinedAt: Date.now(),
      };

      repository.addParticipant(channel.id, participant);

      const updated = repository.getById(channel.id);

      expect(updated?.participants[0].type).toBe('human');
      expect(updated?.participants[0].displayName).toBe('John Doe');
    });

    it('should update existing participant if added again', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const participant: Participant = {
        id: 'agent-1',
        type: 'agent',
        displayName: 'Agent 1',
        color: '#667eea',
        joinedAt: Date.now(),
      };

      repository.addParticipant(channel.id, participant);

      const updatedParticipant: Participant = {
        id: 'agent-1',
        type: 'agent',
        displayName: 'Updated Agent 1',
        color: '#ff5722',
        joinedAt: Date.now(),
      };

      repository.addParticipant(channel.id, updatedParticipant);

      const channel_result = repository.getById(channel.id);

      expect(channel_result?.participants).toHaveLength(1);
      expect(channel_result?.participants[0].displayName).toBe('Updated Agent 1');
      expect(channel_result?.participants[0].color).toBe('#ff5722');
    });
  });

  describe('Messages', () => {
    it('should create message in channel', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Hello world',
        timestamp: Date.now(),
      });

      expect(message.id).toMatch(/^msg-/);
      expect(message.channelId).toBe(channel.id);
      expect(message.senderId).toBe('agent-1');
      expect(message.content).toBe('Hello world');
    });

    it('should retrieve messages from channel', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Message 1',
        timestamp: Date.now(),
      });

      repository.createMessage({
        channelId: channel.id,
        senderId: 'user',
        senderType: 'human',
        senderDisplayName: 'User',
        content: 'Message 2',
        timestamp: Date.now() + 1000,
      });

      const messages = repository.getMessagesByChannelId(channel.id);

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Message 1');
      expect(messages[1].content).toBe('Message 2');
    });

    it('should handle message metadata', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'With metadata',
        timestamp: Date.now(),
        metadata: { key: 'value', nested: { prop: 123 } },
      });

      expect(message.metadata).toEqual({ key: 'value', nested: { prop: 123 } });
    });

    it('should handle message metrics', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const metrics = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        timeToComplete: 1234,
        finishReason: 'stop',
        model: 'claude-3-sonnet',
      };

      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'With metrics',
        timestamp: Date.now(),
        metrics,
      });

      expect(message.metrics).toEqual(metrics);
    });

    it('should update message content', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'Original content',
        timestamp: Date.now(),
      });

      repository.updateMessage(message.id, 'Updated content');

      const updated = repository.getMessagesByChannelId(channel.id)[0];

      expect(updated.content).toBe('Updated content');
    });

    it('emits draftFinalized only on a real draft → finalized transition', async () => {
      const { eventBus } = await import('../services/EventBus');
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: '',
        timestamp: Date.now(),
        isDraft: true,
      });

      const updates: unknown[] = [];
      const off = eventBus.onEvent('message:updated', (event) => updates.push(event.data));

      try {
        // Finalizing the draft fires the event the dispatcher listens for
        repository.updateMessageContentBlocks(message.id, [], 'Hello @Bob', false);
        expect(updates).toHaveLength(1);
        expect((updates[0] as { draftFinalized?: boolean }).draftFinalized).toBe(true);

        // Re-saving the already-finalized message with isDraft=false (the
        // approval-decision path) must NOT re-fire and re-dispatch mentions
        repository.updateMessageContentBlocks(message.id, [], 'Hello @Bob', false);
        expect(updates).toHaveLength(1);

        // isDraft undefined never fires regardless of content
        repository.updateMessageContentBlocks(message.id, [], 'Hello @Bob', undefined);
        expect(updates).toHaveLength(1);
      } finally {
        off();
      }
    });

    it('should delete message', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const message = repository.createMessage({
        channelId: channel.id,
        senderId: 'agent-1',
        senderType: 'agent',
        senderDisplayName: 'Agent 1',
        content: 'To delete',
        timestamp: Date.now(),
      });

      const result = repository.deleteMessage(message.id);

      expect(result).toBe(true);

      const messages = repository.getMessagesByChannelId(channel.id);
      expect(messages).toHaveLength(0);
    });

    it('should return false when deleting non-existent message', () => {
      const result = repository.deleteMessage('non-existent-id');

      expect(result).toBe(false);
    });

    it('should handle message limit correctly', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      // Add 10 messages
      for (let i = 0; i < 10; i++) {
        repository.createMessage({
          channelId: channel.id,
          senderId: 'agent-1',
          senderType: 'agent',
          senderDisplayName: 'Agent 1',
          content: `Message ${i}`,
          timestamp: Date.now() + i * 1000,
        });
      }

      // Get last 3 messages
      const messages = repository.getMessagesByChannelId(channel.id, 3);

      expect(messages).toHaveLength(3);
      // Should be the most recent 3 in chronological order
      expect(messages[0].content).toBe('Message 7');
      expect(messages[1].content).toBe('Message 8');
      expect(messages[2].content).toBe('Message 9');
    });

    it('should preserve message timestamp order', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const timestamps = [1000, 3000, 2000, 5000, 4000];

      for (const ts of timestamps) {
        repository.createMessage({
          channelId: channel.id,
          senderId: 'agent-1',
          senderType: 'agent',
          senderDisplayName: 'Agent 1',
          content: `Message at ${ts}`,
          timestamp: ts,
        });
      }

      const messages = repository.getMessagesByChannelId(channel.id);

      // Should be in chronological order (oldest first)
      expect(messages[0].timestamp).toBe(1000);
      expect(messages[1].timestamp).toBe(2000);
      expect(messages[2].timestamp).toBe(3000);
      expect(messages[3].timestamp).toBe(4000);
      expect(messages[4].timestamp).toBe(5000);
    });
  });

  describe('Error Cases', () => {
    it('should handle creating channel with special characters in name', () => {
      const result = repository.create({
        name: "Test's \"Channel\" & <Project>",
        type: 'public',
      });

      expect(result.name).toBe("Test's \"Channel\" & <Project>");
    });

    it('should handle very long channel names', () => {
      const longName = 'a'.repeat(500);

      const result = repository.create({
        name: longName,
        type: 'public',
      });

      expect(result.name).toBe(longName);
    });

    it('should handle empty participants array', () => {
      const result = repository.create(
        {
          name: 'test-channel',
          type: 'public',
        },
        []
      );

      expect(result.participants).toEqual([]);
    });

    it('should handle getMessagesByChannelId for channel with no messages', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const messages = repository.getMessagesByChannelId(channel.id);

      expect(messages).toEqual([]);
    });

    it('should handle getMessagesByChannelId with undefined limit', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      for (let i = 0; i < 5; i++) {
        repository.createMessage({
          channelId: channel.id,
          senderId: 'agent-1',
          senderType: 'agent',
          senderDisplayName: 'Agent 1',
          content: `Message ${i}`,
          timestamp: Date.now() + i * 1000,
        });
      }

      const messages = repository.getMessagesByChannelId(channel.id);

      expect(messages).toHaveLength(5);
    });

    it('should preserve optional participant properties', () => {
      const channel = repository.create({ name: 'test-channel', type: 'public' });

      const participant: Participant = {
        id: 'agent-1',
        type: 'agent',
        displayName: 'Agent 1',
        // color is optional - omitted
        joinedAt: Date.now(),
      };

      repository.addParticipant(channel.id, participant);

      const updated = repository.getById(channel.id);
      const p = updated?.participants[0];

      expect(p?.color).toBeUndefined();
      expect(p?.id).toBe('agent-1');
    });
  });

  describe('Project Relationships', () => {
    it('should associate channel with project', () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run('project-1', 'Test Project', 'A test project', now);

      const channel = repository.create({
        name: 'project-channel',
        type: 'project',
        projectId: 'project-1',
      });

      expect(channel.projectId).toBe('project-1');

      const fetched = repository.getById(channel.id);
      expect(fetched?.projectId).toBe('project-1');
    });

    it('should allow null projectId for public channels', () => {
      const channel = repository.create({
        name: 'public-channel',
        type: 'public',
      });

      expect(channel.projectId).toBeUndefined();

      const fetched = repository.getById(channel.id);
      expect(fetched?.projectId).toBeUndefined();
    });

    it('should allow null projectId for direct channels', () => {
      const channel = repository.create({
        name: 'direct-channel',
        type: 'direct',
      });

      expect(channel.projectId).toBeUndefined();

      const fetched = repository.getById(channel.id);
      expect(fetched?.projectId).toBeUndefined();
    });
  });

  describe('Tags (first-class on all channels)', () => {
    it('persists tags as a JSON string array and round-trips them', () => {
      const channel = repository.create({ name: 'tagged', type: 'public' });

      const updated = repository.update(channel.id, { tags: ['Work', 'Planning'] });

      expect(updated?.tags).toEqual(['Work', 'Planning']);
      const raw = db.prepare('SELECT tags FROM channels WHERE id = ?').get(channel.id) as { tags: string };
      expect(raw.tags).toBe(JSON.stringify(['Work', 'Planning']));
    });

    it('reads comma-separated tags (chat-surface format) as an array', () => {
      const channel = repository.create({ name: 'legacy', type: 'direct' });
      db.prepare('UPDATE channels SET tags = ? WHERE id = ?').run('work, personal', channel.id);

      const fetched = repository.getById(channel.id);

      expect(fetched?.tags).toEqual(['work', 'personal']);
    });

    it('clears tags with an empty array or null (stores NULL, not "[]")', () => {
      const channel = repository.create({ name: 'clearable', type: 'public' });
      repository.update(channel.id, { tags: ['keep'] });

      const clearedByEmpty = repository.update(channel.id, { tags: [] });
      expect(clearedByEmpty?.tags).toBeUndefined();
      let raw = db.prepare('SELECT tags FROM channels WHERE id = ?').get(channel.id) as { tags: string | null };
      expect(raw.tags).toBeNull();

      repository.update(channel.id, { tags: ['again'] });
      const clearedByNull = repository.update(channel.id, { tags: null });
      expect(clearedByNull?.tags).toBeUndefined();
      raw = db.prepare('SELECT tags FROM channels WHERE id = ?').get(channel.id) as { tags: string | null };
      expect(raw.tags).toBeNull();
    });

    it('getByTags matches any provided tag and scopes by type/archived', () => {
      const work = repository.create({ name: 'work-room', type: 'public' });
      const fun = repository.create({ name: 'fun-room', type: 'public' });
      const directWork = repository.create({ name: 'work-chat', type: 'direct' });
      repository.update(work.id, { tags: ['work'] });
      repository.update(fun.id, { tags: ['fun'] });
      repository.update(directWork.id, { tags: ['work'] });

      // Default scope: non-direct only
      expect(repository.getByTags(['work']).map(c => c.id)).toEqual([work.id]);
      // Direct rows are excluded by default, so the chat surface has to opt in
      expect(repository.getByTags(['work'], { type: 'direct' }).map(c => c.id)).toEqual([directWork.id]);
      // Any-of semantics
      expect(repository.getByTags(['work', 'fun']).map(c => c.id).sort())
        .toEqual([work.id, fun.id].sort());
      // Empty tag list matches nothing (not everything)
      expect(repository.getByTags([])).toEqual([]);

      // Archived excluded by default
      repository.archive(work.id);
      expect(repository.getByTags(['work'])).toEqual([]);
      expect(repository.getByTags(['work'], { includeArchived: true }).map(c => c.id)).toEqual([work.id]);
    });

    it('getTagUsage ranks tags by frequency across formats and skips prefixed tags', () => {
      const a = repository.create({ name: 'a', type: 'public' });
      const b = repository.create({ name: 'b', type: 'public' });
      const c = repository.create({ name: 'c', type: 'direct' });
      repository.update(a.id, { tags: ['work', 'folder:archive'] });
      repository.update(b.id, { tags: ['Work', 'fun'] });
      // Comma-delimited form — the chat surface writes `tags` as a string while
      // the channel surface writes a JSON array; both live in the same column.
      db.prepare('UPDATE channels SET tags = ? WHERE id = ?').run('work, personal', c.id);

      expect(repository.getTagUsage()).toEqual(['work', 'fun', 'personal']);
      // Type-scoped usage: the chat surface ranks tags across direct rows only
      expect(repository.getTagUsage(30, 'direct')).toEqual(['personal', 'work']);
      // Limit respected
      expect(repository.getTagUsage(1)).toEqual(['work']);
    });
  });

  describe('Archive (first-class on all channels)', () => {
    it('archive sets archivedAt and unarchive clears it', () => {
      const channel = repository.create({ name: 'to-archive', type: 'public' });

      const archived = repository.archive(channel.id);
      expect(archived?.archivedAt).toEqual(expect.any(Number));

      const restored = repository.unarchive(channel.id);
      expect(restored?.archivedAt).toBeUndefined();
    });

    it('archive/unarchive return null for a non-existent channel', () => {
      expect(repository.archive('non-existent-id')).toBeNull();
      expect(repository.unarchive('non-existent-id')).toBeNull();
    });

    it('getAll excludes archived channels by default and includes them on request', () => {
      const active = repository.create({ name: 'active', type: 'public' });
      const archived = repository.create({ name: 'archived', type: 'public' });
      repository.archive(archived.id);

      expect(repository.getAll().map(c => c.id)).toEqual([active.id]);
      expect(repository.getAll({ includeArchived: true }).map(c => c.id).sort())
        .toEqual([active.id, archived.id].sort());
    });
  });

  describe('search', () => {
    it('matches channel name and message content', () => {
      const roadmap = repository.create({ name: 'roadmap', type: 'public' });
      const general = repository.create({ name: 'general', type: 'public' });
      repository.createMessage({
        channelId: general.id,
        senderId: 'user',
        senderType: 'human',
        senderDisplayName: 'User',
        content: 'the roadmap needs an update',
        timestamp: Date.now(),
      });
      repository.create({ name: 'unrelated', type: 'public' });

      const results = repository.search('roadmap');

      expect(results.map(c => c.id).sort()).toEqual([roadmap.id, general.id].sort());
    });

    it('escapes LIKE wildcards in the query', () => {
      repository.create({ name: 'percent-room', type: 'public' });

      expect(repository.search('%')).toEqual([]);
    });

    it('excludes direct channels by default and scopes to them with type', () => {
      const room = repository.create({ name: 'shared-topic', type: 'public' });
      const chat = repository.create({ name: 'shared-topic-chat', type: 'direct' });

      expect(repository.search('shared-topic').map(c => c.id)).toEqual([room.id]);
      expect(repository.search('shared-topic', { type: 'direct' }).map(c => c.id)).toEqual([chat.id]);
    });

    it('excludes archived channels unless includeArchived is set', () => {
      const channel = repository.create({ name: 'findme', type: 'public' });
      repository.archive(channel.id);

      expect(repository.search('findme')).toEqual([]);
      expect(repository.search('findme', { includeArchived: true }).map(c => c.id)).toEqual([channel.id]);
    });
  });
});
