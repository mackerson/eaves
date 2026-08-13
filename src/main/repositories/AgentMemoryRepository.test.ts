import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentMemoryRepository } from './AgentMemoryRepository';
import {
  createTestDatabase,
  closeTestDatabase,
  seedAgent,
} from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

describe('AgentMemoryRepository', () => {
  let db: Database.Database | null = null;
  let repo: AgentMemoryRepository;
  const agentId = 'agent-1';

  beforeEach(async () => {
    db = createTestDatabase();
    seedAgent(db, agentId);
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repo = new AgentMemoryRepository();
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
    vi.clearAllMocks();
  });

  it('create stores a candidate with optional context/confidence', () => {
    const mem = repo.create(agentId, 'likes dark mode', 'external', 'chat-1', 0.9);
    expect(mem.status).toBe('candidate');
    expect(mem.memoryType).toBe('external');
    expect(mem.sourceContext).toBe('chat-1');
    expect(mem.confidence).toBe(0.9);
    expect(repo.getById(mem.id)).toEqual(mem);
  });

  it('getById returns null for missing rows', () => {
    expect(repo.getById('nope')).toBeNull();
  });

  it('getByAgentId filters by status when provided', () => {
    const a = repo.create(agentId, 'a');
    const b = repo.create(agentId, 'b');
    repo.updateStatus(b.id, 'approved');

    expect(repo.getByAgentId(agentId)).toHaveLength(2);
    expect(repo.getByAgentId(agentId, 'candidate').map((m) => m.id)).toEqual([a.id]);
    expect(repo.getByAgentId(agentId, 'approved').map((m) => m.id)).toEqual([b.id]);
  });

  it('getApprovedByAgentId respects limit; getCandidates + count', () => {
    for (let i = 0; i < 3; i++) {
      const m = repo.create(agentId, `c${i}`);
      repo.updateStatus(m.id, 'approved');
    }
    repo.create(agentId, 'still-candidate');

    expect(repo.getApprovedByAgentId(agentId, 2)).toHaveLength(2);
    expect(repo.getCandidatesByAgentId(agentId)).toHaveLength(1);
    expect(repo.getCandidateCount(agentId)).toBe(1);
  });

  it('updateStatus returns null when missing; bulkUpdateStatus handles empty + multi', () => {
    expect(repo.updateStatus('missing', 'approved')).toBeNull();
    expect(repo.bulkUpdateStatus([], 'approved')).toBe(0);

    const a = repo.create(agentId, 'a');
    const b = repo.create(agentId, 'b');
    expect(repo.bulkUpdateStatus([a.id, b.id], 'rejected')).toBe(2);
    expect(repo.getById(a.id)?.status).toBe('rejected');
    expect(repo.getById(a.id)?.reviewedAt).toEqual(expect.any(Number));
  });

  // deleteExpired is gone — nothing ever called it and nothing writes
  // expires_at, so this was the only thing keeping it alive.
  it('delete', () => {
    const m = repo.create(agentId, 'x');
    expect(repo.delete(m.id)).toBe(true);
    expect(repo.delete(m.id)).toBe(false);
  });
});
