import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ActivityRepository } from './ActivityRepository';
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
        // Seed schema by running the production migrations rather than
        // hand-rolled DDL, so the test schema can't drift from migrations.ts.
        runMigrations(mockDb, 0);
      }
      return mockDb;
    }),
  };
});

describe('ActivityRepository', () => {
  let db: Database.Database;
  let repo: ActivityRepository;

  beforeEach(async () => {
    // Get the mocked database
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();

    // Clear all tables
    db.exec(`DELETE FROM activities`);
    db.exec(`DELETE FROM projects`);

    repo = new ActivityRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new activity with all fields', () => {
      const timestamp = Date.now();
      const data = JSON.stringify({ key: 'value', nested: { foo: 'bar' } });

      // Create a project for foreign key constraint
      db.prepare('INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
        'project-123',
        'Test Project',
        'Description',
        timestamp
      );

      const activity = repo.create({
        type: 'agent.created',
        category: 'agents',
        source: 'core',
        data,
        projectId: 'project-123',
        timestamp,
      });

      expect(activity.id).toBeDefined();
      expect(activity.type).toBe('agent.created');
      expect(activity.category).toBe('agents');
      expect(activity.source).toBe('core');
      expect(activity.data).toEqual({ key: 'value', nested: { foo: 'bar' } });
      expect(activity.projectId).toBe('project-123');
      expect(activity.timestamp).toBe(timestamp);
      expect(activity.createdAt).toBeDefined();
    });

    it('should create activity without optional fields', () => {
      const timestamp = Date.now();

      const activity = repo.create({
        type: 'message.sent',
        category: 'messages',
        source: 'channel',
        timestamp,
      });

      expect(activity.id).toBeDefined();
      expect(activity.type).toBe('message.sent');
      expect(activity.category).toBe('messages');
      expect(activity.source).toBe('channel');
      expect(activity.data).toBeUndefined();
      expect(activity.projectId).toBeUndefined();
      expect(activity.timestamp).toBe(timestamp);
      expect(activity.createdAt).toBeDefined();
    });

    it('should create activity with null data', () => {
      const timestamp = Date.now();

      const activity = repo.create({
        type: 'task.completed',
        category: 'tasks',
        source: 'ui',
        data: null,
        projectId: null,
        timestamp,
      });

      expect(activity.data).toBeUndefined();
      expect(activity.projectId).toBeUndefined();
    });

    it('should persist activity to database', () => {
      const timestamp = Date.now();

      const activity = repo.create({
        type: 'project.created',
        category: 'projects',
        source: 'core',
        timestamp,
      });

      const row = db.prepare('SELECT * FROM activities WHERE id = ?').get(activity.id);
      expect(row).toBeDefined();
      expect((row as any).type).toBe('project.created');
      expect((row as any).category).toBe('projects');
    });

    it('should handle JSON data parsing on creation', () => {
      const timestamp = Date.now();
      const complexData = {
        user: { id: 'user-1', name: 'Test User' },
        action: 'create',
        metadata: { timestamp: '2024-01-01', version: 2 },
      };

      const activity = repo.create({
        type: 'custom.event',
        category: 'custom',
        source: 'plugin',
        data: JSON.stringify(complexData),
        timestamp,
      });

      expect(activity.data).toEqual(complexData);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no activities exist', () => {
      const activities = repo.getAll();
      expect(activities).toEqual([]);
    });

    it('should return all activities', () => {
      const now = Date.now();

      const activity1 = repo.create({
        type: 'event.one',
        category: 'test',
        source: 'core',
        timestamp: now,
      });

      const activity2 = repo.create({
        type: 'event.two',
        category: 'test',
        source: 'core',
        timestamp: now + 1000,
      });

      const activities = repo.getAll();
      expect(activities).toHaveLength(2);
      expect(activities.map(a => a.id)).toContain(activity1.id);
      expect(activities.map(a => a.id)).toContain(activity2.id);
    });

    it('should return activities ordered by timestamp DESC', () => {
      const now = Date.now();

      repo.create({
        type: 'event.first',
        category: 'test',
        source: 'core',
        timestamp: now - 2000,
      });

      repo.create({
        type: 'event.second',
        category: 'test',
        source: 'core',
        timestamp: now - 1000,
      });

      repo.create({
        type: 'event.third',
        category: 'test',
        source: 'core',
        timestamp: now,
      });

      const activities = repo.getAll();
      expect(activities).toHaveLength(3);
      expect(activities[0].type).toBe('event.third');
      expect(activities[1].type).toBe('event.second');
      expect(activities[2].type).toBe('event.first');
    });

    it('should filter by types', () => {
      const now = Date.now();

      repo.create({ type: 'agent.created', category: 'agents', source: 'core', timestamp: now });
      repo.create({ type: 'agent.updated', category: 'agents', source: 'core', timestamp: now });
      repo.create({ type: 'task.created', category: 'tasks', source: 'core', timestamp: now });

      const activities = repo.getAll({ types: ['agent.created', 'agent.updated'] });
      expect(activities).toHaveLength(2);
      expect(activities.every(a => a.type.startsWith('agent.'))).toBe(true);
    });

    it('should filter by categories', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'agents', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'tasks', source: 'core', timestamp: now });
      repo.create({ type: 'event.three', category: 'agents', source: 'core', timestamp: now });

      const activities = repo.getAll({ categories: ['agents'] });
      expect(activities).toHaveLength(2);
      expect(activities.every(a => a.category === 'agents')).toBe(true);
    });

    it('should filter by sources', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'test', source: 'plugin', timestamp: now });
      repo.create({ type: 'event.three', category: 'test', source: 'core', timestamp: now });

      const activities = repo.getAll({ sources: ['core'] });
      expect(activities).toHaveLength(2);
      expect(activities.every(a => a.source === 'core')).toBe(true);
    });

    it('should filter by projectId', () => {
      const now = Date.now();

      // Create projects for foreign key constraint
      const insertProject = db.prepare(
        'INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)'
      );
      insertProject.run('project-1', 'Test Project', 'Description', now);
      insertProject.run('project-2', 'Test Project 2', 'Description', now);

      repo.create({
        type: 'event.one',
        category: 'test',
        source: 'core',
        projectId: 'project-1',
        timestamp: now,
      });

      repo.create({
        type: 'event.two',
        category: 'test',
        source: 'core',
        projectId: 'project-2',
        timestamp: now,
      });

      repo.create({ type: 'event.three', category: 'test', source: 'core', timestamp: now });

      const activities = repo.getAll({ projectId: 'project-1' });
      expect(activities).toHaveLength(1);
      expect(activities[0].projectId).toBe('project-1');
    });

    it('should filter by startTime', () => {
      const now = Date.now();

      repo.create({ type: 'event.old', category: 'test', source: 'core', timestamp: now - 10000 });
      repo.create({ type: 'event.recent', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.newer', category: 'test', source: 'core', timestamp: now + 5000 });

      const activities = repo.getAll({ startTime: now });
      expect(activities).toHaveLength(2);
      expect(activities.every(a => a.timestamp >= now)).toBe(true);
    });

    it('should filter by endTime', () => {
      const now = Date.now();

      repo.create({ type: 'event.old', category: 'test', source: 'core', timestamp: now - 10000 });
      repo.create({ type: 'event.recent', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.future', category: 'test', source: 'core', timestamp: now + 10000 });

      const activities = repo.getAll({ endTime: now });
      expect(activities).toHaveLength(2);
      expect(activities.every(a => a.timestamp <= now)).toBe(true);
    });

    it('should filter by time range', () => {
      const now = Date.now();

      repo.create({ type: 'event.before', category: 'test', source: 'core', timestamp: now - 10000 });
      repo.create({ type: 'event.during', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.after', category: 'test', source: 'core', timestamp: now + 10000 });

      const activities = repo.getAll({ startTime: now - 1000, endTime: now + 1000 });
      expect(activities).toHaveLength(1);
      expect(activities[0].type).toBe('event.during');
    });

    it('should apply limit', () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        repo.create({
          type: `event.${i}`,
          category: 'test',
          source: 'core',
          timestamp: now + i,
        });
      }

      const activities = repo.getAll({ limit: 5 });
      expect(activities).toHaveLength(5);
    });

    it('should apply offset with limit', () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        repo.create({
          type: `event.${i}`,
          category: 'test',
          source: 'core',
          timestamp: now + i,
        });
      }

      // SQLite requires LIMIT when using OFFSET
      const activities = repo.getAll({ limit: 100, offset: 5 });
      expect(activities).toHaveLength(5);
    });

    it('should apply limit and offset together', () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        repo.create({
          type: `event.${i}`,
          category: 'test',
          source: 'core',
          timestamp: now + i,
        });
      }

      const activities = repo.getAll({ limit: 3, offset: 2 });
      expect(activities).toHaveLength(3);
      // Should get items 2, 3, 4 (0-indexed, after ordering by timestamp DESC)
    });

    it('should combine multiple filters', () => {
      const now = Date.now();

      // Create a project
      db.prepare('INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
        'project-1',
        'Test Project',
        'Description',
        now
      );

      repo.create({
        type: 'agent.created',
        category: 'agents',
        source: 'core',
        projectId: 'project-1',
        timestamp: now,
      });

      repo.create({
        type: 'agent.updated',
        category: 'agents',
        source: 'plugin',
        projectId: 'project-1',
        timestamp: now + 1000,
      });

      repo.create({
        type: 'task.created',
        category: 'tasks',
        source: 'core',
        projectId: 'project-1',
        timestamp: now + 2000,
      });

      const activities = repo.getAll({
        categories: ['agents'],
        sources: ['core'],
        projectId: 'project-1',
        startTime: now - 1000,
        endTime: now + 5000,
        limit: 10,
      });

      expect(activities).toHaveLength(1);
      expect(activities[0].type).toBe('agent.created');
    });

    it('should handle empty filter arrays', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'test', source: 'core', timestamp: now });

      const activities = repo.getAll({ types: [], categories: [], sources: [] });
      expect(activities).toHaveLength(2);
    });

    it('should parse JSON data when retrieving activities', () => {
      const now = Date.now();
      const data = { foo: 'bar', nested: { value: 123 } };

      repo.create({
        type: 'event.with.data',
        category: 'test',
        source: 'core',
        data: JSON.stringify(data),
        timestamp: now,
      });

      const activities = repo.getAll();
      expect(activities).toHaveLength(1);
      expect(activities[0].data).toEqual(data);
    });
  });

  describe('getRecentCount', () => {
    it('should return 0 when no activities exist', () => {
      const count = repo.getRecentCount(Date.now());
      expect(count).toBe(0);
    });

    it('should count activities since given timestamp', () => {
      const now = Date.now();

      repo.create({ type: 'event.old', category: 'test', source: 'core', audience: 'user', timestamp: now - 10000 });
      repo.create({ type: 'event.recent1', category: 'test', source: 'core', audience: 'user', timestamp: now });
      repo.create({ type: 'event.recent2', category: 'test', source: 'core', audience: 'user', timestamp: now + 1000 });

      const count = repo.getRecentCount(now);
      expect(count).toBe(2);
    });

    it('should include activities at exact timestamp', () => {
      const now = Date.now();

      repo.create({ type: 'event.exact', category: 'test', source: 'core', audience: 'user', timestamp: now });

      const count = repo.getRecentCount(now);
      expect(count).toBe(1);
    });

    it('should return correct count with multiple recent activities', () => {
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        repo.create({
          type: `event.old.${i}`,
          category: 'test',
          source: 'core',
          audience: 'user',
          timestamp: now - 10000 - i,
        });
      }

      for (let i = 0; i < 7; i++) {
        repo.create({
          type: `event.recent.${i}`,
          category: 'test',
          source: 'core',
          audience: 'user',
          timestamp: now + i,
        });
      }

      const count = repo.getRecentCount(now);
      expect(count).toBe(7);
    });

    it('should not count system-audience activities toward the badge', () => {
      const now = Date.now();

      repo.create({ type: 'app:ready', category: 'system', source: 'core', audience: 'system', timestamp: now });
      repo.create({ type: 'plugin:loaded', category: 'plugin', source: 'core', timestamp: now });
      repo.create({ type: 'message:created', category: 'message', source: 'core', audience: 'user', timestamp: now });

      const count = repo.getRecentCount(now);
      expect(count).toBe(1);
    });
  });

  describe('audience', () => {
    it('should default to system when audience is omitted', () => {
      const activity = repo.create({
        type: 'unknown:event',
        category: 'other',
        source: 'core',
        timestamp: Date.now(),
      });

      expect(activity.audience).toBe('system');
      expect(repo.getById(activity.id)!.audience).toBe('system');
    });

    it('should filter getAll by audience', () => {
      const now = Date.now();

      repo.create({ type: 'app:ready', category: 'system', source: 'core', audience: 'system', timestamp: now });
      repo.create({ type: 'message:created', category: 'message', source: 'core', audience: 'user', timestamp: now });

      const userOnly = repo.getAll({ audience: 'user' });
      expect(userOnly).toHaveLength(1);
      expect(userOnly[0].type).toBe('message:created');

      const all = repo.getAll();
      expect(all).toHaveLength(2);
    });

    it('should scope getCategories by audience', () => {
      const now = Date.now();

      repo.create({ type: 'app:ready', category: 'system', source: 'core', audience: 'system', timestamp: now });
      repo.create({ type: 'message:created', category: 'message', source: 'core', audience: 'user', timestamp: now });

      expect(repo.getCategories('user')).toEqual(['message']);
      expect(repo.getCategories()).toEqual(['message', 'system']);
    });
  });

  describe('getCategories', () => {
    it('should return empty array when no activities exist', () => {
      const categories = repo.getCategories();
      expect(categories).toEqual([]);
    });

    it('should return distinct categories', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'agents', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'tasks', source: 'core', timestamp: now });
      repo.create({ type: 'event.three', category: 'agents', source: 'core', timestamp: now });
      repo.create({ type: 'event.four', category: 'messages', source: 'core', timestamp: now });

      const categories = repo.getCategories();
      expect(categories).toHaveLength(3);
      expect(categories).toContain('agents');
      expect(categories).toContain('tasks');
      expect(categories).toContain('messages');
    });

    it('should return categories in alphabetical order', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'zebra', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'alpha', source: 'core', timestamp: now });
      repo.create({ type: 'event.three', category: 'beta', source: 'core', timestamp: now });

      const categories = repo.getCategories();
      expect(categories).toEqual(['alpha', 'beta', 'zebra']);
    });

    it('should handle single category', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'test', source: 'core', timestamp: now });

      const categories = repo.getCategories();
      expect(categories).toEqual(['test']);
    });
  });

  describe('getById', () => {
    it('should return activity by ID', () => {
      const timestamp = Date.now();

      const created = repo.create({
        type: 'test.event',
        category: 'test',
        source: 'core',
        timestamp,
      });

      const activity = repo.getById(created.id);
      expect(activity).toBeDefined();
      expect(activity!.id).toBe(created.id);
      expect(activity!.type).toBe('test.event');
    });

    it('should return null for non-existent activity', () => {
      const activity = repo.getById('non-existent-id');
      expect(activity).toBeNull();
    });

    it('should return activity with all fields', () => {
      const timestamp = Date.now();
      const data = JSON.stringify({ key: 'value' });

      // Create a project for foreign key constraint
      db.prepare('INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
        'project-1',
        'Test Project',
        'Description',
        timestamp
      );

      const created = repo.create({
        type: 'full.event',
        category: 'test',
        source: 'plugin',
        data,
        projectId: 'project-1',
        timestamp,
      });

      const activity = repo.getById(created.id);
      expect(activity).toBeDefined();
      expect(activity!.type).toBe('full.event');
      expect(activity!.category).toBe('test');
      expect(activity!.source).toBe('plugin');
      expect(activity!.data).toEqual({ key: 'value' });
      expect(activity!.projectId).toBe('project-1');
      expect(activity!.timestamp).toBe(timestamp);
      expect(activity!.createdAt).toBeDefined();
    });

    it('should parse JSON data correctly', () => {
      const timestamp = Date.now();
      const complexData = {
        nested: { deeply: { value: 'test' } },
        array: [1, 2, 3],
        boolean: true,
      };

      const created = repo.create({
        type: 'json.event',
        category: 'test',
        source: 'core',
        data: JSON.stringify(complexData),
        timestamp,
      });

      const activity = repo.getById(created.id);
      expect(activity!.data).toEqual(complexData);
    });
  });

  describe('clear', () => {
    it('should clear all activities', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.three', category: 'test', source: 'core', timestamp: now });

      expect(repo.getAll()).toHaveLength(3);

      repo.clear();

      expect(repo.getAll()).toHaveLength(0);
    });

    it('should handle clearing when no activities exist', () => {
      expect(repo.getAll()).toHaveLength(0);

      // Should not throw
      repo.clear();

      expect(repo.getAll()).toHaveLength(0);
    });

    it('should remove activities from database', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now });

      repo.clear();

      const rows = db.prepare('SELECT * FROM activities').all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('clearBefore', () => {
    it('should clear activities before given timestamp', () => {
      const now = Date.now();

      repo.create({ type: 'event.old1', category: 'test', source: 'core', timestamp: now - 10000 });
      repo.create({ type: 'event.old2', category: 'test', source: 'core', timestamp: now - 5000 });
      repo.create({ type: 'event.recent', category: 'test', source: 'core', timestamp: now });

      const deleted = repo.clearBefore(now);
      expect(deleted).toBe(2);

      const remaining = repo.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].type).toBe('event.recent');
    });

    it('should not clear activities at exact timestamp', () => {
      const now = Date.now();

      repo.create({ type: 'event.exact', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.after', category: 'test', source: 'core', timestamp: now + 1000 });

      const deleted = repo.clearBefore(now);
      expect(deleted).toBe(0);

      expect(repo.getAll()).toHaveLength(2);
    });

    it('should return 0 when no activities to delete', () => {
      const now = Date.now();

      repo.create({ type: 'event.recent', category: 'test', source: 'core', timestamp: now });

      const deleted = repo.clearBefore(now - 10000);
      expect(deleted).toBe(0);

      expect(repo.getAll()).toHaveLength(1);
    });

    it('should delete all activities if timestamp is in future', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now - 10000 });
      repo.create({ type: 'event.two', category: 'test', source: 'core', timestamp: now });

      const deleted = repo.clearBefore(now + 10000);
      expect(deleted).toBe(2);

      expect(repo.getAll()).toHaveLength(0);
    });

    it('should return correct count when deleting multiple activities', () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        repo.create({
          type: `event.${i}`,
          category: 'test',
          source: 'core',
          timestamp: now - (10 - i) * 1000,
        });
      }

      const deleted = repo.clearBefore(now - 5000);
      expect(deleted).toBe(5);

      expect(repo.getAll()).toHaveLength(5);
    });
  });

  describe('getCount', () => {
    it('should return 0 when no activities exist', () => {
      const count = repo.getCount();
      expect(count).toBe(0);
    });

    it('should return total count of activities', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.three', category: 'test', source: 'core', timestamp: now });

      const count = repo.getCount();
      expect(count).toBe(3);
    });

    it('should return correct count after deletions', () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        repo.create({
          type: `event.${i}`,
          category: 'test',
          source: 'core',
          timestamp: now + i,
        });
      }

      expect(repo.getCount()).toBe(10);

      repo.clearBefore(now + 5);

      expect(repo.getCount()).toBe(5);
    });

    it('should return 0 after clearing all activities', () => {
      const now = Date.now();

      repo.create({ type: 'event.one', category: 'test', source: 'core', timestamp: now });
      repo.create({ type: 'event.two', category: 'test', source: 'core', timestamp: now });

      expect(repo.getCount()).toBe(2);

      repo.clear();

      expect(repo.getCount()).toBe(0);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle activities with special characters in type', () => {
      const now = Date.now();

      const activity = repo.create({
        type: "event.with'quotes\"and.special@chars",
        category: 'test',
        source: 'core',
        timestamp: now,
      });

      const retrieved = repo.getById(activity.id);
      expect(retrieved!.type).toBe("event.with'quotes\"and.special@chars");
    });

    it('should handle very long category names', () => {
      const now = Date.now();
      const longCategory = 'a'.repeat(500);

      const activity = repo.create({
        type: 'event.test',
        category: longCategory,
        source: 'core',
        timestamp: now,
      });

      const retrieved = repo.getById(activity.id);
      expect(retrieved!.category).toBe(longCategory);
    });

    it('should handle malformed JSON data gracefully', () => {
      const now = Date.now();

      const activity = repo.create({
        type: 'event.test',
        category: 'test',
        source: 'core',
        data: '{invalid json}',
        timestamp: now,
      });

      const retrieved = repo.getById(activity.id);
      // safeJsonParseOptional should return undefined for invalid JSON
      expect(retrieved!.data).toBeUndefined();
    });

    it('should handle timestamp at epoch', () => {
      const activity = repo.create({
        type: 'event.epoch',
        category: 'test',
        source: 'core',
        timestamp: 0,
      });

      expect(activity.timestamp).toBe(0);

      const retrieved = repo.getById(activity.id);
      expect(retrieved!.timestamp).toBe(0);
    });

    it('should handle very large timestamps', () => {
      const largeTimestamp = 9999999999999;

      const activity = repo.create({
        type: 'event.future',
        category: 'test',
        source: 'core',
        timestamp: largeTimestamp,
      });

      expect(activity.timestamp).toBe(largeTimestamp);
    });

    it('should handle Unicode characters in source', () => {
      const now = Date.now();

      const activity = repo.create({
        type: 'event.test',
        category: 'test',
        source: 'плагин-тест-🚀',
        timestamp: now,
      });

      const retrieved = repo.getById(activity.id);
      expect(retrieved!.source).toBe('плагин-тест-🚀');
    });

    it('should handle data with null values', () => {
      const now = Date.now();
      const dataWithNull = { key: null, nested: { value: null } };

      const activity = repo.create({
        type: 'event.test',
        category: 'test',
        source: 'core',
        data: JSON.stringify(dataWithNull),
        timestamp: now,
      });

      const retrieved = repo.getById(activity.id);
      expect(retrieved!.data).toEqual(dataWithNull);
    });

    it('should handle empty string values', () => {
      const now = Date.now();

      const activity = repo.create({
        type: '',
        category: '',
        source: '',
        timestamp: now,
      });

      const retrieved = repo.getById(activity.id);
      expect(retrieved!.type).toBe('');
      expect(retrieved!.category).toBe('');
      expect(retrieved!.source).toBe('');
    });

    it('should maintain data integrity with many operations', () => {
      const now = Date.now();
      const activities = [];

      // Create many activities
      for (let i = 0; i < 100; i++) {
        activities.push(
          repo.create({
            type: `event.${i}`,
            category: `category-${i % 10}`,
            source: `source-${i % 5}`,
            data: JSON.stringify({ index: i, timestamp: now + i }),
            timestamp: now + i,
          })
        );
      }

      // Verify all were created
      expect(repo.getCount()).toBe(100);

      // Test various filters
      const categoryFilter = repo.getAll({ categories: ['category-1'] });
      expect(categoryFilter.length).toBeGreaterThan(0);

      const sourceFilter = repo.getAll({ sources: ['source-2'] });
      expect(sourceFilter.length).toBeGreaterThan(0);

      const timeFilter = repo.getAll({ startTime: now + 50 });
      expect(timeFilter).toHaveLength(50);

      // Delete half
      const deleted = repo.clearBefore(now + 50);
      expect(deleted).toBe(50);
      expect(repo.getCount()).toBe(50);

      // Clear all
      repo.clear();
      expect(repo.getCount()).toBe(0);
    });

    it('should handle concurrent-like operations', () => {
      const now = Date.now();

      // Simulate rapid creation
      const ids = [];
      for (let i = 0; i < 50; i++) {
        const activity = repo.create({
          type: `event.${i}`,
          category: 'test',
          source: 'core',
          timestamp: now + i,
        });
        ids.push(activity.id);
      }

      // Verify all IDs are unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(50);

      // Verify all can be retrieved
      ids.forEach(id => {
        const activity = repo.getById(id);
        expect(activity).toBeDefined();
        expect(activity!.id).toBe(id);
      });
    });

    it('should handle filtering with overlapping criteria', () => {
      const now = Date.now();

      repo.create({
        type: 'agent.created',
        category: 'agents',
        source: 'core',
        timestamp: now,
      });

      repo.create({
        type: 'agent.updated',
        category: 'agents',
        source: 'core',
        timestamp: now + 1000,
      });

      repo.create({
        type: 'agent.deleted',
        category: 'agents',
        source: 'plugin',
        timestamp: now + 2000,
      });

      // Filter that should match 2 activities
      const activities = repo.getAll({
        types: ['agent.created', 'agent.updated'],
        sources: ['core'],
        categories: ['agents'],
      });

      expect(activities).toHaveLength(2);
      expect(activities[0].type).toBe('agent.updated');
      expect(activities[1].type).toBe('agent.created');
    });

    it('should return activities with undefined optional fields when null in DB', () => {
      const now = Date.now();

      const activity = repo.create({
        type: 'minimal.event',
        category: 'test',
        source: 'core',
        timestamp: now,
      });

      const retrieved = repo.getById(activity.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.data).toBeUndefined();
      expect(retrieved!.projectId).toBeUndefined();
      expect(retrieved!.type).toBe('minimal.event');
    });
  });
});
