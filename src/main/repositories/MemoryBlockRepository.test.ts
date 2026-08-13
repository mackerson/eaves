import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../services/migrations';
import { MemoryBlockRepository, DEFAULT_CORE_BLOCKS } from './MemoryBlockRepository';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

describe('MemoryBlockRepository', () => {
  let db: Database.Database;
  let repo: MemoryBlockRepository;
  const agentId = 'agent-1';

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db, 0);
    db.prepare(`INSERT INTO agents (id, name, description, provider, model, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(agentId, 'Tester', '', 'openrouter', 'z-ai/glm-5.2', '#2563eb', Date.now());
    const dbMod = await import('../services/database');
    vi.mocked(dbMod.getDatabase).mockReturnValue(db);
    repo = new MemoryBlockRepository();
  });

  it('seeds default blocks once (idempotent)', () => {
    repo.ensureDefaults(agentId);
    repo.ensureDefaults(agentId);
    const blocks = repo.getByAgent(agentId);
    expect(blocks.map(b => b.label)).toEqual(DEFAULT_CORE_BLOCKS.map(d => d.label));
    expect(blocks.every(b => b.value === '')).toBe(true);
    expect(blocks[0].description).toBeTruthy();
  });

  it('setValue creates-or-replaces and preserves order', () => {
    repo.ensureDefaults(agentId);
    repo.setValue(agentId, 'human', 'Robin — staff engineer');
    repo.setValue(agentId, 'human', 'Robin — updated');
    expect(repo.getBlock(agentId, 'human')?.value).toBe('Robin — updated');
    // Creating a brand-new label appends after existing blocks.
    repo.setValue(agentId, 'scratchpad', 'ad-hoc');
    const labels = repo.getByAgent(agentId).map(b => b.label);
    expect(labels).toContain('scratchpad');
    expect(labels.indexOf('scratchpad')).toBeGreaterThan(labels.indexOf('current_focus'));
  });

  it('append concatenates with a newline', () => {
    repo.setValue(agentId, 'current_focus', 'line 1');
    repo.append(agentId, 'current_focus', 'line 2');
    expect(repo.getBlock(agentId, 'current_focus')?.value).toBe('line 1\nline 2');
  });

  it('truncates values past char_limit', () => {
    repo.setValue(agentId, 'human', 'x'.repeat(50), );
    // Shrink the limit and re-set to force truncation.
    db.prepare(`UPDATE memory_blocks SET char_limit = 10 WHERE agent_id = ? AND label = 'human'`).run(agentId);
    const row = repo.setValue(agentId, 'human', 'y'.repeat(50));
    expect(row?.value.length).toBe(10);
  });

  it('refuses to edit a read-only block', () => {
    repo.setValue(agentId, 'persona', 'fixed');
    db.prepare(`UPDATE memory_blocks SET read_only = 1 WHERE agent_id = ? AND label = 'persona'`).run(agentId);
    const res = repo.setValue(agentId, 'persona', 'changed');
    expect(res).toBeNull();
    expect(repo.getBlock(agentId, 'persona')?.value).toBe('fixed');
  });

  it('blocks cascade-delete with the agent', () => {
    repo.ensureDefaults(agentId);
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(agentId);
    expect(repo.getByAgent(agentId)).toHaveLength(0);
  });
});
