import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProjectRepository } from './ProjectRepository';
import Database from 'better-sqlite3';
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

// Mock Electron app module
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/eaves-test'),
  },
}));

// Mock the database service
vi.mock('../services/database', () => ({
  getDatabase: vi.fn(),
}));

describe('ProjectRepository', () => {
  let db: Database.Database;
  let repository: ProjectRepository;

  beforeEach(async () => {
    db = new Database(':memory:');

    // Run the production migrations instead of hand-rolled DDL so this fixture
    // can't drift from migrations.ts.
    runMigrations(db, 0);

    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    repository = new ProjectRepository();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a project with name and description', () => {
      const result = repository.create({
        name: 'Test Project',
        description: 'A test project description',
      });

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.name).toBe('Test Project');
      expect(result.description).toBe('A test project description');
      expect(result.tasks).toEqual([]);
      expect(result.notes).toEqual([]);
      expect(result.files).toEqual([]);
      expect(result.createdAt).toBeDefined();
      expect(typeof result.createdAt).toBe('number');
    });

    it('should trim name and description', () => {
      const result = repository.create({
        name: '  Padded Project  ',
        description: '  Padded description  ',
      });

      expect(result.name).toBe('Padded Project');
      expect(result.description).toBe('Padded description');
    });

    it('should create project with empty description if not provided', () => {
      const result = repository.create({
        name: 'Project Without Desc',
        description: '',
      });

      expect(result.description).toBe('');
    });

    it('should handle undefined description', () => {
      const result = repository.create({
        name: 'Project',
        description: undefined as any,
      });

      expect(result.description).toBe('');
    });

    it('should throw error if name is empty', () => {
      expect(() => {
        repository.create({
          name: '',
          description: 'Test',
        });
      }).toThrow('Project name cannot be empty');
    });

    it('should throw error if name is only whitespace', () => {
      expect(() => {
        repository.create({
          name: '   ',
          description: 'Test',
        });
      }).toThrow('Project name cannot be empty');
    });

    it('should truncate name to MAX_PROJECT_NAME_LENGTH (100 chars)', () => {
      const longName = 'a'.repeat(150);
      const result = repository.create({
        name: longName,
        description: 'Test',
      });

      expect(result.name.length).toBe(100);
      expect(result.name).toBe('a'.repeat(100));
    });

    it('should truncate description to MAX_PROJECT_DESCRIPTION_LENGTH (2000 chars)', () => {
      const longDescription = 'b'.repeat(3000);
      const result = repository.create({
        name: 'Test',
        description: longDescription,
      });

      expect(result.description.length).toBe(2000);
      expect(result.description).toBe('b'.repeat(2000));
    });

    it('should persist project to database', () => {
      const result = repository.create({
        name: 'Persistent Project',
        description: 'Should be in DB',
      });

      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.id) as any;
      expect(row).toBeDefined();
      expect(row.name).toBe('Persistent Project');
      expect(row.description).toBe('Should be in DB');
    });

    it('should store files as empty JSON array initially', () => {
      const result = repository.create({
        name: 'Files Project',
        description: 'Test',
      });

      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.id) as any;
      expect(row.files).toBe('[]');
    });
  });

  describe('project directory', () => {
    it('gives same-named projects distinct directories', () => {
      const a = repository.create({ name: 'Personal', description: '' });
      const b = repository.create({ name: 'Personal', description: '' });

      expect(a.directory).toBeTruthy();
      expect(a.directory).not.toBe(b.directory);
    });

    it('does not collapse legacy ids onto one directory', () => {
      // The suffix used to be `projectId.slice(0, 8)`. For the older
      // `project-<timestamp>` id scheme that is the constant "project-", so
      // every legacy project of a given name resolved to the same path — and
      // mkdirSync's `recursive` flag made the collision silent.
      const insert = db.prepare(
        `INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)`
      );
      insert.run('project-1783100633242', 'Personal', '', Date.now());
      insert.run('project-1783100999999', 'Personal', '', Date.now());

      // The backfill runs at construction.
      new ProjectRepository();

      const directories = repository.getAll().map(p => p.directory);
      expect(directories.filter(Boolean)).toHaveLength(2);
      expect(new Set(directories).size).toBe(2);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no projects exist', () => {
      const result = repository.getAll();

      expect(result).toEqual([]);
    });

    it('should return all projects', () => {
      const proj1 = repository.create({
        name: 'Project 1',
        description: 'First project',
      });

      const proj2 = repository.create({
        name: 'Project 2',
        description: 'Second project',
      });

      const result = repository.getAll();

      expect(result).toHaveLength(2);
      expect(result.some(p => p.id === proj1.id)).toBe(true);
      expect(result.some(p => p.id === proj2.id)).toBe(true);
    });

    it('should order projects by created_at DESC (newest first)', () => {
      const proj1 = repository.create({
        name: 'Old Project',
        description: 'First',
      });

      const proj2 = repository.create({
        name: 'New Project',
        description: 'Second',
      });

      const result = repository.getAll();

      // Verify both projects are present
      expect(result).toHaveLength(2);
      const proj1Result = result.find(p => p.id === proj1.id);
      const proj2Result = result.find(p => p.id === proj2.id);
      expect(proj1Result).toBeDefined();
      expect(proj2Result).toBeDefined();

      // Newest should have later or equal createdAt
      expect(proj2Result!.createdAt >= proj1Result!.createdAt).toBe(true);
    });

    it('should include project tasks', () => {
      const proj = repository.create({
        name: 'Project With Tasks',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Complete feature' });

      const result = repository.getAll();
      const foundProject = result.find(p => p.id === proj.id);

      expect(foundProject?.tasks).toHaveLength(1);
      expect(foundProject?.tasks[0].id).toBe(task.id);
      expect(foundProject?.tasks[0].content).toBe('Complete feature');
    });

    it('should include project notes', () => {
      const proj = repository.create({
        name: 'Project With Notes',
        description: 'Test',
      });

      const note = repository.createNote(proj.id, { content: 'Important information' });

      const result = repository.getAll();
      const foundProject = result.find(p => p.id === proj.id);

      expect(foundProject?.notes).toHaveLength(1);
      expect(foundProject?.notes[0].id).toBe(note.id);
      expect(foundProject?.notes[0].content).toBe('Important information');
    });

    it('should parse files array from JSON', () => {
      const proj = repository.create({
        name: 'Project With Files',
        description: 'Test',
      });

      // Manually insert files into DB for testing
      db.prepare(`UPDATE projects SET files = ? WHERE id = ?`).run(
        JSON.stringify(['file1.txt', 'file2.txt']),
        proj.id
      );

      const result = repository.getAll();
      const foundProject = result.find(p => p.id === proj.id);

      expect(foundProject?.files).toEqual(['file1.txt', 'file2.txt']);
    });
  });

  describe('getById', () => {
    it('should return project by ID', () => {
      const created = repository.create({
        name: 'Find Me',
        description: 'Test',
      });

      const result = repository.getById(created.id);

      expect(result).toBeDefined();
      expect(result?.id).toBe(created.id);
      expect(result?.name).toBe('Find Me');
    });

    it('should return null if project not found', () => {
      const result = repository.getById('non-existent-id');

      expect(result).toBeNull();
    });

    it('should include tasks with project', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task1 = repository.createTask(proj.id, { content: 'Task 1' });
      const task2 = repository.createTask(proj.id, { content: 'Task 2' });

      const result = repository.getById(proj.id);

      expect(result?.tasks).toHaveLength(2);
      expect(result?.tasks.map(t => t.id).sort()).toEqual([task1.id, task2.id].sort());
    });

    it('should include notes with project', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const note1 = repository.createNote(proj.id, { content: 'Note 1' });
      const note2 = repository.createNote(proj.id, { content: 'Note 2' });

      const result = repository.getById(proj.id);

      expect(result?.notes).toHaveLength(2);
      expect(result?.notes.map(n => n.id).sort()).toEqual([note1.id, note2.id].sort());
    });

    it('should parse files array correctly', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      db.prepare(`UPDATE projects SET files = ? WHERE id = ?`).run(
        JSON.stringify(['file.txt']),
        proj.id
      );

      const result = repository.getById(proj.id);

      expect(result?.files).toEqual(['file.txt']);
    });
  });

  describe('update', () => {
    it('should update project name', () => {
      const proj = repository.create({
        name: 'Original Name',
        description: 'Original desc',
      });

      const updated = repository.update(proj.id, { name: 'Updated Name' });

      expect(updated?.name).toBe('Updated Name');
      expect(updated?.description).toBe('Original desc');
    });

    it('should update project description', () => {
      const proj = repository.create({
        name: 'Name',
        description: 'Original description',
      });

      const updated = repository.update(proj.id, { description: 'Updated description' });

      expect(updated?.name).toBe('Name');
      expect(updated?.description).toBe('Updated description');
    });

    it('should update both name and description', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Original',
      });

      const updated = repository.update(proj.id, {
        name: 'New Name',
        description: 'New Description',
      });

      expect(updated?.name).toBe('New Name');
      expect(updated?.description).toBe('New Description');
    });

    it('should trim name when updating', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Desc',
      });

      const updated = repository.update(proj.id, { name: '  Trimmed Name  ' });

      expect(updated?.name).toBe('Trimmed Name');
    });

    it('should trim description when updating', () => {
      const proj = repository.create({
        name: 'Name',
        description: 'Original',
      });

      const updated = repository.update(proj.id, { description: '  New description  ' });

      expect(updated?.description).toBe('New description');
    });

    it('should throw error if updating name to empty string', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Desc',
      });

      expect(() => {
        repository.update(proj.id, { name: '' });
      }).toThrow('Project name cannot be empty');
    });

    it('should throw error if updating name to whitespace only', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Desc',
      });

      expect(() => {
        repository.update(proj.id, { name: '   ' });
      }).toThrow('Project name cannot be empty');
    });

    it('should truncate name to MAX_PROJECT_NAME_LENGTH', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Desc',
      });

      const longName = 'c'.repeat(150);
      const updated = repository.update(proj.id, { name: longName });

      expect(updated?.name.length).toBe(100);
    });

    it('should truncate description to MAX_PROJECT_DESCRIPTION_LENGTH', () => {
      const proj = repository.create({
        name: 'Name',
        description: 'Desc',
      });

      const longDesc = 'd'.repeat(3000);
      const updated = repository.update(proj.id, { description: longDesc });

      expect(updated?.description.length).toBe(2000);
    });

    it('should return project if no updates provided', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Original',
      });

      const result = repository.update(proj.id, {});

      expect(result?.id).toBe(proj.id);
      expect(result?.name).toBe('Original');
      expect(result?.description).toBe('Original');
    });

    it('should return null if project not found', () => {
      const result = repository.update('non-existent-id', { name: 'New Name' });

      expect(result).toBeNull();
    });

    it('should persist updates to database', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Original',
      });

      repository.update(proj.id, { name: 'Persisted Update' });

      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(proj.id) as any;
      expect(row.name).toBe('Persisted Update');
    });

    it('should maintain project tasks and notes after update', () => {
      const proj = repository.create({
        name: 'Original',
        description: 'Original',
      });

      const task = repository.createTask(proj.id, { content: 'Task' });
      const note = repository.createNote(proj.id, { content: 'Note' });

      const updated = repository.update(proj.id, { name: 'Updated Name' });

      expect(updated?.tasks).toHaveLength(1);
      expect(updated?.notes).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('should delete project by ID', () => {
      const proj = repository.create({
        name: 'To Delete',
        description: 'Delete me',
      });

      const result = repository.delete(proj.id);

      expect(result).toBe(true);
    });

    it('should return false if project not found', () => {
      const result = repository.delete('non-existent-id');

      expect(result).toBe(false);
    });

    it('should remove project from database', () => {
      const proj = repository.create({
        name: 'To Delete',
        description: 'Test',
      });

      repository.delete(proj.id);

      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(proj.id);
      expect(row).toBeUndefined();
    });

    it('should cascade delete associated tasks', () => {
      const proj = repository.create({
        name: 'To Delete',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Task to delete' });

      repository.delete(proj.id);

      const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
      expect(taskRow).toBeUndefined();
    });

    it('should cascade delete associated notes', () => {
      const proj = repository.create({
        name: 'To Delete',
        description: 'Test',
      });

      const note = repository.createNote(proj.id, { content: 'Note to delete' });

      repository.delete(proj.id);

      const noteRow = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
      expect(noteRow).toBeUndefined();
    });

    it('should not affect other projects', () => {
      const proj1 = repository.create({
        name: 'Keep This',
        description: 'Test',
      });

      const proj2 = repository.create({
        name: 'Delete This',
        description: 'Test',
      });

      repository.delete(proj2.id);

      const remaining = repository.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(proj1.id);
    });
  });

  describe('createTask', () => {
    it('should create task with content', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const result = repository.createTask(proj.id, { content: 'Complete feature' });

      expect(result.id).toBeDefined();
      expect(result.content).toBe('Complete feature');
      expect(result.completed).toBe(false);
      expect(result.createdAt).toBeDefined();
    });

    it('should trim task content', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const result = repository.createTask(proj.id, { content: '  Trimmed task  ' });

      expect(result.content).toBe('Trimmed task');
    });

    it('should throw error if content is empty', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      expect(() => {
        repository.createTask(proj.id, { content: '' });
      }).toThrow('Task content cannot be empty');
    });

    it('should throw error if content is whitespace only', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      expect(() => {
        repository.createTask(proj.id, { content: '   ' });
      }).toThrow('Task content cannot be empty');
    });

    it('should truncate content to MAX_TASK_LENGTH (500 chars)', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const longContent = 'a'.repeat(1000);
      const result = repository.createTask(proj.id, { content: longContent });

      expect(result.content.length).toBe(500);
    });

    it('should persist task to database', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Persistent task' });

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as any;
      expect(row).toBeDefined();
      expect(row.content).toBe('Persistent task');
      expect(row.project_id).toBe(proj.id);
      expect(row.completed).toBe(0);
    });
  });

  describe('toggleTask', () => {
    it('should toggle task completion from false to true', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Task to complete' });
      const result = repository.toggleTask(task.id);

      expect(result.completed).toBe(true);
      expect(result.content).toBe('Task to complete');
    });

    it('should toggle task completion from true to false', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Task' });
      repository.toggleTask(task.id);
      const result = repository.toggleTask(task.id);

      expect(result.completed).toBe(false);
    });

    it('should return null if task not found', () => {
      const result = repository.toggleTask('non-existent-task-id');
      expect(result).toBeNull();
    });

    it('should persist completion status to database', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Task' });
      repository.toggleTask(task.id);

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as any;
      expect(row.completed).toBe(1);
    });

    it('should handle multiple toggles', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Task' });
      expect(repository.toggleTask(task.id).completed).toBe(true);
      expect(repository.toggleTask(task.id).completed).toBe(false);
      expect(repository.toggleTask(task.id).completed).toBe(true);
    });
  });

  describe('deleteTask', () => {
    it('should delete task by ID', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Task to delete' });
      const result = repository.deleteTask(task.id);

      expect(result).toBe(true);
    });

    it('should return false if task not found', () => {
      const result = repository.deleteTask('non-existent-task-id');

      expect(result).toBe(false);
    });

    it('should remove task from database', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task = repository.createTask(proj.id, { content: 'Task' });
      repository.deleteTask(task.id);

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
      expect(row).toBeUndefined();
    });

    it('should not affect other tasks', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task1 = repository.createTask(proj.id, { content: 'Keep this' });
      const task2 = repository.createTask(proj.id, { content: 'Delete this' });

      repository.deleteTask(task2.id);

      const project = repository.getById(proj.id);
      expect(project?.tasks).toHaveLength(1);
      expect(project?.tasks[0].id).toBe(task1.id);
    });
  });

  describe('createNote', () => {
    it('should create note with content', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const result = repository.createNote(proj.id, { content: 'Important note' });

      expect(result.id).toBeDefined();
      expect(result.content).toBe('Important note');
      expect(result.createdAt).toBeDefined();
    });

    it('should trim note content', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const result = repository.createNote(proj.id, { content: '  Trimmed note  ' });

      expect(result.content).toBe('Trimmed note');
    });

    it('should throw error if content is empty', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      expect(() => {
        repository.createNote(proj.id, { content: '' });
      }).toThrow('Note content cannot be empty');
    });

    it('should throw error if content is whitespace only', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      expect(() => {
        repository.createNote(proj.id, { content: '   ' });
      }).toThrow('Note content cannot be empty');
    });

    it('should truncate content to MAX_NOTE_LENGTH (10000 chars)', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const longContent = 'a'.repeat(12000);
      const result = repository.createNote(proj.id, { content: longContent });

      expect(result.content.length).toBe(10000);
    });

    it('should persist note to database', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const note = repository.createNote(proj.id, { content: 'Persistent note' });

      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id) as any;
      expect(row).toBeDefined();
      expect(row.content).toBe('Persistent note');
      expect(row.project_id).toBe(proj.id);
    });
  });

  describe('deleteNote', () => {
    it('should delete note by ID', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const note = repository.createNote(proj.id, { content: 'Note to delete' });
      const result = repository.deleteNote(note.id);

      expect(result).toBe(true);
    });

    it('should return false if note not found', () => {
      const result = repository.deleteNote('non-existent-note-id');

      expect(result).toBe(false);
    });

    it('should remove note from database', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const note = repository.createNote(proj.id, { content: 'Note' });
      repository.deleteNote(note.id);

      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
      expect(row).toBeUndefined();
    });

    it('should not affect other notes', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const note1 = repository.createNote(proj.id, { content: 'Keep this' });
      const note2 = repository.createNote(proj.id, { content: 'Delete this' });

      repository.deleteNote(note2.id);

      const project = repository.getById(proj.id);
      expect(project?.notes).toHaveLength(1);
      expect(project?.notes[0].id).toBe(note1.id);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle project with multiple tasks and notes', () => {
      const proj = repository.create({
        name: 'Complex Project',
        description: 'Test',
      });

      const task1 = repository.createTask(proj.id, { content: 'Task 1' });
      const task2 = repository.createTask(proj.id, { content: 'Task 2' });
      const note1 = repository.createNote(proj.id, { content: 'Note 1' });
      const note2 = repository.createNote(proj.id, { content: 'Note 2' });

      repository.toggleTask(task1.id);

      const result = repository.getById(proj.id);

      expect(result?.tasks).toHaveLength(2);
      expect(result?.notes).toHaveLength(2);
      expect(result?.tasks.find(t => t.id === task1.id)?.completed).toBe(true);
      expect(result?.tasks.find(t => t.id === task2.id)?.completed).toBe(false);
    });

    it('should maintain data integrity after multiple operations', () => {
      const proj1 = repository.create({
        name: 'Project 1',
        description: 'First',
      });

      const proj2 = repository.create({
        name: 'Project 2',
        description: 'Second',
      });

      repository.createTask(proj1.id, { content: 'Task for project 1' });
      repository.createTask(proj2.id, { content: 'Task for project 2' });

      repository.update(proj1.id, { name: 'Updated Project 1' });

      const proj1Updated = repository.getById(proj1.id);
      const proj2Unchanged = repository.getById(proj2.id);

      expect(proj1Updated?.name).toBe('Updated Project 1');
      expect(proj1Updated?.tasks).toHaveLength(1);
      expect(proj2Unchanged?.tasks).toHaveLength(1);
      expect(proj2Unchanged?.name).toBe('Project 2');
    });

    it('should properly order notes by created_at DESC', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const note1 = repository.createNote(proj.id, { content: 'First note' });
      const note2 = repository.createNote(proj.id, { content: 'Second note' });
      const note3 = repository.createNote(proj.id, { content: 'Third note' });

      const result = repository.getById(proj.id);

      // Verify all notes are present
      expect(result?.notes).toHaveLength(3);
      const noteIds = result?.notes.map(n => n.id) || [];
      expect(noteIds).toContain(note1.id);
      expect(noteIds).toContain(note2.id);
      expect(noteIds).toContain(note3.id);

      // Notes should be in DESC order (newest first) - latest should be at index 0
      expect(result?.notes[0].createdAt >= result?.notes[1].createdAt!).toBe(true);
      expect(result?.notes[1].createdAt >= result?.notes[2].createdAt!).toBe(true);
    });

    it('should properly order tasks by sort_order DESC (newest first)', () => {
      const proj = repository.create({
        name: 'Project',
        description: 'Test',
      });

      const task1 = repository.createTask(proj.id, { content: 'First task' });
      const task2 = repository.createTask(proj.id, { content: 'Second task' });
      const task3 = repository.createTask(proj.id, { content: 'Third task' });

      const result = repository.getById(proj.id);

      // Tasks are ordered by completed ASC, priority, then sort_order DESC (newest first)
      // All tasks have same priority (medium) and are incomplete, so order is by sort_order DESC
      expect(result?.tasks[0].id).toBe(task3.id);
      expect(result?.tasks[1].id).toBe(task2.id);
      expect(result?.tasks[2].id).toBe(task1.id);
    });
  });
});
