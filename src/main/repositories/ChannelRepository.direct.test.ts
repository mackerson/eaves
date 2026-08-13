import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelRepository } from './ChannelRepository';
import { runMigrations } from '../services/migrations';
import { Participant, ChatMessage } from '../types';

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

// ChannelRepository owns the direct-channel (chat) projection and the
// branch/swipe tree ops, because a chat IS a `channels` row with type='direct'.
// These tests cover that projection specifically; the multi-participant channel
// surface over the same tables is covered in ChannelRepository.test.ts.
describe('ChannelRepository direct-channel (chat) projection', () => {
  let db: Database.Database;
  let repository: ChannelRepository;

  beforeEach(async () => {
    db = new Database(':memory:');

    // Run the production migrations rather than hand-rolled DDL so this fixture
    // can't drift from migrations.ts. A "chat" is projected over a channels row
    // with type='direct'; its messages live in `messages` (channel_id),
    // participants in `channel_participants`.
    runMigrations(db, 0);

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, model, temperature, color, created_at)
      VALUES ('agent-1', 'Test Agent', 'A test agent', 'anthropic', 'claude-3-sonnet', 0.7, '#667eea', ?)
    `).run(Date.now());

    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    repository = new ChannelRepository();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new chat', () => {
      const chat = repository.createDirectChat({ name: 'Test Chat', agentId: 'agent-1' });
      expect(chat.id).toMatch(/^chat-/);
      expect(chat.name).toBe('Test Chat');
      expect(chat.agentId).toBe('agent-1');
    });

    it('should create chat with tags', () => {
      const chat = repository.createDirectChat({ name: 'Tagged', agentId: 'agent-1', tags: 'important,work' });
      expect(chat.tags).toBe('important,work');
    });

    it('should create chat with initial participants', () => {
      const participants: Participant[] = [
        { id: 'user', type: 'human', displayName: 'Test User', joinedAt: Date.now() },
      ];
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' }, participants);
      expect(chat.participants).toHaveLength(1);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no chats', () => {
      expect(repository.getDirectChats()).toEqual([]);
    });

    it('should return all non-archived chats', () => {
      repository.createDirectChat({ name: 'Chat 1', agentId: 'agent-1' });
      repository.createDirectChat({ name: 'Chat 2', agentId: 'agent-1' });
      expect(repository.getDirectChats()).toHaveLength(2);
    });

    it('should exclude archived chats by default', () => {
      const chat1 = repository.createDirectChat({ name: 'Active', agentId: 'agent-1' });
      const chat2 = repository.createDirectChat({ name: 'Archived', agentId: 'agent-1' });
      repository.archiveDirectChat(chat2.id);
      const chats = repository.getDirectChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].id).toBe(chat1.id);
    });

    it('should include archived when includeArchived is true', () => {
      repository.createDirectChat({ name: 'Active', agentId: 'agent-1' });
      const chat2 = repository.createDirectChat({ name: 'Archived', agentId: 'agent-1' });
      repository.archiveDirectChat(chat2.id);
      expect(repository.getDirectChats({ includeArchived: true })).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('should return chat by ID', () => {
      const created = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const chat = repository.getDirectChatById(created.id);
      expect(chat!.name).toBe('Test');
    });

    it('should return null for non-existent', () => {
      expect(repository.getDirectChatById('non-existent')).toBeNull();
    });

    it('should include messages by default', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Hello', timestamp: Date.now() });
      expect(repository.getDirectChatById(chat.id)!.messages).toHaveLength(1);
    });

    it('should exclude messages when includeMessages is false', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Hello', timestamp: Date.now() });
      expect(repository.getDirectChatById(chat.id, { includeMessages: false })!.messages).toEqual([]);
    });
  });

  describe('getTagUsage', () => {
    it('ranks tags by frequency, excluding prefixed organizational tags', () => {
      repository.createDirectChat({ name: 'A', agentId: 'agent-1', tags: 'rust, embedded' });
      repository.createDirectChat({ name: 'B', agentId: 'agent-1', tags: 'rust, folder:work' });
      repository.createDirectChat({ name: 'C', agentId: 'agent-1', tags: 'Rust, typescript, project:abc' });

      const tags = repository.getTagUsage(30, 'direct');
      expect(tags[0]).toBe('rust'); // 3 uses, case-folded
      expect(tags).toContain('embedded');
      expect(tags).toContain('typescript');
      expect(tags).not.toContain('folder:work');
      expect(tags).not.toContain('project:abc');
    });

    it('respects the limit and returns empty for no tags', () => {
      expect(repository.getTagUsage(30, 'direct')).toEqual([]);
      repository.createDirectChat({ name: 'A', agentId: 'agent-1', tags: 'one, two, three' });
      expect(repository.getTagUsage(2, 'direct')).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('should update chat name', () => {
      const chat = repository.createDirectChat({ name: 'Original', agentId: 'agent-1' });
      const updated = repository.updateDirectChat(chat.id, { name: 'Updated' });
      expect(updated!.name).toBe('Updated');
    });

    it('should return null for non-existent', () => {
      expect(repository.updateDirectChat('non-existent', { name: 'Test' })).toBeNull();
    });

    it('round-trips userPersona for roleplay chats', () => {
      const chat = repository.createDirectChat({ name: 'RP', agentId: 'agent-1' });
      expect(chat.userPersona).toBeUndefined();

      const updated = repository.updateDirectChat(chat.id, { userPersona: 'Kael, a wandering scribe' });
      expect(updated!.userPersona).toBe('Kael, a wandering scribe');

      const reloaded = repository.getDirectChatById(chat.id);
      expect(reloaded!.userPersona).toBe('Kael, a wandering scribe');
    });

    it('clears userPersona when set to empty string', () => {
      const chat = repository.createDirectChat({ name: 'RP', agentId: 'agent-1' });
      repository.updateDirectChat(chat.id, { userPersona: 'Kael' });
      const cleared = repository.updateDirectChat(chat.id, { userPersona: '' });
      expect(cleared!.userPersona).toBeUndefined();
    });
  });

  describe('archive and unarchive', () => {
    it('should archive a chat', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const archived = repository.archiveDirectChat(chat.id);
      expect(archived!.archivedAt).toBeDefined();
    });

    it('should unarchive a chat', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      repository.archiveDirectChat(chat.id);
      const unarchived = repository.unarchiveDirectChat(chat.id);
      expect(unarchived!.archivedAt).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should delete chat', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      expect(repository.delete(chat.id)).toBe(true);
      expect(repository.getDirectChatById(chat.id)).toBeNull();
    });

    it('should return false for non-existent', () => {
      expect(repository.delete('non-existent')).toBe(false);
    });

    it('should delete associated messages', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Hello', timestamp: Date.now() });
      repository.delete(chat.id);
      expect(db.prepare('SELECT * FROM messages WHERE channel_id = ?').all(chat.id)).toHaveLength(0);
    });
  });

  describe('search', () => {
    it('should search by name', () => {
      repository.createDirectChat({ name: 'Project Discussion', agentId: 'agent-1' });
      repository.createDirectChat({ name: 'Random Chat', agentId: 'agent-1' });
      const results = repository.searchDirectChats('Project');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Project Discussion');
    });

    it('should search by message content', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'TypeScript info', timestamp: Date.now() });
      expect(repository.searchDirectChats('TypeScript')).toHaveLength(1);
    });
  });

  describe('createMessage', () => {
    it('should create message', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const msg = repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Hello', timestamp: Date.now() });
      expect(msg.id).toMatch(/^chatmsg-/);
      expect(msg.content).toBe('Hello');
    });

    it('should update last_message_at', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const ts = Date.now();
      repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Hello', timestamp: ts });
      expect(repository.getDirectChatById(chat.id)!.lastMessageAt).toBe(ts);
    });
  });

  describe('getMessagesByChatId', () => {
    it('should return messages in chronological order', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const now = Date.now();
      repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'First', timestamp: now });
      repository.createDirectMessage({ chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'Second', timestamp: now + 100 });
      const messages = repository.getMessagesByChatId(chat.id);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
    });

    it('should respect message limit', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: `Msg ${i}`, timestamp: now + i * 100 });
      }
      const messages = repository.getMessagesByChatId(chat.id, 3);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('Msg 7');
    });
  });

  describe('updateMessage', () => {
    it('should update with string', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const msg = repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Original', timestamp: Date.now() });
      repository.updateMessage(msg.id, 'Updated');
      expect(repository.getDirectChatById(chat.id)!.messages[0].content).toBe('Updated');
    });

    it('should update with object', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const msg = repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Original', timestamp: Date.now() });
      repository.updateMessage(msg.id, { content: 'New content' });
      expect(repository.getDirectChatById(chat.id)!.messages[0].content).toBe('New content');
    });
  });

  describe('deleteMessage', () => {
    it('should delete message', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const msg = repository.createDirectMessage({ chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Delete me', timestamp: Date.now() });
      expect(repository.deleteMessage(msg.id)).toBe(true);
      expect(repository.getDirectChatById(chat.id)!.messages).toHaveLength(0);
    });

    it('should return false for non-existent', () => {
      expect(repository.deleteMessage('non-existent')).toBe(false);
    });
  });

  describe('bulkCreateMessages', () => {
    it('should create multiple messages', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      const now = Date.now();
      const messages: Omit<ChatMessage, 'id'>[] = [
        { chatId: chat.id, senderId: 'user', senderType: 'human', content: 'Msg 1', timestamp: now },
        { chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'Msg 2', timestamp: now + 100 },
      ];
      const ids = repository.bulkCreateDirectMessages(messages);
      expect(ids).toHaveLength(2);
      expect(repository.getDirectChatById(chat.id)!.messages).toHaveLength(2);
    });

    it('should return empty array for empty input', () => {
      expect(repository.bulkCreateDirectMessages([])).toEqual([]);
    });
  });

  describe('branch-aware operations', () => {
    /**
     * Helper that builds the canonical "two regenerations" tree:
     *   U (user, root, active)
     *   ├── A1 (agent, branch 0, ARCHIVED)
     *   └── A2 (agent, branch 1, ACTIVE)
     */
    function buildTwoBranchTree(chatId: string) {
      const u = repository.createDirectMessage({
        chatId, senderId: 'user', senderType: 'human', content: 'hi', timestamp: 1000,
      });
      const a1 = repository.createDirectMessage({
        chatId, senderId: 'agent-1', senderType: 'agent', content: 'response 1', timestamp: 1100,
        parentMessageId: u.id, branchIndex: 0, status: 'archived',
      });
      const a2 = repository.createDirectMessage({
        chatId, senderId: 'agent-1', senderType: 'agent', content: 'response 2', timestamp: 1200,
        parentMessageId: u.id, branchIndex: 1, status: 'active',
      });
      return { u, a1, a2 };
    }

    describe('getMessagesByChatId active-only filter', () => {
      it('hides archived branches by default', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { u, a2 } = buildTwoBranchTree(chat.id);
        const msgs = repository.getMessagesByChatId(chat.id);
        expect(msgs.map(m => m.id)).toEqual([u.id, a2.id]);
      });

      it('includes archived rows when activeOnly=false', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { u, a1, a2 } = buildTwoBranchTree(chat.id);
        const msgs = repository.getMessagesByChatId(chat.id, undefined, { activeOnly: false });
        expect(msgs.map(m => m.id).sort()).toEqual([u.id, a1.id, a2.id].sort());
      });

      it('feeds active-only into Chat.messages via getById', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { u, a2 } = buildTwoBranchTree(chat.id);
        const loaded = repository.getDirectChatById(chat.id);
        expect(loaded!.messages.map(m => m.id)).toEqual([u.id, a2.id]);
      });
    });

    describe('getSiblings', () => {
      it('returns siblings ordered by branch_index, including archived', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { a1, a2 } = buildTwoBranchTree(chat.id);
        expect(repository.getSiblings(a2.id).map(s => s.id)).toEqual([a1.id, a2.id]);
        expect(repository.getSiblings(a1.id).map(s => s.id)).toEqual([a1.id, a2.id]);
      });

      it('treats messages with NULL parent as siblings of each other', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const u1 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'a', timestamp: 1,
        });
        const u2 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'b', timestamp: 2,
          branchIndex: 1,
        });
        expect(repository.getSiblings(u1.id).map(s => s.id).sort()).toEqual([u1.id, u2.id].sort());
      });

      it('returns empty for unknown message', () => {
        expect(repository.getSiblings('missing')).toEqual([]);
      });
    });

    describe('getNextBranchIndex', () => {
      it('returns 0 when no siblings exist under the parent', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const u = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'a', timestamp: 1,
        });
        expect(repository.getNextBranchIndex(chat.id, u.id)).toBe(0);
      });

      it('returns max(branch_index) + 1', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { u } = buildTwoBranchTree(chat.id);
        expect(repository.getNextBranchIndex(chat.id, u.id)).toBe(2);
      });

      it('handles NULL parent (root-level siblings)', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'a', timestamp: 1,
        });
        expect(repository.getNextBranchIndex(chat.id, null)).toBe(1);
      });
    });

    describe('regenerateFrom', () => {
      it('archives the target and returns parentage + next branch_index', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { u, a2 } = buildTwoBranchTree(chat.id);
        const result = repository.regenerateFrom(a2.id);
        expect(result.parentMessageId).toBe(u.id);
        expect(result.nextBranchIndex).toBe(2);
        expect(result.chatId).toBe(chat.id);
        expect(result.archivedIds).toContain(a2.id);

        const all = repository.getMessagesByChatId(chat.id, undefined, { activeOnly: false });
        expect(all.find(m => m.id === a2.id)?.status).toBe('archived');
      });

      it('archives the entire active subtree below the target', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const u = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'q', timestamp: 1,
        });
        const a = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r', timestamp: 2,
          parentMessageId: u.id, branchIndex: 0, status: 'active',
        });
        const followupQ = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'q2', timestamp: 3,
          parentMessageId: a.id, branchIndex: 0, status: 'active',
        });
        const followupA = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r2', timestamp: 4,
          parentMessageId: followupQ.id, branchIndex: 0, status: 'active',
        });

        const result = repository.regenerateFrom(a.id);
        expect(result.archivedIds).toEqual(
          expect.arrayContaining([a.id, followupQ.id, followupA.id])
        );
        expect(repository.getMessagesByChatId(chat.id).map(m => m.id)).toEqual([u.id]);
      });

      it('does not descend through already-archived rows', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const u = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'q', timestamp: 1,
        });
        const a = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r', timestamp: 2,
          parentMessageId: u.id, branchIndex: 0, status: 'active',
        });
        // child already archived from a previous swipe — shouldn't be revisited.
        const oldFollowup = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'old', timestamp: 3,
          parentMessageId: a.id, branchIndex: 0, status: 'archived',
        });
        const result = repository.regenerateFrom(a.id);
        expect(result.archivedIds).toContain(a.id);
        expect(result.archivedIds).not.toContain(oldFollowup.id);
      });

      it('throws when the message does not exist', () => {
        expect(() => repository.regenerateFrom('missing')).toThrow();
      });
    });

    describe('branchCount hydration', () => {
      it('attaches branchCount = total siblings under the same parent (incl. archived)', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { u, a2 } = buildTwoBranchTree(chat.id);
        // Active path is U → A2. branchCount under parent U should be 2 (a1+a2).
        const msgs = repository.getMessagesByChatId(chat.id);
        const uMsg = msgs.find(m => m.id === u.id)!;
        const a2Msg = msgs.find(m => m.id === a2.id)!;
        expect(uMsg.branchCount).toBe(1); // U is the only root
        expect(a2Msg.branchCount).toBe(2);
      });

      it('defaults to 1 for messages whose parent has no other children', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'solo', timestamp: 1,
        });
        const msgs = repository.getMessagesByChatId(chat.id);
        expect(msgs[0].branchCount).toBe(1);
      });

      it('never counts root-level (NULL-parent) rows as siblings of each other', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        // Three rows with NULL parent_id — a chat opener plus any continuation
        // messages written without a parent link. They are not regeneration
        // variants and must not grow a phantom carousel.
        for (let i = 0; i < 3; i++) {
          repository.createDirectMessage({
            chatId: chat.id, senderId: i === 0 ? 'user' : 'agent-1',
            senderType: i === 0 ? 'human' : 'agent',
            content: `m${i}`, timestamp: i + 1,
          });
        }
        const msgs = repository.getMessagesByChatId(chat.id);
        expect(msgs).toHaveLength(3);
        for (const m of msgs) expect(m.branchCount).toBe(1);
      });

      it('returns empty messages without querying for counts', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        expect(repository.getMessagesByChatId(chat.id)).toEqual([]);
      });
    });

    describe('getLatestActiveMessageId', () => {
      it('returns null for an empty chat', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        expect(repository.getLatestActiveMessageId(chat.id)).toBeNull();
      });

      it('returns the highest-timestamp active message', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'a', timestamp: 1,
        });
        const second = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'b', timestamp: 2,
        });
        expect(repository.getLatestActiveMessageId(chat.id)).toBe(second.id);
      });

      it('skips archived messages even if they are more recent', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const active = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'a', timestamp: 1,
        });
        repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'b', timestamp: 2,
          status: 'archived',
        });
        expect(repository.getLatestActiveMessageId(chat.id)).toBe(active.id);
      });
    });

    describe('switchActiveBranch', () => {
      it('activates the target and archives the previously-active sibling', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const u = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'q', timestamp: 1,
        });
        const a1 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r1', timestamp: 2,
          parentMessageId: u.id, branchIndex: 0, status: 'active',
        });
        const a2 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r2', timestamp: 3,
          parentMessageId: u.id, branchIndex: 1, status: 'archived',
        });

        repository.switchActiveBranch(a2.id);

        const all = repository.getMessagesByChatId(chat.id, undefined, { activeOnly: false });
        expect(all.find(m => m.id === a1.id)?.status).toBe('archived');
        expect(all.find(m => m.id === a2.id)?.status).toBe('active');
      });

      it('archives the displaced sibling subtree (no orphan active descendants)', () => {
        // Models the "user explored sibling A1, continued the conversation,
        // then swipes back to A2" case. A1's child is still status='active'
        // until we switch — switchActiveBranch must archive it too, otherwise
        // the visible chain would contain both A2 (just activated) AND A1's
        // child as siblings-by-timestamp.
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const u = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'q', timestamp: 1,
        });
        const a1 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r1', timestamp: 2,
          parentMessageId: u.id, branchIndex: 0, status: 'active',
        });
        const a1child = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'follow', timestamp: 3,
          parentMessageId: a1.id, branchIndex: 0, status: 'active',
        });
        const a2 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r2', timestamp: 4,
          parentMessageId: u.id, branchIndex: 1, status: 'archived',
        });

        repository.switchActiveBranch(a2.id);

        const all = repository.getMessagesByChatId(chat.id, undefined, { activeOnly: false });
        expect(all.find(m => m.id === a1.id)?.status).toBe('archived');
        expect(all.find(m => m.id === a1child.id)?.status).toBe('archived');
        expect(all.find(m => m.id === a2.id)?.status).toBe('active');
      });

      it('walks down: activates highest-branch_index descendant chain', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const u = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'q', timestamp: 1,
        });
        const a = repository.createDirectMessage({
          chatId: chat.id, senderId: 'agent-1', senderType: 'agent', content: 'r', timestamp: 2,
          parentMessageId: u.id, branchIndex: 0, status: 'archived',
        });
        const child0 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'c0', timestamp: 3,
          parentMessageId: a.id, branchIndex: 0, status: 'archived',
        });
        const child1 = repository.createDirectMessage({
          chatId: chat.id, senderId: 'user', senderType: 'human', content: 'c1', timestamp: 4,
          parentMessageId: a.id, branchIndex: 1, status: 'archived',
        });

        repository.switchActiveBranch(a.id);

        const all = repository.getMessagesByChatId(chat.id, undefined, { activeOnly: false });
        expect(all.find(m => m.id === a.id)?.status).toBe('active');
        expect(all.find(m => m.id === child1.id)?.status).toBe('active');
        expect(all.find(m => m.id === child0.id)?.status).toBe('archived');
      });

      it('produces a coherent active path after switch', () => {
        const chat = repository.createDirectChat({ name: 'T', agentId: 'agent-1' });
        const { u, a2 } = buildTwoBranchTree(chat.id);
        // Currently A2 is active. Switch to A1.
        const all = repository.getMessagesByChatId(chat.id, undefined, { activeOnly: false });
        const a1 = all.find(m => m.id !== u.id && m.id !== a2.id)!;

        repository.switchActiveBranch(a1.id);

        expect(repository.getMessagesByChatId(chat.id).map(m => m.id)).toEqual([u.id, a1.id]);
      });

      it('throws when the message does not exist', () => {
        expect(() => repository.switchActiveBranch('missing')).toThrow();
      });
    });
  });

  describe('addParticipant', () => {
    it('should add participant', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      repository.addParticipant(chat.id, { id: 'user', type: 'human', displayName: 'User', joinedAt: Date.now() });
      expect(repository.getDirectChatById(chat.id)!.participants).toHaveLength(1);
    });

    it('should update existing participant on conflict', () => {
      const chat = repository.createDirectChat({ name: 'Test', agentId: 'agent-1' });
      repository.addParticipant(chat.id, { id: 'user', type: 'human', displayName: 'Original', joinedAt: Date.now() });
      repository.addParticipant(chat.id, { id: 'user', type: 'human', displayName: 'Updated', joinedAt: Date.now() });
      expect(repository.getDirectChatById(chat.id)!.participants).toHaveLength(1);
      expect(repository.getDirectChatById(chat.id)!.participants[0].displayName).toBe('Updated');
    });
  });
});
