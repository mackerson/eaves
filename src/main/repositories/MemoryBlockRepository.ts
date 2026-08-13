import Database from 'better-sqlite3';
import { getDatabase } from '../services/database';
import { MemoryBlockRow } from './row-types';

/** A default core-memory block seeded per agent (empty, with guidance). */
interface DefaultBlock { label: string; description: string; position: number; charLimit: number }
export const DEFAULT_CORE_BLOCKS: DefaultBlock[] = [
  {
    label: 'human',
    description: "Who you're working with: their identity, role, preferences, and ongoing situation.",
    position: 0,
    charLimit: 2000,
  },
  {
    label: 'current_focus',
    description: "What's active right now: current projects, threads, decisions in flight, and next steps.",
    position: 1,
    charLimit: 2000,
  },
];

/**
 * Agent core-memory blocks — small, always-in-context, agent-editable
 * summaries. Per-agent and labeled. Assembled into context by `memoryContext.ts`.
 */
export class MemoryBlockRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  getByAgent(agentId: string): MemoryBlockRow[] {
    return this.db.prepare(
      `SELECT * FROM memory_blocks WHERE agent_id = ? ORDER BY position, label`,
    ).all(agentId) as MemoryBlockRow[];
  }

  getBlock(agentId: string, label: string): MemoryBlockRow | null {
    return (this.db.prepare(
      `SELECT * FROM memory_blocks WHERE agent_id = ? AND label = ?`,
    ).get(agentId, label) as MemoryBlockRow | undefined) ?? null;
  }

  /** Seed the default blocks for an agent if it has none yet. Idempotent. */
  ensureDefaults(agentId: string): void {
    const existing = new Set(this.getByAgent(agentId).map(b => b.label));
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memory_blocks (id, agent_id, label, value, description, char_limit, read_only, position, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, 0, ?, ?, ?)
    `);
    for (const d of DEFAULT_CORE_BLOCKS) {
      if (existing.has(d.label)) continue;
      insert.run(`blk-${agentId}-${d.label}`, agentId, d.label, d.description, d.charLimit, d.position, now, now);
    }
  }

  /**
   * Create-or-replace a block's value. Creates the block (with a default
   * char_limit) if it doesn't exist. Value is truncated to char_limit.
   * Returns the row, or null if the block is read-only.
   */
  setValue(agentId: string, label: string, value: string, opts?: { description?: string }): MemoryBlockRow | null {
    const existing = this.getBlock(agentId, label);
    if (existing?.read_only) return null;
    const limit = existing?.char_limit ?? 2000;
    const clipped = value.length > limit ? value.slice(0, limit) : value;
    const now = Date.now();
    if (existing) {
      this.db.prepare(
        `UPDATE memory_blocks SET value = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?`,
      ).run(clipped, opts?.description ?? null, now, existing.id);
      return this.getBlock(agentId, label)!;
    }
    const nextPos = (this.getByAgent(agentId).at(-1)?.position ?? -1) + 1;
    this.db.prepare(`
      INSERT INTO memory_blocks (id, agent_id, label, value, description, char_limit, read_only, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(`blk-${agentId}-${label}`, agentId, label, clipped, opts?.description ?? null, limit, nextPos, now, now);
    return this.getBlock(agentId, label)!;
  }

  /** Append text to a block (newline-joined), respecting char_limit. */
  append(agentId: string, label: string, text: string): MemoryBlockRow | null {
    const existing = this.getBlock(agentId, label);
    const base = existing?.value ?? '';
    const joined = base ? `${base}\n${text}` : text;
    return this.setValue(agentId, label, joined);
  }
}
