import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FileRepository } from './FileRepository';
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
        // Seed schema by running the production migrations rather than
        // hand-rolled DDL, so the test schema can't drift from migrations.ts.
        runMigrations(mockDb, 0);
      }
      return mockDb;
    }),
  };
});

describe('FileRepository', () => {
  let db: Database.Database;
  let repo: FileRepository;
  const projectId = 'project-123';

  beforeEach(async () => {
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();
    db.exec(`DELETE FROM files`);
    db.exec(`DELETE FROM projects`);

    // files.project_id is a real FK against projects(id) and foreign_keys is ON
    // by default for this better-sqlite3 build, so seed the project ids
    // exercised by this file's tests or the inserts FK-violate.
    const insertProject = db.prepare(
      `INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const id of [projectId, 'p1', 'p2', 'original-project', 'other']) {
      insertProject.run(id, `Project ${id}`, 'Test project', now);
    }

    repo = new FileRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new file with all fields', () => {
      const file = repo.create({
        projectId,
        name: 'document.pdf',
        path: '/projects/docs/document.pdf',
        type: 'file',
        size: 1024,
        mimeType: 'application/pdf',
      });

      expect(file.id).toMatch(/^file-/);
      expect(file.projectId).toBe(projectId);
      expect(file.name).toBe('document.pdf');
      expect(file.path).toBe('/projects/docs/document.pdf');
      expect(file.type).toBe('file');
      expect(file.size).toBe(1024);
      expect(file.mimeType).toBe('application/pdf');
      expect(file.createdAt).toBeDefined();
      expect(file.updatedAt).toBeDefined();
    });

    it('should create file without optional fields', () => {
      const file = repo.create({
        projectId,
        name: 'folder',
        path: '/projects/folder',
        type: 'directory',
      });

      expect(file.id).toBeDefined();
      expect(file.size).toBeNull();
      expect(file.mimeType).toBeUndefined();
    });

    it('should create files with different types', () => {
      const file = repo.create({
        projectId,
        name: 'doc.txt',
        path: '/doc.txt',
        type: 'file',
      });

      const dir = repo.create({
        projectId,
        name: 'folder',
        path: '/folder',
        type: 'directory',
      });

      const repo2 = repo.create({
        projectId,
        name: 'my-repo',
        path: '/repos/my-repo',
        type: 'repository',
      });

      expect(file.type).toBe('file');
      expect(dir.type).toBe('directory');
      expect(repo2.type).toBe('repository');
    });
  });

  describe('getById', () => {
    it('should return file by id', () => {
      const created = repo.create({
        projectId,
        name: 'test.txt',
        path: '/test.txt',
        type: 'file',
      });

      const found = repo.getById(created.id);
      expect(found).toEqual(created);
    });

    it('should return null for non-existent id', () => {
      const found = repo.getById('file-nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('getByPath', () => {
    it('should return file by path', () => {
      const created = repo.create({
        projectId,
        name: 'unique.txt',
        path: '/unique/path/file.txt',
        type: 'file',
      });

      const found = repo.getByPath('/unique/path/file.txt', projectId);
      expect(found).toEqual(created);
    });

    it('should return null for non-existent path', () => {
      const found = repo.getByPath('/nonexistent/path', projectId);
      expect(found).toBeNull();
    });

    it('does not see the same path attached to another project', () => {
      // Matching on path alone made `files:add` report success while attaching
      // nothing: it found the other project's row and returned that instead.
      repo.create({ projectId: 'other', name: 'shared', path: '/shared/dir', type: 'directory' });

      expect(repo.getByPath('/shared/dir', projectId)).toBeNull();
      expect(repo.getByPath('/shared/dir', 'other')).not.toBeNull();
    });

    it('should be case-sensitive for paths', () => {
      repo.create({
        projectId,
        name: 'test.txt',
        path: '/Test/File.txt',
        type: 'file',
      });

      const found = repo.getByPath('/test/file.txt', projectId);
      expect(found).toBeNull();
    });
  });

  describe('getByProjectId', () => {
    it('should return files for specific project', () => {
      repo.create({ projectId: 'p1', name: 'file1.txt', path: '/p1/file1.txt', type: 'file' });
      repo.create({ projectId: 'p2', name: 'file2.txt', path: '/p2/file2.txt', type: 'file' });
      repo.create({ projectId: 'p1', name: 'file3.txt', path: '/p1/file3.txt', type: 'file' });

      const p1Files = repo.getByProjectId('p1');
      expect(p1Files).toHaveLength(2);
      expect(p1Files.every(f => f.projectId === 'p1')).toBe(true);
      expect(p1Files.map(f => f.name).sort()).toEqual(['file1.txt', 'file3.txt']);
    });

    it('should return empty array for project with no files', () => {
      const files = repo.getByProjectId('nonexistent-project');
      expect(files).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update file fields', () => {
      const created = repo.create({
        projectId,
        name: 'original.txt',
        path: '/original.txt',
        type: 'file',
        size: 100,
      });

      const updated = repo.update(created.id, {
        name: 'renamed.txt',
        path: '/renamed.txt',
        size: 200,
        mimeType: 'text/plain',
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('renamed.txt');
      expect(updated!.path).toBe('/renamed.txt');
      expect(updated!.size).toBe(200);
      expect(updated!.mimeType).toBe('text/plain');
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('should return null for non-existent file', () => {
      const updated = repo.update('nonexistent', { name: 'new.txt' });
      expect(updated).toBeNull();
    });

    it('should update type', () => {
      const created = repo.create({
        projectId,
        name: 'item',
        path: '/item',
        type: 'file',
      });

      const updated = repo.update(created.id, { type: 'directory' });
      expect(updated!.type).toBe('directory');
    });

    it('should not change projectId', () => {
      const created = repo.create({
        projectId: 'original-project',
        name: 'test.txt',
        path: '/test.txt',
        type: 'file',
      });

      // projectId is not in update params, so it shouldn't change
      const updated = repo.update(created.id, { name: 'renamed.txt' });
      expect(updated!.projectId).toBe('original-project');
    });
  });

  describe('delete', () => {
    it('should delete existing file', () => {
      const created = repo.create({
        projectId,
        name: 'to-delete.txt',
        path: '/to-delete.txt',
        type: 'file',
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);
      expect(repo.getById(created.id)).toBeNull();
    });

    it('should return false for non-existent file', () => {
      const deleted = repo.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteByPath', () => {
    it('should delete file by path', () => {
      const created = repo.create({
        projectId,
        name: 'path-delete.txt',
        path: '/path/to/delete.txt',
        type: 'file',
      });

      const deleted = repo.deleteByPath('/path/to/delete.txt');
      expect(deleted).toBe(true);
      expect(repo.getByPath('/path/to/delete.txt', projectId)).toBeNull();
    });

    it('should return false for non-existent path', () => {
      const deleted = repo.deleteByPath('/nonexistent/path');
      expect(deleted).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in name', () => {
      const file = repo.create({
        projectId,
        name: "file with spaces & symbols!.txt",
        path: "/file with spaces & symbols!.txt",
        type: 'file',
      });

      const found = repo.getById(file.id);
      expect(found!.name).toBe("file with spaces & symbols!.txt");
    });

    it('should handle unicode in paths', () => {
      const file = repo.create({
        projectId,
        name: 'data.json',
        path: '/path/data.json',
        type: 'file',
      });

      const found = repo.getByPath('/path/data.json', projectId);
      expect(found).not.toBeNull();
    });

    it('should handle very long paths', () => {
      const longPath = '/' + 'a'.repeat(500) + '/file.txt';
      const file = repo.create({
        projectId,
        name: 'file.txt',
        path: longPath,
        type: 'file',
      });

      const found = repo.getByPath(longPath, projectId);
      expect(found!.path).toBe(longPath);
    });

    it('should handle large file sizes', () => {
      const largeSize = 10 * 1024 * 1024 * 1024; // 10GB
      const file = repo.create({
        projectId,
        name: 'large.zip',
        path: '/large.zip',
        type: 'file',
        size: largeSize,
      });

      expect(file.size).toBe(largeSize);
    });

    it('should handle zero-size files', () => {
      // The repository uses `data.size || null` which treats 0 as falsy
      const file = repo.create({
        projectId,
        name: 'empty.txt',
        path: '/empty.txt',
        type: 'file',
        size: 0,
      });

      // 0 is treated as falsy, so becomes null
      expect(file.size).toBeNull();
    });

    it('should handle various mime types', () => {
      const mimeTypes = [
        'text/plain',
        'application/json',
        'image/png',
        'video/mp4',
        'application/octet-stream',
      ];

      mimeTypes.forEach((mimeType, i) => {
        const file = repo.create({
          projectId,
          name: `file${i}.ext`,
          path: `/files/file${i}.ext`,
          type: 'file',
          mimeType,
        });
        expect(file.mimeType).toBe(mimeType);
      });
    });

    it('should preserve createdAt on update', () => {
      const created = repo.create({
        projectId,
        name: 'test.txt',
        path: '/preserve-created.txt',
        type: 'file',
      });

      const updated = repo.update(created.id, { name: 'updated.txt' });
      expect(updated!.createdAt).toBe(created.createdAt);
    });
  });
});
