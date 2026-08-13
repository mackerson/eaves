import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../services/migrations';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let mockDb: Database.Database;
vi.mock('../services/database', () => ({
  getDatabase: () => mockDb,
}));

// Imported after the mock so the constructor picks up mockDb.
import { ToolStateRepository } from './ToolStateRepository';

describe('ToolStateRepository', () => {
  let repo: ToolStateRepository;

  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb, 0);
    repo = new ToolStateRepository();
  });

  it('returns null for an unknown context', () => {
    expect(repo.get('chat-1')).toBeNull();
  });

  it('round-trips an enabled-tool set', () => {
    repo.set('chat-1', ['list_tools', 'web_search']);
    expect(repo.get('chat-1')).toEqual(['list_tools', 'web_search']);
  });

  it('upserts on repeated set (latest wins)', () => {
    repo.set('chat-1', ['a']);
    repo.set('chat-1', ['a', 'b', 'c']);
    expect(repo.get('chat-1')).toEqual(['a', 'b', 'c']);
    // Single row, not duplicated.
    const count = mockDb.prepare('SELECT COUNT(*) AS n FROM tool_session_states').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('deletes persisted state', () => {
    repo.set('chat-1', ['a']);
    repo.delete('chat-1');
    expect(repo.get('chat-1')).toBeNull();
  });

  it('isolates state per context', () => {
    repo.set('chat-1', ['a']);
    repo.set('chat-2', ['b']);
    expect(repo.get('chat-1')).toEqual(['a']);
    expect(repo.get('chat-2')).toEqual(['b']);
  });

  it('returns null on corrupt JSON so loadSessionState re-seeds defaults', () => {
    mockDb.prepare('INSERT INTO tool_session_states (context_id, enabled_tools, updated_at) VALUES (?, ?, ?)')
      .run('chat-bad', '{not json', Date.now());
    expect(repo.get('chat-bad')).toBeNull();
  });
});
