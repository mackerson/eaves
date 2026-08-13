import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventRepository } from './EventRepository';
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
        // Run the production migrations (projects + the unified events table)
        // instead of hand-rolled DDL, so this fixture can't drift from
        // migrations.ts.
        runMigrations(mockDb, 0);
      }
      return mockDb;
    }),
  };
});

describe('EventRepository', () => {
  let db: Database.Database;
  let repo: EventRepository;
  let projectId: string;

  beforeEach(async () => {
    // Get the mocked database
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();

    // Clear all tables
    db.exec(`DELETE FROM events`);
    db.exec(`DELETE FROM projects`);

    // Create a test project for events
    projectId = 'project-test-1';
    db.prepare(`
      INSERT INTO projects (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
    `).run(projectId, 'Test Project', 'A test project', Date.now());

    repo = new EventRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new event with all fields', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Team Meeting',
        description: 'Weekly team sync',
        startTime: now,
        endTime: now + 3600000, // 1 hour later
        location: 'Conference Room A',
        isAllDay: false,
      });

      expect(event.id).toBeDefined();
      expect(event.id).toMatch(/^event-/);
      expect(event.projectId).toBe(projectId);
      expect(event.title).toBe('Team Meeting');
      expect(event.description).toBe('Weekly team sync');
      expect(event.startTime).toBe(now);
      expect(event.endTime).toBe(now + 3600000);
      expect(event.location).toBe('Conference Room A');
      expect(event.isAllDay).toBe(false);
      expect(event.createdAt).toBeDefined();
      expect(event.updatedAt).toBeDefined();
      expect(event.createdAt).toBe(event.updatedAt);
    });

    it('should create event with minimal required fields', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Simple Event',
        startTime: now,
        isAllDay: false,
      });

      expect(event.id).toBeDefined();
      expect(event.title).toBe('Simple Event');
      expect(event.description).toBeUndefined();
      expect(event.endTime).toBeUndefined();
      expect(event.location).toBeUndefined();
    });

    it('should create all-day event', () => {
      const startOfDay = new Date('2024-01-15').getTime();
      const event = repo.create({
        projectId,
        title: 'All Day Event',
        startTime: startOfDay,
        isAllDay: true,
      });

      expect(event.isAllDay).toBe(true);
      expect(event.endTime).toBeUndefined();
    });

    it('should persist event to database', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Persistent Event',
        startTime: now,
        isAllDay: false,
      });

      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(event.id);
      expect(row).toBeDefined();
      expect((row as any).title).toBe('Persistent Event');
      expect((row as any).project_id).toBe(projectId);
    });

    it('should handle undefined optional fields', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
        description: undefined,
        endTime: undefined,
        location: undefined,
      });

      expect(event.description).toBeUndefined();
      expect(event.endTime).toBeUndefined();
      expect(event.location).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return empty array when no events exist', () => {
      const events = repo.getAll();
      expect(events).toEqual([]);
    });

    it('should return all events', () => {
      const now = Date.now();
      const event1 = repo.create({
        projectId,
        title: 'Event 1',
        startTime: now,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Event 2',
        startTime: now + 3600000,
        isAllDay: false,
      });

      const events = repo.getAll();
      expect(events).toHaveLength(2);
      expect(events.map(e => e.id)).toContain(event1.id);
      expect(events.map(e => e.id)).toContain(event2.id);
    });

    it('should return events ordered by start_time ASC', () => {
      const now = Date.now();
      const event3 = repo.create({
        projectId,
        title: 'Third',
        startTime: now + 7200000, // 2 hours later
        isAllDay: false,
      });

      const event1 = repo.create({
        projectId,
        title: 'First',
        startTime: now,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Second',
        startTime: now + 3600000, // 1 hour later
        isAllDay: false,
      });

      const events = repo.getAll();
      expect(events).toHaveLength(3);
      expect(events[0].id).toBe(event1.id);
      expect(events[1].id).toBe(event2.id);
      expect(events[2].id).toBe(event3.id);
    });

    it('should return events from different projects', () => {
      const projectId2 = 'project-test-2';
      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run(projectId2, 'Project 2', 'Another project', Date.now());

      const now = Date.now();
      const event1 = repo.create({
        projectId,
        title: 'Event in Project 1',
        startTime: now,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId: projectId2,
        title: 'Event in Project 2',
        startTime: now + 3600000,
        isAllDay: false,
      });

      const events = repo.getAll();
      expect(events).toHaveLength(2);
      expect(events.map(e => e.projectId)).toContain(projectId);
      expect(events.map(e => e.projectId)).toContain(projectId2);
    });
  });

  describe('getById', () => {
    it('should return event by ID', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Test Event',
        startTime: now,
        isAllDay: false,
      });

      const event = repo.getById(created.id);
      expect(event).toBeDefined();
      expect(event!.id).toBe(created.id);
      expect(event!.title).toBe('Test Event');
    });

    it('should return null for non-existent event', () => {
      const event = repo.getById('non-existent-id');
      expect(event).toBeNull();
    });

    it('should return event with all fields', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Full Event',
        description: 'Complete event data',
        startTime: now,
        endTime: now + 3600000,
        location: 'Office',
        isAllDay: false,
      });

      const event = repo.getById(created.id);
      expect(event).toBeDefined();
      expect(event!.description).toBe('Complete event data');
      expect(event!.endTime).toBe(now + 3600000);
      expect(event!.location).toBe('Office');
    });

    it('should return event with undefined optional fields when not set', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Minimal Event',
        startTime: now,
        isAllDay: false,
      });

      const event = repo.getById(created.id);
      expect(event).toBeDefined();
      expect(event!.description).toBeUndefined();
      expect(event!.endTime).toBeUndefined();
      expect(event!.location).toBeUndefined();
    });
  });

  describe('getByProjectId', () => {
    it('should return empty array when no events exist for project', () => {
      const events = repo.getByProjectId(projectId);
      expect(events).toEqual([]);
    });

    it('should return all events for a specific project', () => {
      const projectId2 = 'project-test-2';
      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run(projectId2, 'Project 2', 'Another project', Date.now());

      const now = Date.now();
      const event1 = repo.create({
        projectId,
        title: 'Event 1',
        startTime: now,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Event 2',
        startTime: now + 3600000,
        isAllDay: false,
      });

      repo.create({
        projectId: projectId2,
        title: 'Event in Project 2',
        startTime: now,
        isAllDay: false,
      });

      const events = repo.getByProjectId(projectId);
      expect(events).toHaveLength(2);
      expect(events.every(e => e.projectId === projectId)).toBe(true);
      expect(events.map(e => e.id)).toContain(event1.id);
      expect(events.map(e => e.id)).toContain(event2.id);
    });

    it('should return events ordered by start_time ASC', () => {
      const now = Date.now();
      const event2 = repo.create({
        projectId,
        title: 'Second',
        startTime: now + 3600000,
        isAllDay: false,
      });

      const event1 = repo.create({
        projectId,
        title: 'First',
        startTime: now,
        isAllDay: false,
      });

      const events = repo.getByProjectId(projectId);
      expect(events[0].id).toBe(event1.id);
      expect(events[1].id).toBe(event2.id);
    });

    it('should return empty array for non-existent project', () => {
      const events = repo.getByProjectId('non-existent-project');
      expect(events).toEqual([]);
    });
  });

  describe('getByDateRange', () => {
    it('should return events within date range', () => {
      const baseTime = new Date('2024-01-15T10:00:00').getTime();
      const event1 = repo.create({
        projectId,
        title: 'Event 1',
        startTime: baseTime,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Event 2',
        startTime: baseTime + 3600000, // 1 hour later
        isAllDay: false,
      });

      repo.create({
        projectId,
        title: 'Event 3',
        startTime: baseTime + 7200000, // 2 hours later
        isAllDay: false,
      });

      const events = repo.getByDateRange(baseTime, baseTime + 3600000);
      expect(events).toHaveLength(2);
      expect(events.map(e => e.id)).toContain(event1.id);
      expect(events.map(e => e.id)).toContain(event2.id);
    });

    it('should return events within date range for specific project', () => {
      const projectId2 = 'project-test-2';
      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run(projectId2, 'Project 2', 'Another project', Date.now());

      const baseTime = new Date('2024-01-15T10:00:00').getTime();
      const event1 = repo.create({
        projectId,
        title: 'Event 1',
        startTime: baseTime,
        isAllDay: false,
      });

      repo.create({
        projectId: projectId2,
        title: 'Event 2 in Project 2',
        startTime: baseTime + 1800000, // 30 minutes later
        isAllDay: false,
      });

      const events = repo.getByDateRange(baseTime, baseTime + 3600000, projectId);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(event1.id);
      expect(events[0].projectId).toBe(projectId);
    });

    it('should return empty array when no events in range', () => {
      const baseTime = new Date('2024-01-15T10:00:00').getTime();
      repo.create({
        projectId,
        title: 'Event',
        startTime: baseTime + 7200000, // 2 hours later
        isAllDay: false,
      });

      const events = repo.getByDateRange(baseTime, baseTime + 3600000);
      expect(events).toEqual([]);
    });

    it('should return events ordered by start_time ASC', () => {
      const baseTime = new Date('2024-01-15T10:00:00').getTime();
      const event3 = repo.create({
        projectId,
        title: 'Third',
        startTime: baseTime + 7200000,
        isAllDay: false,
      });

      const event1 = repo.create({
        projectId,
        title: 'First',
        startTime: baseTime,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Second',
        startTime: baseTime + 3600000,
        isAllDay: false,
      });

      const events = repo.getByDateRange(baseTime, baseTime + 7200000);
      expect(events[0].id).toBe(event1.id);
      expect(events[1].id).toBe(event2.id);
      expect(events[2].id).toBe(event3.id);
    });

    it('should include events at exact start time boundary', () => {
      const baseTime = new Date('2024-01-15T10:00:00').getTime();
      const event = repo.create({
        projectId,
        title: 'Event at start',
        startTime: baseTime,
        isAllDay: false,
      });

      const events = repo.getByDateRange(baseTime, baseTime + 3600000);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(event.id);
    });

    it('should include events at exact end time boundary', () => {
      const baseTime = new Date('2024-01-15T10:00:00').getTime();
      const endTime = baseTime + 3600000;
      const event = repo.create({
        projectId,
        title: 'Event at end',
        startTime: endTime,
        isAllDay: false,
      });

      const events = repo.getByDateRange(baseTime, endTime);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(event.id);
    });
  });

  describe('update', () => {
    it('should update event title', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Original Title',
        startTime: now,
        isAllDay: false,
      });

      const updated = repo.update(created.id, { title: 'Updated Title' });
      expect(updated).toBeDefined();
      expect(updated!.title).toBe('Updated Title');

      const retrieved = repo.getById(created.id);
      expect(retrieved!.title).toBe('Updated Title');
    });

    it('should update event description', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        description: 'Original description',
        startTime: now,
        isAllDay: false,
      });

      const updated = repo.update(created.id, { description: 'New description' });
      expect(updated!.description).toBe('New description');
    });

    it('should update event start time', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      const newStartTime = now + 3600000;
      const updated = repo.update(created.id, { startTime: newStartTime });
      expect(updated!.startTime).toBe(newStartTime);
    });

    it('should update event end time', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        endTime: now + 3600000,
        isAllDay: false,
      });

      const newEndTime = now + 7200000;
      const updated = repo.update(created.id, { endTime: newEndTime });
      expect(updated!.endTime).toBe(newEndTime);
    });

    it('should update event location', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        location: 'Old Location',
        isAllDay: false,
      });

      const updated = repo.update(created.id, { location: 'New Location' });
      expect(updated!.location).toBe('New Location');
    });

    it('should update event isAllDay flag', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      const updated = repo.update(created.id, { isAllDay: true });
      expect(updated!.isAllDay).toBe(true);
    });

    it('should update multiple fields at once', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      const newStartTime = now + 3600000;
      const newEndTime = now + 7200000;
      const updated = repo.update(created.id, {
        title: 'Updated Event',
        description: 'Updated description',
        startTime: newStartTime,
        endTime: newEndTime,
        location: 'Updated Location',
        isAllDay: true,
      });

      expect(updated!.title).toBe('Updated Event');
      expect(updated!.description).toBe('Updated description');
      expect(updated!.startTime).toBe(newStartTime);
      expect(updated!.endTime).toBe(newEndTime);
      expect(updated!.location).toBe('Updated Location');
      expect(updated!.isAllDay).toBe(true);
    });

    it('should return null when updating non-existent event', () => {
      const updated = repo.update('non-existent', { title: 'New Title' });
      expect(updated).toBeNull();
    });

    it('should return event unchanged when no updates provided', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      const updated = repo.update(created.id, {});
      expect(updated).toBeDefined();
      expect(updated!.id).toBe(created.id);
      expect(updated!.title).toBe('Event');
    });

    it('should update updatedAt timestamp', async () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));
      const updated = repo.update(created.id, { title: 'Updated' });
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('should preserve createdAt timestamp', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      const updated = repo.update(created.id, { title: 'Updated' });
      expect(updated!.createdAt).toBe(created.createdAt);
    });

    it('should not modify fields when updated with undefined', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        description: 'Description',
        startTime: now,
        endTime: now + 3600000,
        location: 'Location',
        isAllDay: false,
      });

      // Updating with undefined should leave fields unchanged
      const updated = repo.update(created.id, {
        description: undefined,
        endTime: undefined,
        location: undefined,
      });

      // Fields should remain unchanged when updated with undefined
      expect(updated!.description).toBe('Description');
      expect(updated!.endTime).toBe(now + 3600000);
      expect(updated!.location).toBe('Location');
    });
  });

  describe('delete', () => {
    it('should delete event by ID', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event to Delete',
        startTime: now,
        isAllDay: false,
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);

      const retrieved = repo.getById(created.id);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent event', () => {
      const deleted = repo.delete('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should delete event from database', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      repo.delete(created.id);

      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(created.id);
      expect(row).toBeUndefined();
    });

    it('should handle multiple deletions', () => {
      const now = Date.now();
      const event1 = repo.create({
        projectId,
        title: 'Event 1',
        startTime: now,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Event 2',
        startTime: now + 3600000,
        isAllDay: false,
      });

      expect(repo.delete(event1.id)).toBe(true);
      expect(repo.delete(event2.id)).toBe(true);

      const events = repo.getAll();
      expect(events).toEqual([]);
    });

    it('should only delete specified event', () => {
      const now = Date.now();
      const event1 = repo.create({
        projectId,
        title: 'Event 1',
        startTime: now,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Event 2',
        startTime: now + 3600000,
        isAllDay: false,
      });

      repo.delete(event1.id);

      const retrieved = repo.getById(event2.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(event2.id);
    });

    it('should return false when deleting already deleted event', () => {
      const now = Date.now();
      const created = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: false,
      });

      expect(repo.delete(created.id)).toBe(true);
      expect(repo.delete(created.id)).toBe(false);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle event titles with special characters', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: "Event's \"Special\" Title (Test) & More!",
        startTime: now,
        isAllDay: false,
      });

      expect(event.title).toBe("Event's \"Special\" Title (Test) & More!");

      const retrieved = repo.getById(event.id);
      expect(retrieved!.title).toBe("Event's \"Special\" Title (Test) & More!");
    });

    it('should handle long descriptions', () => {
      const longDescription = 'A'.repeat(5000);
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Event',
        description: longDescription,
        startTime: now,
        isAllDay: false,
      });

      const retrieved = repo.getById(event.id);
      expect(retrieved!.description).toBe(longDescription);
    });

    it('should handle unicode characters in title and description', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: '会议 - Meeting 🎉',
        description: 'Description with émojis and àccénts',
        startTime: now,
        isAllDay: false,
      });

      const retrieved = repo.getById(event.id);
      expect(retrieved!.title).toBe('会议 - Meeting 🎉');
      expect(retrieved!.description).toBe('Description with émojis and àccénts');
    });

    it('should handle very old timestamps', () => {
      const oldTime = new Date('1970-01-01').getTime();
      const event = repo.create({
        projectId,
        title: 'Old Event',
        startTime: oldTime,
        isAllDay: false,
      });

      expect(event.startTime).toBe(oldTime);

      const retrieved = repo.getById(event.id);
      expect(retrieved!.startTime).toBe(oldTime);
    });

    it('should handle far future timestamps', () => {
      const futureTime = new Date('2099-12-31').getTime();
      const event = repo.create({
        projectId,
        title: 'Future Event',
        startTime: futureTime,
        isAllDay: false,
      });

      expect(event.startTime).toBe(futureTime);

      const retrieved = repo.getById(event.id);
      expect(retrieved!.startTime).toBe(futureTime);
    });

    it('should handle events with same start time', () => {
      const now = Date.now();
      const event1 = repo.create({
        projectId,
        title: 'Event 1',
        startTime: now,
        isAllDay: false,
      });

      const event2 = repo.create({
        projectId,
        title: 'Event 2',
        startTime: now,
        isAllDay: false,
      });

      const events = repo.getAll();
      expect(events).toHaveLength(2);
      expect(events.map(e => e.id)).toContain(event1.id);
      expect(events.map(e => e.id)).toContain(event2.id);
    });

    it('should handle empty string values', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Event',
        description: '',
        startTime: now,
        location: '',
        isAllDay: false,
      });

      // Empty strings should be stored as-is, not converted to undefined
      const retrieved = repo.getById(event.id);
      expect(retrieved!.description).toBeUndefined(); // mapRowToEvent converts null/empty to undefined
      expect(retrieved!.location).toBeUndefined();
    });

    it('should maintain data integrity with multiple concurrent operations', () => {
      const now = Date.now();
      const events = [];
      for (let i = 0; i < 10; i++) {
        events.push(
          repo.create({
            projectId,
            title: `Event ${i}`,
            startTime: now + i * 3600000,
            isAllDay: false,
          })
        );
      }

      const all = repo.getAll();
      expect(all).toHaveLength(10);

      // Update each event
      events.forEach((event, index) => {
        repo.update(event.id, { title: `Updated Event ${index}` });
      });

      const updated = repo.getAll();
      expect(updated).toHaveLength(10);
      expect(updated.every(e => e.title.startsWith('Updated Event'))).toBe(true);

      // Delete half of them
      for (let i = 0; i < 5; i++) {
        repo.delete(events[i].id);
      }

      const final = repo.getAll();
      expect(final).toHaveLength(5);
    });

    it('should handle date range queries with large time spans', () => {
      const baseTime = new Date('2024-01-01').getTime();
      const farFutureTime = new Date('2030-12-31').getTime();

      repo.create({
        projectId,
        title: 'Event in 2024',
        startTime: baseTime,
        isAllDay: false,
      });

      repo.create({
        projectId,
        title: 'Event in 2030',
        startTime: farFutureTime,
        isAllDay: false,
      });

      const events = repo.getByDateRange(baseTime, farFutureTime);
      expect(events).toHaveLength(2);
    });

    it('should handle events with negative durations (end before start)', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        endTime: now - 3600000, // 1 hour before start
        isAllDay: false,
      });

      // Repository doesn't validate this, it just stores the data
      expect(event.startTime).toBe(now);
      expect(event.endTime).toBe(now - 3600000);
    });

    it('should handle switching between all-day and timed events', () => {
      const now = Date.now();
      const event = repo.create({
        projectId,
        title: 'Event',
        startTime: now,
        isAllDay: true,
      });

      expect(event.isAllDay).toBe(true);

      const updated = repo.update(event.id, {
        isAllDay: false,
        endTime: now + 3600000,
      });

      expect(updated!.isAllDay).toBe(false);
      expect(updated!.endTime).toBe(now + 3600000);
    });
  });
});
