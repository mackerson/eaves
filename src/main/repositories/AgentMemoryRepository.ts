import Database from 'better-sqlite3';
import { AgentMemory, AgentMemoryStatus, AgentMemoryType } from '../types';
import { getDatabase } from '../services/database';
import { AgentMemoryRow, CountRow } from './row-types';

export class AgentMemoryRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  private mapRowToMemory(row: AgentMemoryRow): AgentMemory {
    return {
      id: row.id,
      agentId: row.agent_id,
      content: row.content,
      memoryType: row.memory_type as AgentMemoryType,
      status: row.status as AgentMemoryStatus,
      sourceContext: row.source_context ?? undefined,
      confidence: row.confidence ?? undefined,
      reviewedAt: row.reviewed_at ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      createdAt: row.created_at,
    };
  }

  create(
    agentId: string,
    content: string,
    memoryType: AgentMemoryType = 'conversation',
    sourceContext?: string,
    confidence?: number,
  ): AgentMemory {
    const id = `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO agent_memories (id, agent_id, content, memory_type, status, source_context, confidence, created_at)
      VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?)
    `).run(id, agentId, content, memoryType, sourceContext || null, confidence ?? null, now);

    return this.getById(id)!;
  }

  getById(id: string): AgentMemory | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_memories WHERE id = ?
    `).get(id) as AgentMemoryRow | undefined;

    return row ? this.mapRowToMemory(row) : null;
  }

  getByAgentId(agentId: string, status?: AgentMemoryStatus): AgentMemory[] {
    let query = 'SELECT * FROM agent_memories WHERE agent_id = ?';
    const params: (string)[] = [agentId];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(query).all(...params) as AgentMemoryRow[];
    return rows.map(row => this.mapRowToMemory(row));
  }

  getApprovedByAgentId(agentId: string, limit = 10): AgentMemory[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_memories
      WHERE agent_id = ? AND status = 'approved'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit) as AgentMemoryRow[];

    return rows.map(row => this.mapRowToMemory(row));
  }

  getCandidatesByAgentId(agentId: string): AgentMemory[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_memories
      WHERE agent_id = ? AND status = 'candidate'
      ORDER BY created_at DESC
    `).all(agentId) as AgentMemoryRow[];

    return rows.map(row => this.mapRowToMemory(row));
  }

  getCandidateCount(agentId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM agent_memories
      WHERE agent_id = ? AND status = 'candidate'
    `).get(agentId) as CountRow;

    return row.count;
  }

  updateStatus(id: string, status: AgentMemoryStatus): AgentMemory | null {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE agent_memories SET status = ?, reviewed_at = ? WHERE id = ?
    `).run(status, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  bulkUpdateStatus(ids: string[], status: AgentMemoryStatus): number {
    if (ids.length === 0) return 0;

    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    const result = this.db.prepare(`
      UPDATE agent_memories SET status = ?, reviewed_at = ?
      WHERE id IN (${placeholders})
    `).run(status, now, ...ids);

    return result.changes;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // No deleteExpired(). Nothing in src/main ever called it and nothing ever
  // writes expires_at, so it was a prune for a feature that does not exist —
  // wiring it up would have been a permanent no-op that read as coverage. The
  // column and the Agent type's optional `expiresAt` stay: dropping a column
  // needs a migration, and the read mapping is harmless. Anything that starts
  // setting an expiry needs to bring its own prune back with it.
}
