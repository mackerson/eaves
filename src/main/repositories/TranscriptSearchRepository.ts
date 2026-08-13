import type Database from 'better-sqlite3';
import { getDatabase } from '../services/database';
import { toFtsMatch } from './MemoryEntryRepository';

/**
 * Retrieval over `messages` for agents — "what did we say about this before?".
 *
 * Distinct from the memory system. `memory_entries` stores what an agent chose
 * to remember; this searches what was actually said. Both are FTS5, but they
 * answer different questions and neither substitutes for the other.
 *
 * Modelled on file access rather than on `search_memories`: a hit is a
 * *location* plus a window around it, so the caller can page outward from a
 * result instead of pulling a whole conversation into context to find out
 * whether the hit was worth anything.
 *
 * Scope is participation — every conversation the agent is a participant in,
 * whatever its surface. Deliberately NOT `roomsOnly()`: that rule keeps direct
 * chats and work sessions out of the channel *list*, which is a UI concern. An
 * agent recalling its own history should reach everything it took part in.
 */

/** One message in a result window. */
export interface TranscriptMessage {
  messageId: string;
  sender: string;
  senderType: 'human' | 'agent';
  content: string;
  timestamp: number;
}

/** A search hit: where it is, and enough around it to judge relevance. */
export interface TranscriptHit extends TranscriptMessage {
  channelId: string;
  channelName: string;
  channelType: string;
  /** bm25; lower is a better match. */
  score: number;
  before: TranscriptMessage[];
  after: TranscriptMessage[];
}

interface HitRow {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_type: string;
  sender_display_name: string | null;
  sender_id: string;
  sender_type: string;
  content: string;
  timestamp: number;
  score: number;
}

interface WindowRow {
  id: string;
  sender_display_name: string | null;
  sender_id: string;
  sender_type: string;
  content: string;
  timestamp: number;
}

/**
 * Drafts are a half-typed message the user may still abandon, and
 * `regenerated` messages are superseded branches. Neither is something the
 * agent said, so neither is searchable or returned in a window.
 */
const VISIBLE = `m.is_draft = 0 AND m.status != 'regenerated'`;

function mapWindow(row: WindowRow): TranscriptMessage {
  return {
    messageId: row.id,
    sender: row.sender_display_name ?? row.sender_id,
    senderType: row.sender_type as TranscriptMessage['senderType'],
    content: row.content,
    timestamp: row.timestamp,
  };
}

export class TranscriptSearchRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Ranked search across the agent's conversations, each hit carrying a window
   * of surrounding messages.
   *
   * The query is sanitized by `toFtsMatch` into per-token prefix search, so an
   * agent cannot inject FTS5 operators — a tool argument is untrusted input
   * even when the agent is ours.
   */
  search(
    agentId: string,
    query: string,
    options: { limit?: number; contextBefore?: number; contextAfter?: number; channelId?: string } = {},
  ): TranscriptHit[] {
    const match = toFtsMatch(query);
    if (!match) return [];

    const limit = clamp(options.limit ?? 10, 1, 50);
    const before = clamp(options.contextBefore ?? 2, 0, 20);
    const after = clamp(options.contextAfter ?? 2, 0, 20);

    let rows: HitRow[];
    try {
      rows = this.db.prepare(`
        SELECT m.id, m.channel_id, c.name AS channel_name, c.type AS channel_type,
               m.sender_display_name, m.sender_id, m.sender_type, m.content, m.timestamp,
               bm25(messages_fts) AS score
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        JOIN channels c ON c.id = m.channel_id
        JOIN channel_participants p
          ON p.channel_id = m.channel_id AND p.participant_id = ?
        WHERE messages_fts MATCH ?
          AND ${VISIBLE}
          ${options.channelId ? 'AND m.channel_id = ?' : ''}
        ORDER BY score
        LIMIT ?
      `).all(
        ...(options.channelId
          ? [agentId, match, options.channelId, limit]
          : [agentId, match, limit]),
      ) as HitRow[];
    } catch {
      // A malformed MATCH must not break a turn. Same posture as memory search.
      return [];
    }

    return rows.map(row => ({
      messageId: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      channelType: row.channel_type,
      sender: row.sender_display_name ?? row.sender_id,
      senderType: row.sender_type as TranscriptHit['senderType'],
      content: row.content,
      timestamp: row.timestamp,
      score: row.score,
      before: this.neighbours(row.channel_id, row.timestamp, row.id, 'before', before),
      after: this.neighbours(row.channel_id, row.timestamp, row.id, 'after', after),
    }));
  }

  /**
   * Read a window around a known message — the "read more here" half of the
   * pair, so a promising hit can be expanded without a second search.
   *
   * Returns null when the message doesn't exist OR the agent isn't a
   * participant. One answer for both, deliberately: a distinguishable "exists
   * but not yours" would let an agent probe for conversations it can't read.
   */
  readAround(
    agentId: string,
    messageId: string,
    options: { before?: number; after?: number } = {},
  ): { channelId: string; channelName: string; messages: TranscriptMessage[]; target: string } | null {
    const before = clamp(options.before ?? 10, 0, 100);
    const after = clamp(options.after ?? 10, 0, 100);

    const anchor = this.db.prepare(`
      SELECT m.id, m.channel_id, c.name AS channel_name, m.timestamp
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
      JOIN channel_participants p
        ON p.channel_id = m.channel_id AND p.participant_id = ?
      WHERE m.id = ? AND ${VISIBLE}
    `).get(agentId, messageId) as
      { id: string; channel_id: string; channel_name: string; timestamp: number } | undefined;

    if (!anchor) return null;

    const messages = [
      ...this.neighbours(anchor.channel_id, anchor.timestamp, anchor.id, 'before', before),
      mapWindow(this.db.prepare(`
        SELECT id, sender_display_name, sender_id, sender_type, content, timestamp
        FROM messages WHERE id = ?
      `).get(anchor.id) as WindowRow),
      ...this.neighbours(anchor.channel_id, anchor.timestamp, anchor.id, 'after', after),
    ];

    return {
      channelId: anchor.channel_id,
      channelName: anchor.channel_name,
      target: anchor.id,
      messages,
    };
  }

  /** Conversations the agent participates in — the searchable corpus. */
  participatingChannels(agentId: string): Array<{ id: string; name: string; type: string; messageCount: number }> {
    return this.db.prepare(`
      SELECT c.id, c.name, c.type, COUNT(m.id) AS messageCount
      FROM channels c
      JOIN channel_participants p ON p.channel_id = c.id AND p.participant_id = ?
      LEFT JOIN messages m ON m.channel_id = c.id AND m.is_draft = 0 AND m.status != 'regenerated'
      GROUP BY c.id
      ORDER BY messageCount DESC
    `).all(agentId) as Array<{ id: string; name: string; type: string; messageCount: number }>;
  }

  /**
   * Messages adjacent to an anchor within one conversation.
   *
   * Ordered by (timestamp, id) rather than timestamp alone — bulk inserts and
   * replicated batches routinely share a millisecond, and a bare timestamp sort
   * would shuffle those arbitrarily between calls. The id tiebreak keeps a
   * window stable across repeated reads.
   */
  private neighbours(
    channelId: string,
    timestamp: number,
    messageId: string,
    direction: 'before' | 'after',
    count: number,
  ): TranscriptMessage[] {
    if (count === 0) return [];
    const [cmp, order] = direction === 'before' ? ['<', 'DESC'] : ['>', 'ASC'];

    const rows = this.db.prepare(`
      SELECT m.id, m.sender_display_name, m.sender_id, m.sender_type, m.content, m.timestamp
      FROM messages m
      WHERE m.channel_id = ?
        AND (m.timestamp, m.id) ${cmp} (?, ?)
        AND ${VISIBLE}
      ORDER BY m.timestamp ${order}, m.id ${order}
      LIMIT ?
    `).all(channelId, timestamp, messageId, count) as WindowRow[];

    const mapped = rows.map(mapWindow);
    return direction === 'before' ? mapped.reverse() : mapped;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
