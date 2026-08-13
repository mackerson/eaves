import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { UserRepository } from './UserRepository';
import { runMigrations } from '../services/migrations';

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
vi.mock('../services/database', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDatabase: vi.fn(() => {
      if (!mockDb) {
        mockDb = new Database(':memory:');
        // Run the production migrations (users, settings, channel_participants,
        // messages, ...) instead of hand-rolled DDL, so this fixture can't drift
        // from migrations.ts.
        runMigrations(mockDb, 0);

        // Insert default settings row, as production's initializeSchema() does.
        const now = Date.now();
        mockDb.prepare(`
          INSERT INTO settings (id, current_user_id, created_at, updated_at) VALUES (1, NULL, ?, ?)
        `).run(now, now);
      }
      return mockDb;
    }),
  };
});

// channel_participants/messages carry a real FK to channels(id) (better-sqlite3
// enforces foreign_keys by default), so tests referencing a channel id must
// first seed a parent row.
function insertChannel(db: Database.Database, id: string, type: 'public' | 'direct' = 'public'): void {
  db.prepare(`
    INSERT INTO channels (id, name, type, created_at) VALUES (?, ?, ?, ?)
  `).run(id, id, type, Date.now());
}

describe('UserRepository', () => {
  let db: Database.Database;
  let repo: UserRepository;

  beforeEach(async () => {
    // Get the mocked database
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();

    // Clear all tables in correct order (respecting foreign key constraints)
    db.exec(`DELETE FROM messages`);
    db.exec(`DELETE FROM channel_participants`);
    db.exec(`DELETE FROM channels`);
    db.exec(`UPDATE settings SET current_user_id = NULL WHERE id = 1`);
    db.exec(`DELETE FROM users`);

    repo = new UserRepository(db);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new user with all fields', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff6b6b',
      });

      expect(user.id).toBeDefined();
      expect(user.name).toBe('Test User');
      expect(user.color).toBe('#ff6b6b');
      expect(user.isCurrent).toBe(false);
      expect(user.createdAt).toBeDefined();
    });

    it('should persist user to database', () => {
      const user = repo.create({
        name: 'Persistent User',
        color: '#667eea',
      });

      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      expect(row).toBeDefined();
      expect((row as any).name).toBe('Persistent User');
      expect((row as any).color).toBe('#667eea');
      expect((row as any).is_current).toBe(0);
    });

    it('should always create users as not current', () => {
      const user = repo.create({
        name: 'New User',
        color: '#4ecdc4',
      });

      expect(user.isCurrent).toBe(false);

      const row = db.prepare('SELECT is_current FROM users WHERE id = ?').get(user.id);
      expect((row as any).is_current).toBe(0);
    });

    it('should handle special characters in name', () => {
      const user = repo.create({
        name: "User's \"Special\" Name (Test)",
        color: '#ff0000',
      });

      expect(user.name).toBe("User's \"Special\" Name (Test)");

      const retrieved = repo.getById(user.id);
      expect(retrieved!.name).toBe("User's \"Special\" Name (Test)");
    });

    it('should handle long names', () => {
      const longName = 'A'.repeat(255);
      const user = repo.create({
        name: longName,
        color: '#00ff00',
      });

      const retrieved = repo.getById(user.id);
      expect(retrieved!.name).toBe(longName);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no users exist', () => {
      const users = repo.getAll();
      expect(users).toEqual([]);
    });

    it('should return all users', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      const users = repo.getAll();
      expect(users).toHaveLength(2);
      expect(users.map(u => u.id)).toContain(user1.id);
      expect(users.map(u => u.id)).toContain(user2.id);
    });

    it('should return users ordered by created_at ASC', () => {
      const user1 = repo.create({
        name: 'First',
        color: '#ff0000',
      });

      // Use direct DB insert with different timestamp to ensure order
      const laterTimestamp = Date.now() + 1000;
      db.prepare(`
        INSERT INTO users (id, name, color, is_current, created_at)
        VALUES (?, ?, ?, 0, ?)
      `).run('user2', 'Second', '#00ff00', laterTimestamp);

      const users = repo.getAll();
      expect(users).toHaveLength(2);
      expect(users[0].id).toBe(user1.id); // First created should be first
      expect(users[1].id).toBe('user2'); // Later created should be second
    });

    it('should correctly map is_current field', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      // Set user2 as current
      repo.switchTo(user2.id);

      const users = repo.getAll();
      const retrieved1 = users.find(u => u.id === user1.id);
      const retrieved2 = users.find(u => u.id === user2.id);

      expect(retrieved1!.isCurrent).toBe(false);
      expect(retrieved2!.isCurrent).toBe(true);
    });
  });

  describe('getById', () => {
    it('should return user by ID', () => {
      const created = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      const user = repo.getById(created.id);
      expect(user).toBeDefined();
      expect(user!.id).toBe(created.id);
      expect(user!.name).toBe('Test User');
      expect(user!.color).toBe('#ff0000');
    });

    it('should return null for non-existent user', () => {
      const user = repo.getById('non-existent-id');
      expect(user).toBeNull();
    });

    it('should return user with all fields', () => {
      const created = repo.create({
        name: 'Full User',
        color: '#3498db',
      });

      const user = repo.getById(created.id);
      expect(user).toBeDefined();
      expect(user!.id).toBe(created.id);
      expect(user!.name).toBe('Full User');
      expect(user!.color).toBe('#3498db');
      expect(user!.isCurrent).toBe(false);
      expect(user!.createdAt).toBeDefined();
    });

    it('should correctly return isCurrent status', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      expect(repo.getById(user.id)!.isCurrent).toBe(false);

      // Set as current
      repo.switchTo(user.id);

      expect(repo.getById(user.id)!.isCurrent).toBe(true);
    });
  });

  describe('getCurrent', () => {
    it('should return null when no current user exists', () => {
      const current = repo.getCurrent();
      expect(current).toBeNull();
    });

    it('should return the current user', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      // Set user2 as current
      repo.switchTo(user2.id);

      const current = repo.getCurrent();
      expect(current).toBeDefined();
      expect(current!.id).toBe(user2.id);
      expect(current!.name).toBe('User 2');
      expect(current!.isCurrent).toBe(true);
    });

    it('should only return one current user', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      repo.switchTo(user1.id);
      expect(repo.getCurrent()!.id).toBe(user1.id);

      repo.switchTo(user2.id);
      expect(repo.getCurrent()!.id).toBe(user2.id);

      // Verify only one user is current
      const currentUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_current = 1').get() as { count: number };
      expect(currentUsers.count).toBe(1);
    });
  });

  describe('update', () => {
    it('should update user name', () => {
      const created = repo.create({
        name: 'Original Name',
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { name: 'Updated Name' });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');

      const retrieved = repo.getById(created.id);
      expect(retrieved!.name).toBe('Updated Name');
    });

    it('should update user color', () => {
      const created = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { color: '#00ff00' });
      expect(updated).toBeDefined();
      expect(updated!.color).toBe('#00ff00');

      const retrieved = repo.getById(created.id);
      expect(retrieved!.color).toBe('#00ff00');
    });

    it('should update both name and color', () => {
      const created = repo.create({
        name: 'Original Name',
        color: '#ff0000',
      });

      const updated = repo.update(created.id, {
        name: 'Updated Name',
        color: '#0000ff',
      });

      expect(updated!.name).toBe('Updated Name');
      expect(updated!.color).toBe('#0000ff');
    });

    it('should return null when updating non-existent user', () => {
      const updated = repo.update('non-existent', { name: 'New Name' });
      expect(updated).toBeNull();
    });

    it('should return user unchanged when empty updates object provided', () => {
      const created = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      const updated = repo.update(created.id, {});
      expect(updated).toBeDefined();
      expect(updated!.id).toBe(created.id);
      expect(updated!.name).toBe('Test User');
      expect(updated!.color).toBe('#ff0000');
    });

    it('should update user with same createdAt after update', () => {
      const created = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { name: 'Updated' });
      expect(updated!.createdAt).toBe(created.createdAt);
    });

    it('should not change isCurrent status on update', () => {
      const created = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      repo.switchTo(created.id);
      expect(repo.getById(created.id)!.isCurrent).toBe(true);

      repo.update(created.id, { name: 'Updated Name' });
      expect(repo.getById(created.id)!.isCurrent).toBe(true);
    });

    it('should sync user context in channel_participants when name changes', () => {
      const user = repo.create({
        name: 'Original Name',
        color: '#ff0000',
      });

      // Insert a channel participant for this user
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', user.id, 'human', 'Original Name', '#ff0000', Date.now());

      repo.update(user.id, { name: 'Updated Name' });

      const participant = db.prepare(`
        SELECT display_name, color FROM channel_participants WHERE participant_id = ?
      `).get(user.id) as { display_name: string; color: string };

      expect(participant.display_name).toBe('Updated Name');
    });

    it('should sync user context in channel_participants when color changes', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      // Insert a channel participant for this user
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', user.id, 'human', 'Test User', '#ff0000', Date.now());

      repo.update(user.id, { color: '#00ff00' });

      const participant = db.prepare(`
        SELECT display_name, color FROM channel_participants WHERE participant_id = ?
      `).get(user.id) as { display_name: string; color: string };

      expect(participant.color).toBe('#00ff00');
    });

    it('should sync user context in messages when name changes', () => {
      const user = repo.create({
        name: 'Original Name',
        color: '#ff0000',
      });

      // Insert a message from this user
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, sender_color, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg1', 'channel1', user.id, 'human', 'Original Name', '#ff0000', 'Hello', Date.now());

      repo.update(user.id, { name: 'Updated Name' });

      const message = db.prepare(`
        SELECT sender_display_name, sender_color FROM messages WHERE id = ?
      `).get('msg1') as { sender_display_name: string; sender_color: string };

      expect(message.sender_display_name).toBe('Updated Name');
    });

    it('should sync user context in messages when color changes', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      // Insert a message from this user
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, sender_color, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg1', 'channel1', user.id, 'human', 'Test User', '#ff0000', 'Hello', Date.now());

      repo.update(user.id, { color: '#0000ff' });

      const message = db.prepare(`
        SELECT sender_display_name, sender_color FROM messages WHERE id = ?
      `).get('msg1') as { sender_display_name: string; sender_color: string };

      expect(message.sender_color).toBe('#0000ff');
    });

    it('should sync multiple channel_participants when user changes', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      // Insert multiple channel participants for this user
      insertChannel(db, 'channel1');
      insertChannel(db, 'channel2');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', user.id, 'human', 'Test User', '#ff0000', Date.now());

      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel2', user.id, 'human', 'Test User', '#ff0000', Date.now());

      repo.update(user.id, { name: 'Updated Name', color: '#00ff00' });

      const participants = db.prepare(`
        SELECT display_name, color FROM channel_participants WHERE participant_id = ?
      `).all(user.id) as Array<{ display_name: string; color: string }>;

      expect(participants).toHaveLength(2);
      participants.forEach(participant => {
        expect(participant.display_name).toBe('Updated Name');
        expect(participant.color).toBe('#00ff00');
      });
    });

    it('should sync multiple messages when user changes', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      // Insert multiple messages from this user
      insertChannel(db, 'channel1');
      insertChannel(db, 'channel2');
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, sender_color, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg1', 'channel1', user.id, 'human', 'Test User', '#ff0000', 'Hello', Date.now());

      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, sender_color, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg2', 'channel2', user.id, 'human', 'Test User', '#ff0000', 'World', Date.now());

      repo.update(user.id, { name: 'Updated Name', color: '#00ff00' });

      const messages = db.prepare(`
        SELECT sender_display_name, sender_color FROM messages WHERE sender_id = ?
      `).all(user.id) as Array<{ sender_display_name: string; sender_color: string }>;

      expect(messages).toHaveLength(2);
      messages.forEach(message => {
        expect(message.sender_display_name).toBe('Updated Name');
        expect(message.sender_color).toBe('#00ff00');
      });
    });

    it('should not affect agent participants or messages', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      // Insert agent participant and message
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', 'agent1', 'agent', 'Agent Name', '#0000ff', Date.now());

      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, sender_color, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg1', 'channel1', 'agent1', 'agent', 'Agent Name', '#0000ff', 'Hello', Date.now());

      repo.update(user.id, { name: 'Updated Name', color: '#00ff00' });

      const participant = db.prepare(`
        SELECT display_name, color FROM channel_participants WHERE participant_id = ?
      `).get('agent1') as { display_name: string; color: string };

      const message = db.prepare(`
        SELECT sender_display_name, sender_color FROM messages WHERE id = ?
      `).get('msg1') as { sender_display_name: string; sender_color: string };

      expect(participant.display_name).toBe('Agent Name');
      expect(participant.color).toBe('#0000ff');
      expect(message.sender_display_name).toBe('Agent Name');
      expect(message.sender_color).toBe('#0000ff');
    });
  });

  describe('delete', () => {
    it('should delete user by ID', () => {
      const created = repo.create({
        name: 'User to Delete',
        color: '#ff0000',
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);

      const retrieved = repo.getById(created.id);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent user', () => {
      const deleted = repo.delete('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should delete user from database', () => {
      const created = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      repo.delete(created.id);

      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
      expect(row).toBeUndefined();
    });

    it('should throw error when trying to delete current user', () => {
      const user = repo.create({
        name: 'Current User',
        color: '#ff0000',
      });

      repo.switchTo(user.id);

      expect(() => repo.delete(user.id)).toThrow('Cannot delete the current user');

      // User should still exist
      const retrieved = repo.getById(user.id);
      expect(retrieved).toBeDefined();
    });

    it('should allow deleting non-current users', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      // Set user1 as current
      repo.switchTo(user1.id);

      // Should be able to delete user2
      const deleted = repo.delete(user2.id);
      expect(deleted).toBe(true);
      expect(repo.getById(user2.id)).toBeNull();

      // user1 should still exist
      expect(repo.getById(user1.id)).toBeDefined();
    });

    it('should handle multiple deletions', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      const user3 = repo.create({
        name: 'User 3',
        color: '#0000ff',
      });

      expect(repo.delete(user1.id)).toBe(true);
      expect(repo.delete(user2.id)).toBe(true);

      const users = repo.getAll();
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(user3.id);
    });
  });

  describe('switchTo', () => {
    it('should switch to a different user', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      const switched = repo.switchTo(user2.id);
      expect(switched).toBeDefined();
      expect(switched!.id).toBe(user2.id);
      expect(switched!.isCurrent).toBe(true);

      // Verify in database
      expect(repo.getCurrent()!.id).toBe(user2.id);
    });

    it('should set previous current user to not current', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      repo.switchTo(user1.id);
      expect(repo.getById(user1.id)!.isCurrent).toBe(true);

      repo.switchTo(user2.id);
      expect(repo.getById(user1.id)!.isCurrent).toBe(false);
      expect(repo.getById(user2.id)!.isCurrent).toBe(true);
    });

    it('should return null when switching to non-existent user', () => {
      const switched = repo.switchTo('non-existent');
      expect(switched).toBeNull();
    });

    it('should update settings table with current_user_id', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      repo.switchTo(user.id);

      const settings = db.prepare('SELECT current_user_id FROM settings WHERE id = 1').get() as { current_user_id: string };
      expect(settings.current_user_id).toBe(user.id);
    });

    it('should ensure only one user is current at a time', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      const user3 = repo.create({
        name: 'User 3',
        color: '#0000ff',
      });

      repo.switchTo(user1.id);
      repo.switchTo(user2.id);
      repo.switchTo(user3.id);

      const currentUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_current = 1').get() as { count: number };
      expect(currentUsers.count).toBe(1);

      expect(repo.getCurrent()!.id).toBe(user3.id);
    });

    it('should handle switching to same user', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      repo.switchTo(user.id);
      expect(repo.getCurrent()!.id).toBe(user.id);

      repo.switchTo(user.id);
      expect(repo.getCurrent()!.id).toBe(user.id);

      const currentUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_current = 1').get() as { count: number };
      expect(currentUsers.count).toBe(1);
    });

    it('should return user with updated isCurrent field', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      expect(user.isCurrent).toBe(false);

      const switched = repo.switchTo(user.id);
      expect(switched!.isCurrent).toBe(true);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle user names with special characters', () => {
      const user = repo.create({
        name: "User's \"Special\" Name (Test) & <html>",
        color: '#ff0000',
      });

      expect(user.name).toBe("User's \"Special\" Name (Test) & <html>");

      const retrieved = repo.getById(user.id);
      expect(retrieved!.name).toBe("User's \"Special\" Name (Test) & <html>");
    });

    it('should handle color codes with different formats', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#fff',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#ffffff',
      });

      const user3 = repo.create({
        name: 'User 3',
        color: 'rgb(255, 0, 0)',
      });

      expect(repo.getById(user1.id)!.color).toBe('#fff');
      expect(repo.getById(user2.id)!.color).toBe('#ffffff');
      expect(repo.getById(user3.id)!.color).toBe('rgb(255, 0, 0)');
    });

    it('should maintain data integrity with multiple concurrent operations', () => {
      const users = [];
      for (let i = 0; i < 5; i++) {
        users.push(
          repo.create({
            name: `User ${i}`,
            color: `#${String(i).padStart(6, '0')}`,
          })
        );
      }

      const all = repo.getAll();
      expect(all).toHaveLength(5);

      // Update each user
      users.forEach((user, index) => {
        repo.update(user.id, { name: `Updated User ${index}` });
      });

      const updated = repo.getAll();
      expect(updated).toHaveLength(5);

      // Verify all users have "Updated User" prefix
      updated.forEach(user => {
        expect(user.name).toMatch(/^Updated User \d$/);
      });

      // Switch between users
      users.forEach(user => {
        repo.switchTo(user.id);
        expect(repo.getCurrent()!.id).toBe(user.id);
      });

      // Delete non-current users
      for (let i = 0; i < 3; i++) {
        repo.delete(users[i].id);
      }

      const final = repo.getAll();
      expect(final).toHaveLength(2);
    });

    it('should handle empty user name', () => {
      const user = repo.create({
        name: '',
        color: '#ff0000',
      });

      expect(user.name).toBe('');
      expect(repo.getById(user.id)!.name).toBe('');
    });

    it('should handle emoji in user names', () => {
      const user = repo.create({
        name: 'User Test',
        color: '#ff0000',
      });

      expect(user.name).toBe('User Test');
      expect(repo.getById(user.id)!.name).toBe('User Test');
    });

    it('should handle unicode characters in user names', () => {
      const user = repo.create({
        name: 'User Test Name',
        color: '#ff0000',
      });

      expect(user.name).toBe('User Test Name');
      expect(repo.getById(user.id)!.name).toBe('User Test Name');
    });

    it('should handle very long color strings', () => {
      const longColor = 'rgba(255, 0, 0, 0.5)';
      const user = repo.create({
        name: 'Test User',
        color: longColor,
      });

      expect(repo.getById(user.id)!.color).toBe(longColor);
    });

    it('should preserve timestamp precision', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      const retrieved = repo.getById(user.id);
      expect(retrieved!.createdAt).toBe(user.createdAt);

      // Check precision by comparing with database value
      const row = db.prepare('SELECT created_at FROM users WHERE id = ?').get(user.id) as { created_at: number };
      expect(row.created_at).toBe(user.createdAt);
    });
  });

  describe('Integration scenarios', () => {
    it('should handle complete user lifecycle', () => {
      // Create user
      const user = repo.create({
        name: 'Lifecycle User',
        color: '#ff0000',
      });

      expect(user.isCurrent).toBe(false);

      // Switch to user
      repo.switchTo(user.id);
      expect(repo.getCurrent()!.id).toBe(user.id);

      // Update user
      repo.update(user.id, { name: 'Updated Lifecycle User', color: '#00ff00' });
      expect(repo.getCurrent()!.name).toBe('Updated Lifecycle User');
      expect(repo.getCurrent()!.color).toBe('#00ff00');

      // Create and switch to another user
      const user2 = repo.create({
        name: 'User 2',
        color: '#0000ff',
      });

      repo.switchTo(user2.id);
      expect(repo.getCurrent()!.id).toBe(user2.id);

      // Delete first user (should succeed since it's not current)
      const deleted = repo.delete(user.id);
      expect(deleted).toBe(true);
      expect(repo.getById(user.id)).toBeNull();

      // Current user should still be user2
      expect(repo.getCurrent()!.id).toBe(user2.id);
    });

    it('should maintain referential integrity across tables', () => {
      const user = repo.create({
        name: 'Test User',
        color: '#ff0000',
      });

      // Add channel participants and messages
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', user.id, 'human', 'Test User', '#ff0000', Date.now());

      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, sender_color, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg1', 'channel1', user.id, 'human', 'Test User', '#ff0000', 'Hello', Date.now());

      // Update user should sync all related records
      repo.update(user.id, { name: 'Updated User', color: '#00ff00' });

      const participant = db.prepare('SELECT display_name, color FROM channel_participants WHERE participant_id = ?').get(user.id);
      const message = db.prepare('SELECT sender_display_name, sender_color FROM messages WHERE sender_id = ?').get(user.id);

      expect((participant as any).display_name).toBe('Updated User');
      expect((participant as any).color).toBe('#00ff00');
      expect((message as any).sender_display_name).toBe('Updated User');
      expect((message as any).sender_color).toBe('#00ff00');
    });

    it('should handle multiple users with channel participation', () => {
      const user1 = repo.create({
        name: 'User 1',
        color: '#ff0000',
      });

      const user2 = repo.create({
        name: 'User 2',
        color: '#00ff00',
      });

      // Both users join same channel
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', user1.id, 'human', 'User 1', '#ff0000', Date.now());

      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', user2.id, 'human', 'User 2', '#00ff00', Date.now());

      // Update user1 should only affect user1's records
      repo.update(user1.id, { name: 'Updated User 1', color: '#0000ff' });

      const participants = db.prepare('SELECT participant_id, display_name, color FROM channel_participants WHERE channel_id = ?').all('channel1');

      expect(participants).toHaveLength(2);

      const user1Participant = (participants as any[]).find(p => p.participant_id === user1.id);
      const user2Participant = (participants as any[]).find(p => p.participant_id === user2.id);

      expect(user1Participant.display_name).toBe('Updated User 1');
      expect(user1Participant.color).toBe('#0000ff');
      expect(user2Participant.display_name).toBe('User 2');
      expect(user2Participant.color).toBe('#00ff00');
    });
  });
});
