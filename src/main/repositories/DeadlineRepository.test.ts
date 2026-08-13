import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DeadlineRepository } from './DeadlineRepository';
import { DeadlinePriority } from '../types';
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
vi.mock('../services/database', () => ({
  getDatabase: vi.fn(),
}));

describe('DeadlineRepository', () => {
  let db: Database.Database;
  let repo: DeadlineRepository;
  const projectId = 'project-123';

  beforeEach(async () => {
    db = new Database(':memory:');

    // Deadlines are a subtype of the unified `events` table (type = 'deadline'),
    // not their own table. Run the production migrations rather than hand-rolled
    // DDL so this fixture can't drift from migrations.ts.
    runMigrations(db, 0);

    // events.project_id is a real FK against projects(id); seed the parent
    // rows every test in this file references so inserts don't FK-violate.
    const insertProject = db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)`
    );
    for (const id of [projectId, 'p1', 'p2']) {
      insertProject.run(id, id, `Test project ${id}`, Date.now());
    }

    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    repo = new DeadlineRepository();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new deadline with all fields', () => {
      const now = Date.now();
      const deadline = repo.create({
        projectId,
        title: 'Submit Report',
        description: 'Final quarterly report',
        dueDate: now + 86400000,
        priority: 'high',
        isHard: true,
      });

      expect(deadline.id).toMatch(/^deadline-/);
      expect(deadline.projectId).toBe(projectId);
      expect(deadline.title).toBe('Submit Report');
      expect(deadline.description).toBe('Final quarterly report');
      expect(deadline.dueDate).toBe(now + 86400000);
      expect(deadline.priority).toBe('high');
      expect(deadline.isHard).toBe(true);
      expect(deadline.createdAt).toBeDefined();
      expect(deadline.updatedAt).toBeDefined();
    });

    it('should create deadline without optional fields', () => {
      const now = Date.now();
      const deadline = repo.create({
        projectId,
        title: 'Simple Deadline',
        dueDate: now,
        priority: 'medium',
        isHard: false,
      });

      expect(deadline.id).toBeDefined();
      expect(deadline.description).toBeUndefined();
    });

    it('should create deadlines with different priorities', () => {
      const now = Date.now();
      const priorities: DeadlinePriority[] = ['low', 'medium', 'high', 'critical'];

      priorities.forEach((priority, i) => {
        const deadline = repo.create({
          projectId,
          title: `${priority} Priority`,
          dueDate: now + i * 1000,
          priority,
          isHard: false,
        });
        expect(deadline.priority).toBe(priority);
      });
    });
  });

  describe('getById', () => {
    it('should return deadline by id', () => {
      const created = repo.create({
        projectId,
        title: 'Test Deadline',
        dueDate: Date.now(),
        priority: 'medium',
        isHard: false,
      });

      const found = repo.getById(created.id);
      expect(found).toEqual(created);
    });

    it('should return null for non-existent id', () => {
      const found = repo.getById('deadline-nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('getAll', () => {
    it('should return all deadlines ordered by due date', () => {
      const now = Date.now();

      repo.create({ projectId, title: 'Later', dueDate: now + 200000, priority: 'low', isHard: false });
      repo.create({ projectId, title: 'First', dueDate: now, priority: 'high', isHard: true });
      repo.create({ projectId, title: 'Middle', dueDate: now + 100000, priority: 'medium', isHard: false });

      const all = repo.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].title).toBe('First');
      expect(all[1].title).toBe('Middle');
      expect(all[2].title).toBe('Later');
    });

    it('should return empty array when no deadlines', () => {
      const all = repo.getAll();
      expect(all).toEqual([]);
    });
  });

  describe('getByProjectId', () => {
    it('should return deadlines for specific project', () => {
      const now = Date.now();

      repo.create({ projectId: 'p1', title: 'P1 D1', dueDate: now, priority: 'low', isHard: false });
      repo.create({ projectId: 'p2', title: 'P2 D1', dueDate: now, priority: 'low', isHard: false });
      repo.create({ projectId: 'p1', title: 'P1 D2', dueDate: now + 100, priority: 'high', isHard: true });

      const p1Deadlines = repo.getByProjectId('p1');
      expect(p1Deadlines).toHaveLength(2);
      expect(p1Deadlines.every(d => d.projectId === 'p1')).toBe(true);
    });

    it('should return empty array for project with no deadlines', () => {
      const deadlines = repo.getByProjectId('nonexistent-project');
      expect(deadlines).toEqual([]);
    });
  });

  describe('getByPriority', () => {
    it('should filter by priority', () => {
      const now = Date.now();

      repo.create({ projectId, title: 'Low 1', dueDate: now, priority: 'low', isHard: false });
      repo.create({ projectId, title: 'High 1', dueDate: now, priority: 'high', isHard: false });
      repo.create({ projectId, title: 'High 2', dueDate: now + 100, priority: 'high', isHard: true });
      repo.create({ projectId, title: 'Critical', dueDate: now, priority: 'critical', isHard: true });

      const high = repo.getByPriority('high');
      expect(high).toHaveLength(2);
      expect(high.every(d => d.priority === 'high')).toBe(true);
    });

    it('should filter by priority and project', () => {
      const now = Date.now();

      repo.create({ projectId: 'p1', title: 'P1 High', dueDate: now, priority: 'high', isHard: false });
      repo.create({ projectId: 'p2', title: 'P2 High', dueDate: now, priority: 'high', isHard: false });
      repo.create({ projectId: 'p1', title: 'P1 Low', dueDate: now, priority: 'low', isHard: false });

      const p1High = repo.getByPriority('high', 'p1');
      expect(p1High).toHaveLength(1);
      expect(p1High[0].title).toBe('P1 High');
    });
  });

  describe('getByDateRange', () => {
    it('should return deadlines within date range', () => {
      const now = Date.now();

      repo.create({ projectId, title: 'Before', dueDate: now - 200000, priority: 'low', isHard: false });
      repo.create({ projectId, title: 'In Range 1', dueDate: now, priority: 'medium', isHard: false });
      repo.create({ projectId, title: 'In Range 2', dueDate: now + 100000, priority: 'high', isHard: true });
      repo.create({ projectId, title: 'After', dueDate: now + 500000, priority: 'low', isHard: false });

      const inRange = repo.getByDateRange(now - 50000, now + 200000);
      expect(inRange).toHaveLength(2);
      expect(inRange.map(d => d.title)).toContain('In Range 1');
      expect(inRange.map(d => d.title)).toContain('In Range 2');
    });

    it('should filter by project within date range', () => {
      const now = Date.now();

      repo.create({ projectId: 'p1', title: 'P1 In Range', dueDate: now, priority: 'low', isHard: false });
      repo.create({ projectId: 'p2', title: 'P2 In Range', dueDate: now, priority: 'low', isHard: false });

      const p1InRange = repo.getByDateRange(now - 100000, now + 100000, 'p1');
      expect(p1InRange).toHaveLength(1);
      expect(p1InRange[0].projectId).toBe('p1');
    });
  });

  describe('getHardDeadlines', () => {
    it('should return only hard deadlines', () => {
      const now = Date.now();

      repo.create({ projectId, title: 'Soft 1', dueDate: now, priority: 'low', isHard: false });
      repo.create({ projectId, title: 'Hard 1', dueDate: now, priority: 'high', isHard: true });
      repo.create({ projectId, title: 'Hard 2', dueDate: now + 100, priority: 'critical', isHard: true });

      const hard = repo.getHardDeadlines();
      expect(hard).toHaveLength(2);
      expect(hard.every(d => d.isHard)).toBe(true);
    });

    it('should filter hard deadlines by project', () => {
      const now = Date.now();

      repo.create({ projectId: 'p1', title: 'P1 Hard', dueDate: now, priority: 'high', isHard: true });
      repo.create({ projectId: 'p2', title: 'P2 Hard', dueDate: now, priority: 'high', isHard: true });
      repo.create({ projectId: 'p1', title: 'P1 Soft', dueDate: now, priority: 'low', isHard: false });

      const p1Hard = repo.getHardDeadlines('p1');
      expect(p1Hard).toHaveLength(1);
      expect(p1Hard[0].title).toBe('P1 Hard');
    });
  });

  describe('update', () => {
    it('should update deadline fields', () => {
      const created = repo.create({
        projectId,
        title: 'Original Title',
        description: 'Original Desc',
        dueDate: Date.now(),
        priority: 'low',
        isHard: false,
      });

      const updated = repo.update(created.id, {
        title: 'Updated Title',
        description: 'Updated Desc',
        priority: 'critical',
        isHard: true,
      });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Updated Title');
      expect(updated!.description).toBe('Updated Desc');
      expect(updated!.priority).toBe('critical');
      expect(updated!.isHard).toBe(true);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('should return null for non-existent deadline', () => {
      const updated = repo.update('nonexistent', { title: 'New' });
      expect(updated).toBeNull();
    });

    it('should return existing deadline when no updates provided', () => {
      const created = repo.create({
        projectId,
        title: 'Test',
        dueDate: Date.now(),
        priority: 'medium',
        isHard: false,
      });

      const updated = repo.update(created.id, {});
      expect(updated).toEqual(created);
    });

    it('should update due date', () => {
      const originalDate = Date.now();
      const created = repo.create({
        projectId,
        title: 'Test',
        dueDate: originalDate,
        priority: 'medium',
        isHard: false,
      });

      const newDate = originalDate + 86400000;
      const updated = repo.update(created.id, { dueDate: newDate });

      expect(updated!.dueDate).toBe(newDate);
    });

  });

  describe('delete', () => {
    it('should delete existing deadline', () => {
      const created = repo.create({
        projectId,
        title: 'To Delete',
        dueDate: Date.now(),
        priority: 'low',
        isHard: false,
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);
      expect(repo.getById(created.id)).toBeNull();
    });

    it('should return false for non-existent deadline', () => {
      const deleted = repo.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in title', () => {
      const deadline = repo.create({
        projectId,
        title: "Client's Final Review <important>",
        dueDate: Date.now(),
        priority: 'critical',
        isHard: true,
      });

      const found = repo.getById(deadline.id);
      expect(found!.title).toBe("Client's Final Review <important>");
    });

    it('should handle far future dates', () => {
      const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000 * 10; // 10 years
      const deadline = repo.create({
        projectId,
        title: 'Far Future',
        dueDate: farFuture,
        priority: 'low',
        isHard: false,
      });

      expect(deadline.dueDate).toBe(farFuture);
    });

    it('should handle past dates', () => {
      const past = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const deadline = repo.create({
        projectId,
        title: 'Past Deadline',
        dueDate: past,
        priority: 'low',
        isHard: false,
      });

      expect(deadline.dueDate).toBe(past);
    });

    it('should preserve createdAt on update', () => {
      const created = repo.create({
        projectId,
        title: 'Test',
        dueDate: Date.now(),
        priority: 'medium',
        isHard: false,
      });

      const updated = repo.update(created.id, { title: 'Updated' });
      expect(updated!.createdAt).toBe(created.createdAt);
    });

    it('should toggle isHard correctly', () => {
      const created = repo.create({
        projectId,
        title: 'Toggle Test',
        dueDate: Date.now(),
        priority: 'high',
        isHard: false,
      });

      expect(created.isHard).toBe(false);

      const updated1 = repo.update(created.id, { isHard: true });
      expect(updated1!.isHard).toBe(true);

      const updated2 = repo.update(created.id, { isHard: false });
      expect(updated2!.isHard).toBe(false);
    });
  });
});
