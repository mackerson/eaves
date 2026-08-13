import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationFolderRepository } from './ConversationFolderRepository';
import {
  createTestDatabase,
  closeTestDatabase,
  seedChannel,
  seedProject,
} from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

describe('ConversationFolderRepository', () => {
  let db: Database.Database | null = null;
  let repo: ConversationFolderRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    seedProject(db, 'proj-1');
    seedProject(db, 'p1');
    seedProject(db, 'p2');
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repo = new ConversationFolderRepository();
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
    vi.clearAllMocks();
  });

  it('create assigns id, position, and optional projectId', () => {
    const a = repo.create({ name: 'Work' });
    const b = repo.create({ name: 'Side', projectId: 'proj-1' });
    expect(a.id).toMatch(/^cfolder-/);
    expect(a.position).toBe(0);
    expect(a.projectId).toBeUndefined();
    expect(b.position).toBe(1);
    expect(b.projectId).toBe('proj-1');
  });

  it('getAll returns all folders; project filter includes null project folders', () => {
    repo.create({ name: 'Global' });
    repo.create({ name: 'Proj', projectId: 'p1' });
    repo.create({ name: 'Other', projectId: 'p2' });

    expect(repo.getAll()).toHaveLength(3);
    const filtered = repo.getAll('p1');
    expect(filtered.map((f) => f.name).sort()).toEqual(['Global', 'Proj']);
  });

  it('rename returns false for missing id and true on success', () => {
    expect(repo.rename('missing', 'X')).toBe(false);
    const f = repo.create({ name: 'Old' });
    expect(repo.rename(f.id, 'New')).toBe(true);
    expect(repo.getAll()[0].name).toBe('New');
  });

  it('delete clears folder_id on channels and removes the folder', () => {
    const f = repo.create({ name: 'Temp' });
    seedChannel(db!, 'ch-1');
    db!.prepare('UPDATE channels SET folder_id = ? WHERE id = ?').run(f.id, 'ch-1');

    expect(repo.delete(f.id)).toBe(true);
    expect(repo.getAll()).toHaveLength(0);
    const folderId = db!.prepare('SELECT folder_id FROM channels WHERE id = ?').get('ch-1') as {
      folder_id: string | null;
    };
    expect(folderId.folder_id).toBeNull();
    expect(repo.delete(f.id)).toBe(false);
  });
});
