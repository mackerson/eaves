import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolApprovalGrantRepository } from './ToolApprovalGrantRepository';
import {
  createTestDatabase,
  closeTestDatabase,
  seedAgent,
  seedChannel,
} from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

describe('ToolApprovalGrantRepository', () => {
  let db: Database.Database | null = null;
  let repo: ToolApprovalGrantRepository;
  const containerId = 'channel-1';
  const agentId = 'agent-1';

  beforeEach(async () => {
    db = createTestDatabase();
    seedAgent(db, agentId);
    seedChannel(db, containerId);
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repo = new ToolApprovalGrantRepository();
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
    vi.clearAllMocks();
  });

  it('listToolNames returns empty Set when none granted', () => {
    expect(repo.listToolNames(containerId, agentId).size).toBe(0);
  });

  it('grant is idempotent for the same container/agent/tool', () => {
    const a = repo.grant({ containerId, agentId, toolName: 'bash', grantedBy: 'user-1' });
    const b = repo.grant({ containerId, agentId, toolName: 'bash', grantedBy: 'user-2' });
    expect(b.id).toBe(a.id);
    expect(b.grantedBy).toBe('user-1'); // original row kept
    expect(repo.listToolNames(containerId, agentId)).toEqual(new Set(['bash']));
  });

  it('list returns grants for the container only, newest first', () => {
    seedAgent(db!, 'agent-2');
    const g1 = repo.grant({ containerId, agentId, toolName: 'bash' });
    const g2 = repo.grant({ containerId, agentId: 'agent-2', toolName: 'web_fetch' });
    const listed = repo.list(containerId);
    expect(listed.map((g) => g.id).sort()).toEqual([g1.id, g2.id].sort());
    expect(repo.list('channel-missing')).toEqual([]);
  });

  it('revoke removes one grant; revokeAllFor clears the conversation', () => {
    const g = repo.grant({ containerId, agentId, toolName: 'bash' });
    repo.grant({ containerId, agentId, toolName: 'web_fetch' });
    expect(repo.revoke(g.id)).toBe(true);
    expect(repo.revoke(g.id)).toBe(false);
    expect(repo.listToolNames(containerId, agentId)).toEqual(new Set(['web_fetch']));
    expect(repo.revokeAllFor(containerId)).toBe(1);
    expect(repo.listToolNames(containerId, agentId).size).toBe(0);
  });
});
