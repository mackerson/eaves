import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginGrantsRepository } from './PluginGrantsRepository';
import { createTestDatabase, closeTestDatabase } from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

describe('PluginGrantsRepository', () => {
  let db: Database.Database | null = null;
  let repo: PluginGrantsRepository;

  beforeEach(async () => {
    db = createTestDatabase();
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repo = new PluginGrantsRepository();
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
    vi.clearAllMocks();
  });

  it('get returns null when no grant exists', () => {
    expect(repo.get('plug')).toBeNull();
  });

  it('set/get round-trips permissions JSON, version, and consentedAt', () => {
    const consentedAt = 1_700_000_000_000;
    repo.set('plug', ['tools:register', 'storage:write'], '1.2.3', consentedAt);
    expect(repo.get('plug')).toEqual({
      permissions: ['tools:register', 'storage:write'],
      version: '1.2.3',
      consentedAt,
    });
  });

  it('set upserts on conflict (overwrites prior consent)', () => {
    repo.set('plug', ['a'], '1.0.0', 100);
    repo.set('plug', ['b', 'c'], '2.0.0', 200);
    expect(repo.get('plug')).toEqual({
      permissions: ['b', 'c'],
      version: '2.0.0',
      consentedAt: 200,
    });
  });

  it('set accepts null version', () => {
    repo.set('plug', [], null, 1);
    expect(repo.get('plug')?.version).toBeNull();
  });

  it('delete removes the grant', () => {
    repo.set('plug', ['x'], '1', 1);
    repo.delete('plug');
    expect(repo.get('plug')).toBeNull();
  });
});
