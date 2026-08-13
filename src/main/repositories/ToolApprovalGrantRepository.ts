import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getDatabase } from '../services/database';

export interface ToolApprovalGrant {
  id: string;
  containerId: string;
  agentId: string;
  toolName: string;
  grantedAt: number;
  grantedBy?: string;
}

interface GrantRow {
  id: string;
  container_id: string;
  agent_id: string;
  tool_name: string;
  granted_at: number;
  granted_by: string | null;
}

/**
 * "Stop asking me about this tool, in this conversation."
 *
 * Scope is the whole design. A grant covers one tool, one agent, one
 * conversation — narrow enough that it expires with the thing it was about,
 * because an approval is only meaningful while attached to a situation. Wider
 * scopes are deliberately not modelled yet. The ladder, narrowest first: this
 * turn's batch (done), this conversation (this table), tool + argument shape
 * ("edit_file under this directory"), then a standing per-agent grant, which
 * should feel like a settings change rather than a checkbox in a hurry.
 *
 * A grant suppresses the PROMPT. It never makes a tool available where it
 * would not otherwise be, and never applies to unattended execution — routines
 * and workflow nodes run without an interactive toolset at all.
 */
export class ToolApprovalGrantRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /** Tool names this agent may run un-prompted in this conversation. */
  listToolNames(containerId: string, agentId: string): Set<string> {
    const rows = this.db.prepare(
      'SELECT tool_name FROM tool_approval_grants WHERE container_id = ? AND agent_id = ?',
    ).all(containerId, agentId) as Array<{ tool_name: string }>;
    return new Set(rows.map(r => r.tool_name));
  }

  list(containerId: string): ToolApprovalGrant[] {
    const rows = this.db.prepare(
      'SELECT * FROM tool_approval_grants WHERE container_id = ? ORDER BY granted_at DESC',
    ).all(containerId) as GrantRow[];
    return rows.map(rowToGrant);
  }

  /** Idempotent: granting twice is the same as granting once. */
  grant(params: { containerId: string; agentId: string; toolName: string; grantedBy?: string }): ToolApprovalGrant {
    const existing = this.db.prepare(
      'SELECT * FROM tool_approval_grants WHERE container_id = ? AND agent_id = ? AND tool_name = ?',
    ).get(params.containerId, params.agentId, params.toolName) as GrantRow | undefined;
    if (existing) return rowToGrant(existing);

    const id = `grant-${randomUUID()}`;
    const grantedAt = Date.now();
    this.db.prepare(`
      INSERT INTO tool_approval_grants (id, container_id, agent_id, tool_name, granted_at, granted_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, params.containerId, params.agentId, params.toolName, grantedAt, params.grantedBy ?? null);

    return {
      id,
      containerId: params.containerId,
      agentId: params.agentId,
      toolName: params.toolName,
      grantedAt,
      grantedBy: params.grantedBy,
    };
  }

  revoke(id: string): boolean {
    return this.db.prepare('DELETE FROM tool_approval_grants WHERE id = ?').run(id).changes > 0;
  }

  /** Clear every waiver in a conversation — the "start asking me again" escape hatch. */
  revokeAllFor(containerId: string): number {
    return this.db.prepare('DELETE FROM tool_approval_grants WHERE container_id = ?').run(containerId).changes;
  }
}

function rowToGrant(row: GrantRow): ToolApprovalGrant {
  return {
    id: row.id,
    containerId: row.container_id,
    agentId: row.agent_id,
    toolName: row.tool_name,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by ?? undefined,
  };
}
