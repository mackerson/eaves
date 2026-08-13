import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginStateRepository } from './PluginStateRepository';
import { createTestDatabase, closeTestDatabase } from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

describe('PluginStateRepository', () => {
  let db: Database.Database | null = null;
  let repo: PluginStateRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repo = new PluginStateRepository();
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
    vi.clearAllMocks();
  });

  it('isEnabled returns null for unknown plugins', () => {
    expect(repo.isEnabled('missing')).toBeNull();
  });

  it('setEnabled upserts and isEnabled reads both branches', () => {
    repo.setEnabled('p1', true);
    expect(repo.isEnabled('p1')).toBe(true);
    repo.setEnabled('p1', false);
    expect(repo.isEnabled('p1')).toBe(false);
  });

  it('getAll returns a map of all rows', () => {
    repo.setEnabled('a', true);
    repo.setEnabled('b', false);
    expect(Object.fromEntries(repo.getAll())).toEqual({ a: true, b: false });
  });

  it('delete removes the row so isEnabled is null again', () => {
    repo.setEnabled('p1', true);
    repo.delete('p1');
    expect(repo.isEnabled('p1')).toBeNull();
    expect(repo.getAll().size).toBe(0);
  });
});
