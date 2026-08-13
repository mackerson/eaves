import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MilestoneRepository } from './MilestoneRepository';
import { runMigrations } from '../services/migrations';

// Mock the logger
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
        // Milestones are a subtype of the unified `events` table
        // (type = 'milestone'), not their own table. Run the production
        // migrations instead of hand-rolled DDL so this fixture can't drift
        // from migrations.ts.
        runMigrations(mockDb, 0);
      }
      return mockDb;
    }),
  };
});

describe('MilestoneRepository', () => {
  let db: Database.Database;
  let repo: MilestoneRepository;
  const projectId = 'project-123';

  beforeEach(async () => {
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();
    db.exec(`DELETE FROM events`);

    // events.project_id is a real FK against projects(id); seed the parent
    // rows every test in this file references so inserts don't 23505.
    const insertProject = db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)`
    );
    for (const id of [projectId, 'project-1', 'project-2', 'p1', 'p2']) {
      insertProject.run(id, id, `Test project ${id}`, Date.now());
    }

    repo = new MilestoneRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new milestone with all fields', () => {
      const now = Date.now();
      const milestone = repo.create({
        projectId,
        title: 'Q1 Launch',
        description: 'Launch version 1.0',
        targetDate: now + 86400000,
        status: 'upcoming',
      });

      expect(milestone.id).toMatch(/^milestone-/);
      expect(milestone.projectId).toBe(projectId);
      expect(milestone.title).toBe('Q1 Launch');
      expect(milestone.description).toBe('Launch version 1.0');
      expect(milestone.targetDate).toBe(now + 86400000);
      expect(milestone.status).toBe('upcoming');
      expect(milestone.createdAt).toBeDefined();
      expect(milestone.updatedAt).toBeDefined();
    });

    it('should create milestone without optional fields', () => {
      const now = Date.now();
      const milestone = repo.create({
        projectId,
        title: 'Simple Milestone',
        targetDate: now,
        status: 'upcoming',
      });

      expect(milestone.id).toBeDefined();
      expect(milestone.description).toBeUndefined();
    });

    it('should create milestones with different statuses', () => {
      const now = Date.now();

      const upcoming = repo.create({
        projectId,
        title: 'Upcoming',
        targetDate: now + 86400000,
        status: 'upcoming',
      });

      const achieved = repo.create({
        projectId,
        title: 'Achieved',
        targetDate: now - 86400000,
        status: 'achieved',
      });

      const missed = repo.create({
        projectId,
        title: 'Missed',
        targetDate: now - 86400000,
        status: 'missed',
      });

      expect(upcoming.status).toBe('upcoming');
      expect(achieved.status).toBe('achieved');
      expect(missed.status).toBe('missed');
    });
  });

  describe('getById', () => {
    it('should return milestone by id', () => {
      const created = repo.create({
        projectId,
        title: 'Test Milestone',
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const found = repo.getById(created.id);
      expect(found).toEqual(created);
    });

    it('should return null for non-existent id', () => {
      const found = repo.getById('milestone-nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('getAll', () => {
    it('should return all milestones ordered by target date', () => {
      const now = Date.now();

      repo.create({ projectId, title: 'Later', targetDate: now + 200000, status: 'upcoming' });
      repo.create({ projectId, title: 'First', targetDate: now, status: 'upcoming' });
      repo.create({ projectId, title: 'Middle', targetDate: now + 100000, status: 'upcoming' });

      const all = repo.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].title).toBe('First');
      expect(all[1].title).toBe('Middle');
      expect(all[2].title).toBe('Later');
    });

    it('should return empty array when no milestones', () => {
      const all = repo.getAll();
      expect(all).toEqual([]);
    });
  });

  describe('getByProjectId', () => {
    it('should return milestones for specific project', () => {
      const now = Date.now();

      repo.create({ projectId: 'project-1', title: 'P1 M1', targetDate: now, status: 'upcoming' });
      repo.create({ projectId: 'project-2', title: 'P2 M1', targetDate: now, status: 'upcoming' });
      repo.create({ projectId: 'project-1', title: 'P1 M2', targetDate: now + 100, status: 'upcoming' });

      const p1Milestones = repo.getByProjectId('project-1');
      expect(p1Milestones).toHaveLength(2);
      expect(p1Milestones.every(m => m.projectId === 'project-1')).toBe(true);
    });

    it('should return empty array for project with no milestones', () => {
      const milestones = repo.getByProjectId('nonexistent-project');
      expect(milestones).toEqual([]);
    });
  });

  describe('getByStatus', () => {
    it('should filter by status', () => {
      const now = Date.now();

      repo.create({ projectId, title: 'Upcoming 1', targetDate: now + 100000, status: 'upcoming' });
      repo.create({ projectId, title: 'Achieved 1', targetDate: now - 100000, status: 'achieved' });
      repo.create({ projectId, title: 'Missed 1', targetDate: now - 100000, status: 'missed' });
      repo.create({ projectId, title: 'Upcoming 2', targetDate: now + 200000, status: 'upcoming' });

      const upcoming = repo.getByStatus('upcoming');
      expect(upcoming).toHaveLength(2);
      expect(upcoming.every(m => m.status === 'upcoming')).toBe(true);

      const achieved = repo.getByStatus('achieved');
      expect(achieved).toHaveLength(1);
      expect(achieved[0].status).toBe('achieved');
    });

    it('should filter by status and project', () => {
      const now = Date.now();

      repo.create({ projectId: 'p1', title: 'P1 Upcoming', targetDate: now, status: 'upcoming' });
      repo.create({ projectId: 'p2', title: 'P2 Upcoming', targetDate: now, status: 'upcoming' });
      repo.create({ projectId: 'p1', title: 'P1 Achieved', targetDate: now, status: 'achieved' });

      const p1Upcoming = repo.getByStatus('upcoming', 'p1');
      expect(p1Upcoming).toHaveLength(1);
      expect(p1Upcoming[0].title).toBe('P1 Upcoming');
    });
  });

  describe('getByDateRange', () => {
    it('should return milestones within date range', () => {
      const now = Date.now();

      repo.create({ projectId, title: 'Before', targetDate: now - 200000, status: 'achieved' });
      repo.create({ projectId, title: 'In Range 1', targetDate: now, status: 'upcoming' });
      repo.create({ projectId, title: 'In Range 2', targetDate: now + 100000, status: 'upcoming' });
      repo.create({ projectId, title: 'After', targetDate: now + 500000, status: 'upcoming' });

      const inRange = repo.getByDateRange(now - 50000, now + 200000);
      expect(inRange).toHaveLength(2);
      expect(inRange.map(m => m.title)).toContain('In Range 1');
      expect(inRange.map(m => m.title)).toContain('In Range 2');
    });

    it('should filter by project within date range', () => {
      const now = Date.now();

      repo.create({ projectId: 'p1', title: 'P1 In Range', targetDate: now, status: 'upcoming' });
      repo.create({ projectId: 'p2', title: 'P2 In Range', targetDate: now, status: 'upcoming' });

      const p1InRange = repo.getByDateRange(now - 100000, now + 100000, 'p1');
      expect(p1InRange).toHaveLength(1);
      expect(p1InRange[0].projectId).toBe('p1');
    });
  });

  describe('update', () => {
    it('should update milestone fields', () => {
      const created = repo.create({
        projectId,
        title: 'Original Title',
        description: 'Original Desc',
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const updated = repo.update(created.id, {
        title: 'Updated Title',
        description: 'Updated Desc',
        status: 'achieved',
      });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Updated Title');
      expect(updated!.description).toBe('Updated Desc');
      expect(updated!.status).toBe('achieved');
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('should return null for non-existent milestone', () => {
      const updated = repo.update('nonexistent', { title: 'New' });
      expect(updated).toBeNull();
    });

    it('should return existing milestone when no updates provided', () => {
      const created = repo.create({
        projectId,
        title: 'Test',
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const updated = repo.update(created.id, {});
      expect(updated).toEqual(created);
    });

    it('should update target date', () => {
      const originalDate = Date.now();
      const created = repo.create({
        projectId,
        title: 'Test',
        targetDate: originalDate,
        status: 'upcoming',
      });

      const newDate = originalDate + 86400000;
      const updated = repo.update(created.id, { targetDate: newDate });

      expect(updated!.targetDate).toBe(newDate);
    });

    it('should clear description when set to empty string', () => {
      const created = repo.create({
        projectId,
        title: 'Test',
        description: 'Has description',
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const updated = repo.update(created.id, { description: '' });
      expect(updated!.description).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should delete existing milestone', () => {
      const created = repo.create({
        projectId,
        title: 'To Delete',
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);
      expect(repo.getById(created.id)).toBeNull();
    });

    it('should return false for non-existent milestone', () => {
      const deleted = repo.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in title', () => {
      const milestone = repo.create({
        projectId,
        title: "Test's Milestone <script>alert('xss')</script>",
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const found = repo.getById(milestone.id);
      expect(found!.title).toBe("Test's Milestone <script>alert('xss')</script>");
    });

    it('should handle unicode in description', () => {
      const milestone = repo.create({
        projectId,
        title: 'Unicode Test',
        description: 'Emoji milestone! <br> And more.',
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const found = repo.getById(milestone.id);
      expect(found!.description).toContain('milestone');
    });

    it('should handle far future dates', () => {
      const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000 * 100; // 100 years
      const milestone = repo.create({
        projectId,
        title: 'Far Future',
        targetDate: farFuture,
        status: 'upcoming',
      });

      expect(milestone.targetDate).toBe(farFuture);
    });

    it('should handle past dates', () => {
      const past = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const milestone = repo.create({
        projectId,
        title: 'Past Milestone',
        targetDate: past,
        status: 'missed',
      });

      expect(milestone.targetDate).toBe(past);
    });

    it('should preserve createdAt on update', () => {
      const created = repo.create({
        projectId,
        title: 'Test',
        targetDate: Date.now(),
        status: 'upcoming',
      });

      const updated = repo.update(created.id, { title: 'Updated' });
      expect(updated!.createdAt).toBe(created.createdAt);
    });
  });
});
