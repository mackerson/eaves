import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Channel, Chat, ChatMessage, Participant, Message } from '../types';
import { getDatabase } from '../services/database';
import { eventBus } from '../services/EventBus';
import { logger } from '../services/logger';
import { buildUpdateFields } from '../utils/buildUpdateFields';
import { safeJsonParseOptional } from '../utils/safeJson';
import { ChannelRow, ChannelParticipantRow, MessageRow, ChatRow, ChatMessageRow } from './row-types';
import {
  MessageTableConfig,
  queryMessages,
  mapBaseMessageFields,
  insertMessage,
  bulkInsertMessages,
  deleteMessage as deleteMessageShared,
  updateMessageText as updateMessageTextShared,
} from './messageCRUD';

const CHANNEL_MSG_CONFIG: MessageTableConfig = {
  tableName: 'messages',
  containerIdColumn: 'channel_id',
  idPrefix: 'msg-',
  extraColumns: ['is_draft'],
};

// Direct-channel (chat) messages ride the same `messages` table but carry the
// 'chatmsg-' id prefix that direct rows are already stored with, and write no
// is_draft column — chat messages have no draft lifecycle (pinned contract:
// isDraft is always false on the 'chat'-context message:created event).
const CHAT_MSG_CONFIG: MessageTableConfig = {
  tableName: 'messages',
  containerIdColumn: 'channel_id',
  idPrefix: 'chatmsg-',
};

/**
 * The channel surface is rooms only. `direct` rows are the chat surface's
 * projection over the same table, and `work` rows are delegated work sessions
 * — neither belongs in a channel list,
 * search result or tag filter. One rule, so a third conversation kind cannot
 * leak into the UI by being added in only two of the three places.
 */
function roomsOnly(alias = ''): string {
  const col = alias ? `${alias}.type` : 'type';
  return `${col} NOT IN ('direct', 'work')`;
}

export class ChannelRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Get all channels with their participants and messages
   * By default, messages are NOT loaded for performance.
   * Use includeMessages: true and messageLimit to control loading.
   */
  getAll(options: { includeMessages?: boolean; messageLimit?: number; includeArchived?: boolean } = {}): Channel[] {
    // Direct channels (1:1 chats) are owned by the Chats projection — exclude
    // them from channel list queries so they don't surface in the channels view.
    // Archived channels are excluded by default, mirroring the chat surface.
    let query = `SELECT * FROM channels WHERE ${roomsOnly()}`;
    if (!(options.includeArchived ?? false)) {
      query += ' AND archived_at IS NULL';
    }
    query += ' ORDER BY created_at ASC';

    const rows = this.db.prepare(query).all() as ChannelRow[];
    return rows.map(row => this.mapRowToChannel(row, {
      includeMessages: options.includeMessages ?? false,
      messageLimit: options.messageLimit ?? 50,
    }));
  }

  getById(id: string, options: { includeMessages?: boolean; messageLimit?: number } = {}): Channel | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!row) return null;
    return this.mapRowToChannel(row, {
      includeMessages: options.includeMessages ?? true,
      messageLimit: options.messageLimit ?? 100,
    });
  }

  private mapRowToChannel(row: ChannelRow, options: { includeMessages: boolean; messageLimit: number }): Channel {
    return {
      id: row.id,
      name: row.name,
      type: row.type as Channel['type'],
      projectId: row.project_id ?? undefined,
      participants: this.getParticipants(row.id),
      messages: options.includeMessages ? this.getMessagesByChannelId(row.id, options.messageLimit) : [],
      createdAt: row.created_at,
      pinned: !!row.pinned,
      folderId: row.folder_id ?? undefined,
      tags: this.parseTags(row.tags),
      archivedAt: row.archived_at ?? undefined,
    };
  }

  /**
   * Tags are first-class on ALL channels. The channel surface stores them as
   * a JSON string array; direct-channel rows written by the chat surface hold
   * a comma-delimited string, so the reader accepts both shapes. Writers (see
   * `update`) normalize to JSON.
   */
  private parseTags(raw: string | null): string[] | undefined {
    if (!raw) return undefined;
    const parsed = safeJsonParseOptional<unknown>(raw);
    const tags = Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : raw.split(',').map(t => t.trim()).filter(Boolean);
    return tags.length > 0 ? tags : undefined;
  }

  /** Escape special LIKE pattern characters. */
  private escapeLikePattern(str: string): string {
    return str.replace(/[%_\[\]\\]/g, '\\$&');
  }

  create(channel: { name: string; type: Channel['type']; projectId?: string }, initialParticipants: Participant[] = []): Channel {
    const id = `channel-${randomUUID()}`;
    const createdAt = Date.now();

    this.db.prepare(`
      INSERT INTO channels (id, name, type, project_id, created_at, pinned)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, channel.name, channel.type, channel.projectId || null, createdAt, 0);

    for (const participant of initialParticipants) {
      this.addParticipant(id, participant);
    }

    return {
      id,
      name: channel.name,
      type: channel.type,
      projectId: channel.projectId,
      participants: this.getParticipants(id),
      messages: [],
      createdAt,
      pinned: false,
    };
  }

  /**
   * Conversation-level setters — valid for any channels row (group channels
   * AND direct chats live in the same table), so the pin/folder IPC surface
   * doesn't need to know which kind it's touching.
   */
  setConversationPinned(conversationId: string, pinned: boolean): boolean {
    const result = this.db.prepare('UPDATE channels SET pinned = ? WHERE id = ?')
      .run(pinned ? 1 : 0, conversationId);
    return result.changes > 0;
  }

  setConversationFolder(conversationId: string, folderId: string | null): boolean {
    const result = this.db.prepare('UPDATE channels SET folder_id = ? WHERE id = ?')
      .run(folderId, conversationId);
    return result.changes > 0;
  }

  update(id: string, updates: { name?: string; pinned?: boolean; tags?: string[] | null }): Channel | null {
    // An empty tag list means "clear" — store NULL, not '[]'.
    const normalized = updates.tags !== undefined && (!updates.tags || updates.tags.length === 0)
      ? { ...updates, tags: null }
      : updates;

    const { clauses, params } = buildUpdateFields(normalized, {
      name: 'name',
      pinned: { column: 'pinned', transform: 'boolInt' },
      tags: { column: 'tags', transform: 'json' },
    });

    if (clauses.length === 0) return this.getById(id);

    params.push(id);
    this.db.prepare(`UPDATE channels SET ${clauses.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  /**
   * Archive / unarchive — first-class on all channels, group and direct.
   * Storage-event silent: these are updates, and the pinned event contract
   * only covers message creation and draft finalize.
   */
  archive(id: string): Channel | null {
    this.db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(Date.now(), id);
    return this.getById(id);
  }

  unarchive(id: string): Channel | null {
    this.db.prepare('UPDATE channels SET archived_at = NULL WHERE id = ?').run(id);
    return this.getById(id);
  }

  /**
   * Search channels by name or message content. Excludes direct channels by
   * default (they are owned by the chat projection); pass `type: 'direct'`
   * for the same SQL semantics as `searchDirectChats` (which returns the
   * Chat-shaped projection instead of Channel).
   */
  search(query: string, options: { includeArchived?: boolean; type?: Channel['type'] } = {}): Channel[] {
    const searchPattern = `%${this.escapeLikePattern(query)}%`;

    let sql = `
      SELECT DISTINCT c.*
      FROM channels c
      LEFT JOIN messages m ON c.id = m.channel_id
      WHERE (c.name LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
    `;
    const params: unknown[] = [searchPattern, searchPattern];

    if (options.type) {
      sql += ' AND c.type = ?';
      params.push(options.type);
    } else {
      sql += ` AND ${roomsOnly('c')}`;
    }
    if (!(options.includeArchived ?? false)) {
      sql += ' AND c.archived_at IS NULL';
    }
    sql += ' ORDER BY COALESCE(c.last_message_at, c.created_at) DESC';

    const rows = this.db.prepare(sql).all(...params) as ChannelRow[];
    return rows.map(row => this.mapRowToChannel(row, { includeMessages: false, messageLimit: 50 }));
  }

  /**
   * Get channels matching any of the provided tags. Substring LIKE against
   * the whole `tags` column — it holds either a JSON array or a comma-
   * delimited string (see `parseTags`), so there is no per-tag column to
   * match exactly. Same type/archived scoping rules as `search`.
   */
  getByTags(tags: string[], options: { includeArchived?: boolean; type?: Channel['type'] } = {}): Channel[] {
    if (tags.length === 0) return [];

    const tagPatterns = tags.map(tag => `%${this.escapeLikePattern(tag)}%`);
    const tagConditions = tagPatterns.map(() => "tags LIKE ? ESCAPE '\\'").join(' OR ');

    let sql = `SELECT * FROM channels WHERE (${tagConditions})`;
    const params: unknown[] = [...tagPatterns];

    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    } else {
      sql += ` AND ${roomsOnly()}`;
    }
    if (!(options.includeArchived ?? false)) {
      sql += ' AND archived_at IS NULL';
    }
    sql += ' ORDER BY COALESCE(last_message_at, created_at) DESC';

    const rows = this.db.prepare(sql).all(...params) as ChannelRow[];
    return rows.map(row => this.mapRowToChannel(row, { includeMessages: false, messageLimit: 50 }));
  }

  /**
   * Frequency-ranked tags for the reuse-first metadata prompt. Prefixed
   * organizational tags (folder:, project:, gpt:) are excluded — they aren't
   * minted by the LLM. Spans all channel types by default; pass `type` to
   * scope to one surface (the chat surface passes 'direct').
   */
  getTagUsage(limit = 30, type?: Channel['type']): string[] {
    const rows = (type
      ? this.db.prepare("SELECT tags FROM channels WHERE type = ? AND tags IS NOT NULL AND tags != ''").all(type)
      : this.db.prepare("SELECT tags FROM channels WHERE tags IS NOT NULL AND tags != ''").all()
    ) as Array<{ tags: string }>;

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const raw of this.parseTags(row.tags) ?? []) {
        const tag = raw.trim().toLowerCase();
        if (!tag || tag.includes(':')) continue;
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([tag]) => tag);
  }

  /**
   * Delete a channel and all its messages
   * Returns true if deleted, false if not found
   * Transactional — messages, participants, and the channel row must all go
   * or none of them do, so a failed delete can't strand orphaned rows.
   */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      // Delete messages first (due to foreign key constraint)
      this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id);
      // Delete participants
      this.db.prepare('DELETE FROM channel_participants WHERE channel_id = ?').run(id);
      // Delete channel
      const result = this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
      return result.changes > 0;
    })();
  }

  // Compaction summary -------------------------------------------------------

  /** Running compaction summary for a channel, or null if none yet. */
  getContextSummary(channelId: string): { summary: string; throughMessageId: string | null; updatedAt: number | null } | null {
    const row = this.db.prepare(
      'SELECT context_summary, summary_through_message_id, summary_updated_at FROM channels WHERE id = ?'
    ).get(channelId) as { context_summary: string | null; summary_through_message_id: string | null; summary_updated_at: number | null } | undefined;
    if (!row || !row.context_summary) return null;
    return {
      summary: row.context_summary,
      throughMessageId: row.summary_through_message_id,
      updatedAt: row.summary_updated_at,
    };
  }

  /** Store/refresh the running compaction summary + the newest folded-in message id. */
  setContextSummary(channelId: string, summary: string, throughMessageId: string): void {
    this.db.prepare(
      'UPDATE channels SET context_summary = ?, summary_through_message_id = ?, summary_updated_at = ? WHERE id = ?'
    ).run(summary, throughMessageId, Date.now(), channelId);
  }

  /** Clear the compaction summary for a channel. */
  clearContextSummary(channelId: string): void {
    this.db.prepare(
      'UPDATE channels SET context_summary = NULL, summary_through_message_id = NULL, summary_updated_at = NULL WHERE id = ?'
    ).run(channelId);
  }

  // Participant operations

  private getParticipants(channelId: string): Participant[] {
    const rows = this.db.prepare(`
      SELECT participant_id, participant_type, display_name, color, joined_at
      FROM channel_participants
      WHERE channel_id = ?
      ORDER BY joined_at ASC
    `).all(channelId) as ChannelParticipantRow[];

    return rows.map(row => ({
      id: row.participant_id,
      type: (row.participant_type || 'agent') as Participant['type'],
      displayName: row.display_name || row.participant_id,
      color: row.color || undefined,
      joinedAt: row.joined_at,
    }));
  }

  addParticipant(channelId: string, participant: Participant): void {
    this.db.prepare(`
      INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, participant_id)
      DO UPDATE SET participant_type = excluded.participant_type, display_name = excluded.display_name, color = excluded.color
    `).run(
      channelId,
      participant.id,
      participant.type,
      participant.displayName,
      participant.color || null,
      participant.joinedAt ?? Date.now()
    );
  }

  // Message operations

  /**
   * Get messages for a channel with optional limit
   * @param channelId - The channel ID
   * @param limit - Maximum number of messages to return (most recent). Undefined = all messages
   */
  getMessagesByChannelId(channelId: string, limit?: number): Message[] {
    return queryMessages<MessageRow>(this.db, CHANNEL_MSG_CONFIG, channelId, this.mapMessageRow, limit) as Message[];
  }

  private mapMessageRow = (row: MessageRow): Message => ({
    ...mapBaseMessageFields(row, 'message'),
    channelId: row.channel_id,
    senderType: row.sender_type as Message['senderType'],
    isDraft: !!row.is_draft,
  });

  createMessage(message: Omit<Message, 'id'>): Message {
    const id = insertMessage(this.db, CHANNEL_MSG_CONFIG, message as any, message.channelId);
    const displayName = message.senderDisplayName ?? message.senderId;
    const result: Message = {
      id,
      ...message,
      senderDisplayName: displayName,
      senderColor: message.senderColor ?? undefined,
      metadata: message.metadata,
    };

    eventBus.emitEvent('message:created', {
      id,
      channelId: message.channelId,
      senderId: message.senderId,
      senderType: message.senderType,
      senderDisplayName: displayName,
      content: message.content,
      timestamp: message.timestamp,
      metadata: message.metadata,
      context: 'channel',
      isDraft: !!message.isDraft,
    });

    return result;
  }

  bulkCreateMessages(messages: Omit<Message, 'id'>[]): string[] {
    return bulkInsertMessages(this.db, CHANNEL_MSG_CONFIG, messages as any[], m => m.channelId);
  }

  /**
   * Event-silent message update. The string form rewrites content only; the
   * object form updates any of content / contentBlocks / responseMessages.
   * Neither form ever emits — the pinned event contract covers only creation
   * and draft finalize.
   */
  updateMessage(messageId: string, updates: string | { content?: string; contentBlocks?: any[]; responseMessages?: unknown[] }): void {
    if (typeof updates === 'string') {
      this.db.prepare(`
        UPDATE messages
        SET content = ?
        WHERE id = ?
      `).run(updates, messageId);
      return;
    }

    const setClauses: string[] = [];
    const values: any[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.contentBlocks !== undefined) {
      setClauses.push('content_blocks = ?');
      values.push(JSON.stringify(updates.contentBlocks));
    }
    if (updates.responseMessages !== undefined) {
      setClauses.push('response_messages_json = ?');
      values.push(JSON.stringify(updates.responseMessages));
    }

    if (setClauses.length > 0) {
      values.push(messageId);
      this.db.prepare(`
        UPDATE messages
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `).run(...values);
    }
  }

  /** User-edit path: rewrites content and keeps the text content block in sync. */
  updateMessageText(messageId: string, content: string): { contentBlocks: any[] | null } | null {
    return updateMessageTextShared(this.db, CHANNEL_MSG_CONFIG, messageId, content);
  }

  /**
   * Update message content blocks incrementally (for streaming/draft messages)
   */
  updateMessageContentBlocks(messageId: string, contentBlocks: any[], content?: string, isDraft?: boolean, metrics?: any, responseMessages?: unknown[]): void {
    // Capture the pre-update draft flag so the draftFinalized event below
    // fires only on a real 1 → 0 transition. Callers that re-save an
    // already-finalized message with isDraft=false (e.g. approval decisions
    // updating a tool-approval block) must not re-trigger mention dispatch.
    const wasDraft = isDraft === false
      ? !!(this.db.prepare('SELECT is_draft FROM messages WHERE id = ?').get(messageId) as { is_draft: number | null } | undefined)?.is_draft
      : false;

    const contentBlocksJson = JSON.stringify(contentBlocks);
    const updates: string[] = ['content_blocks = ?'];
    const params: any[] = [contentBlocksJson];

    if (content !== undefined) {
      updates.push('content = ?');
      params.push(content);
    }

    if (isDraft !== undefined) {
      updates.push('is_draft = ?');
      params.push(isDraft ? 1 : 0);
    }

    if (metrics !== undefined) {
      updates.push('metrics = ?');
      params.push(JSON.stringify(metrics));
    }

    if (responseMessages !== undefined) {
      updates.push('response_messages_json = ?');
      params.push(JSON.stringify(responseMessages));
    }

    params.push(messageId);

    this.db.prepare(`
      UPDATE messages
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params);

    // When a draft is finalized (is_draft 1 → 0) with content, emit message:updated
    // so the ChannelDispatcher can parse @mentions from the completed response
    if (isDraft === false && wasDraft && content) {
      // Look up the full message to get sender/channel context
      const row = this.db.prepare('SELECT channel_id, sender_id, sender_type, sender_display_name, metadata FROM messages WHERE id = ?').get(messageId) as { channel_id: string; sender_id: string; sender_type: string; sender_display_name: string; metadata: string | null } | undefined;
      if (row) {
        const metadata = row.metadata ? JSON.parse(row.metadata) : {};
        eventBus.emitEvent('message:updated', {
          id: messageId,
          channelId: row.channel_id,
          senderId: row.sender_id,
          senderType: row.sender_type,
          senderDisplayName: row.sender_display_name,
          content,
          metadata,
          context: 'channel',
          draftFinalized: true,
        });
      }
    }
  }

  deleteMessage(messageId: string): boolean {
    return deleteMessageShared(this.db, CHANNEL_MSG_CONFIG, messageId);
  }

  // ---------------------------------------------------------------------------
  // Direct-channel (chat) projection
  //
  // A "chat" IS a `channels` row with type='direct': its messages live in
  // `messages` (keyed by channel_id) and its participants in
  // `channel_participants`. One repository owns both shapes because splitting
  // them would duplicate every message/participant query.
  //
  // The methods below are the chat-shaped API the chat IPC surface /
  // ChatService / messaging bridge speak: Chat carries agentId /
  // lastMessageAt / userPersona and comma-delimited tags; ChatMessage carries
  // chatId. They also carry the pinned 'chat' storage-event contract on
  // createDirectMessage and the event-silent bulk import.
  //
  // Branch/swipe tree ops are HARD-GATED to direct channels (resolved
  // decision 2026-07-15: branching a shared room is deferred product design).
  // Mutating ops (regenerateFrom, switchActiveBranch) THROW on a non-direct
  // channel — they alter message status and must fail loudly; the IPC error
  // envelope surfaces the message. Read ops (getSiblings,
  // getLatestActiveMessageId, getNextBranchIndex, getMessagesByChatId) WARN
  // and return their empty value — their callers treat that as "nothing to
  // do" (no parent to chain to, no siblings to swipe to).
  // ---------------------------------------------------------------------------

  /** Channel type for a channels row, or null when the row doesn't exist. */
  private channelType(channelId: string): string | null {
    const row = this.db.prepare('SELECT type FROM channels WHERE id = ?').get(channelId) as { type: string } | undefined;
    return row?.type ?? null;
  }

  /**
   * Gate for branch/tree ops: allowed on one-agent conversations, refused on
   * rooms. Branching a shared room is deferred product design (resolved
   * 2026-07-15) — who owns a regenerated reply when several participants have
   * already read the original is unanswered.
   *
   * Work sessions qualify: one agent, one human, a linear thread, so
   * regenerate and swipe mean exactly what they mean in a 1:1. This is also
   * load-bearing beyond branching — the message read path runs through the
   * same gate, so a refused session could not read its own transcript.
   *
   * Throws for mutating ops, warns and returns false for reads.
   */
  private gateSingleAgentOnly(channelId: string, op: string, mode: 'throw' | 'warn'): boolean {
    const type = this.channelType(channelId);
    if (type === 'direct' || type === 'work') return true;
    const detail = type === null ? 'channel not found' : `channel type '${type}'`;
    if (mode === 'throw') {
      throw new Error(`${op}: branch operations are only supported on 1:1 chats and work sessions (${detail}: ${channelId})`);
    }
    logger.warn(`[ChannelRepository] ${op} called on a room — branch/tree ops are for 1:1 chats and work sessions`, { channelId, type });
    return false;
  }

  /**
   * Get all direct chats. By default, messages and participants are NOT
   * loaded for performance; archived chats are excluded.
   */
  getDirectChats(options: { includeArchived?: boolean; includeMessages?: boolean; includeParticipants?: boolean; messageLimit?: number } = {}): Chat[] {
    const includeArchived = options.includeArchived ?? false;
    const includeMessages = options.includeMessages ?? false;
    const includeParticipants = options.includeParticipants ?? false;
    const messageLimit = options.messageLimit ?? 50;

    let query = "SELECT * FROM channels WHERE type = 'direct'";
    if (!includeArchived) {
      query += ' AND archived_at IS NULL';
    }
    query += ' ORDER BY COALESCE(last_message_at, created_at) DESC';

    const rows = this.db.prepare(query).all() as ChatRow[];
    return rows.map(row => this.mapRowToChat(row, { includeMessages, includeParticipants, messageLimit }));
  }

  /**
   * Load a conversation the turn core can run in, whichever surface owns it:
   * a 1:1 chat or a work session. Both are the same row shape, and the turn
   * core has no business caring which — but the chat IPC surface does, so it
   * keeps using getDirectChatById and never sees sessions.
   */
  getConversationById(id: string, options: { includeMessages?: boolean; messageLimit?: number } = {}): Chat | null {
    const row = this.db.prepare(
      "SELECT * FROM channels WHERE id = ? AND type IN ('direct', 'work')",
    ).get(id) as ChatRow | undefined;
    if (!row) return null;
    return this.mapRowToChat(row, {
      includeMessages: options.includeMessages ?? true,
      includeParticipants: true,
      messageLimit: options.messageLimit ?? 100,
    });
  }

  getDirectChatById(id: string, options: { includeMessages?: boolean; messageLimit?: number } = {}): Chat | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ? AND type = 'direct'").get(id) as ChatRow | undefined;
    if (!row) return null;
    return this.mapRowToChat(row, {
      includeMessages: options.includeMessages ?? true,
      includeParticipants: true,
      messageLimit: options.messageLimit ?? 100,
    });
  }

  getDirectChatsByAgentId(agentId: string, options: { includeArchived?: boolean; includeParticipants?: boolean } = {}): Chat[] {
    const includeArchived = options.includeArchived ?? false;
    const includeParticipants = options.includeParticipants ?? false;

    let query = "SELECT * FROM channels WHERE type = 'direct' AND agent_id = ?";
    if (!includeArchived) {
      query += ' AND archived_at IS NULL';
    }
    query += ' ORDER BY COALESCE(last_message_at, created_at) DESC';

    const rows = this.db.prepare(query).all(agentId) as ChatRow[];
    return rows.map(row => this.mapRowToChat(row, { includeParticipants }));
  }

  /** Search direct chats by name or message content (chat-shaped results). */
  searchDirectChats(query: string, options: { includeArchived?: boolean } = {}): Chat[] {
    const includeArchived = options.includeArchived ?? false;
    const searchPattern = `%${this.escapeLikePattern(query)}%`;

    let sql = `
      SELECT DISTINCT c.*
      FROM channels c
      LEFT JOIN messages m ON c.id = m.channel_id
      WHERE c.type = 'direct' AND (c.name LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
    `;

    if (!includeArchived) {
      sql += ' AND c.archived_at IS NULL';
    }

    sql += ' ORDER BY COALESCE(c.last_message_at, c.created_at) DESC';

    const rows = this.db.prepare(sql).all(searchPattern, searchPattern) as ChatRow[];
    return rows.map(row => this.mapRowToChat(row));
  }

  /** Direct chats matching any of the provided tags (substring LIKE match). */
  getDirectChatsByTags(tags: string[], options: { includeArchived?: boolean } = {}): Chat[] {
    if (tags.length === 0) return [];
    const includeArchived = options.includeArchived ?? false;

    const tagPatterns = tags.map(tag => `%${this.escapeLikePattern(tag)}%`);
    const tagConditions = tagPatterns.map(() => "tags LIKE ? ESCAPE '\\'").join(' OR ');

    let query = `SELECT * FROM channels WHERE type = 'direct' AND (${tagConditions})`;
    if (!includeArchived) {
      query += ' AND archived_at IS NULL';
    }
    query += ' ORDER BY COALESCE(last_message_at, created_at) DESC';

    const rows = this.db.prepare(query).all(...tagPatterns) as ChatRow[];
    return rows.map(row => this.mapRowToChat(row));
  }

  createDirectChat(chat: { name: string; agentId: string; tags?: string }, initialParticipants: Participant[] = []): Chat {
    const id = `chat-${randomUUID()}`;
    const createdAt = Date.now();

    this.db.prepare(`
      INSERT INTO channels (id, name, type, agent_id, created_at, tags)
      VALUES (?, ?, 'direct', ?, ?, ?)
    `).run(id, chat.name, chat.agentId, createdAt, chat.tags || null);

    for (const participant of initialParticipants) {
      this.addParticipant(id, participant);
    }

    return {
      id,
      name: chat.name,
      agentId: chat.agentId,
      participants: this.getParticipants(id),
      messages: [],
      createdAt,
      tags: chat.tags,
    };
  }

  /**
   * Create a work session: one agent, one task, its own transcript.
   *
   * `parentChannelId` records where the delegation came from so a later phase
   * can report back to it; NULL when a session is started straight from a
   * task. The task binding is what makes the row a session, so it is required
   * here even though the column is nullable — the column allows NULL only so
   * that deleting a task detaches the session instead of destroying its
   * transcript.
   */
  createWorkSession(
    session: { name: string; agentId: string; taskId: string; projectId?: string; parentChannelId?: string },
    initialParticipants: Participant[] = [],
  ): Chat {
    const id = `work-${randomUUID()}`;
    const createdAt = Date.now();

    this.db.prepare(`
      INSERT INTO channels (id, name, type, agent_id, project_id, task_id, parent_channel_id, created_at)
      VALUES (?, ?, 'work', ?, ?, ?, ?, ?)
    `).run(
      id, session.name, session.agentId, session.projectId ?? null,
      session.taskId, session.parentChannelId ?? null, createdAt,
    );

    for (const participant of initialParticipants) {
      this.addParticipant(id, participant);
    }

    return {
      id,
      name: session.name,
      agentId: session.agentId,
      participants: this.getParticipants(id),
      messages: [],
      createdAt,
    };
  }

  /** True when the id names a work session, so callers can scope session-only behaviour. */
  isWorkSession(channelId: string): boolean {
    return this.channelType(channelId) === 'work';
  }

  /** Where a work session reports back to, or null if it was started standalone. */
  getWorkSessionParentId(sessionId: string): string | null {
    const row = this.db.prepare(
      "SELECT parent_channel_id FROM channels WHERE id = ? AND type = 'work'",
    ).get(sessionId) as { parent_channel_id: string | null } | undefined;
    return row?.parent_channel_id ?? null;
  }

  /** Sessions opened for a task, newest first. */
  getWorkSessionsByTaskId(taskId: string): Chat[] {
    const rows = this.db.prepare(
      "SELECT * FROM channels WHERE type = 'work' AND task_id = ? ORDER BY created_at DESC",
    ).all(taskId) as ChatRow[];
    return rows.map(row => this.mapRowToChat(row, { includeParticipants: true }));
  }

  /**
   * Chat-shaped update: tags is the comma-delimited string form (the
   * channel-surface `update` takes string[]); userPersona has no channel
   * equivalent.
   * Event-silent, like every update path.
   */
  updateDirectChat(id: string, updates: { name?: string; tags?: string; userPersona?: string }): Chat | null {
    const { clauses, params } = buildUpdateFields(updates, {
      name: 'name',
      tags: { column: 'tags', transform: 'nullable' },
      userPersona: { column: 'user_persona', transform: 'nullable' },
    });

    if (clauses.length === 0) return this.getDirectChatById(id);

    params.push(id);
    this.db.prepare(`UPDATE channels SET ${clauses.join(', ')} WHERE id = ?`).run(...params);
    return this.getDirectChatById(id);
  }

  /** Chat-shaped archive: same SQL as `archive`, Chat projection returned. */
  archiveDirectChat(id: string): Chat | null {
    this.db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(Date.now(), id);
    return this.getDirectChatById(id);
  }

  unarchiveDirectChat(id: string): Chat | null {
    this.db.prepare('UPDATE channels SET archived_at = NULL WHERE id = ?').run(id);
    return this.getDirectChatById(id);
  }

  private mapRowToChat(
    row: ChatRow,
    options: { includeMessages?: boolean; includeParticipants?: boolean; messageLimit?: number } = {}
  ): Chat {
    const includeMessages = options.includeMessages ?? false;
    const includeParticipants = options.includeParticipants ?? false;
    const messageLimit = options.messageLimit ?? 50;
    return {
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      participants: includeParticipants ? this.getParticipants(row.id) : [],
      messages: includeMessages ? this.getMessagesByChatId(row.id, messageLimit) : [],
      createdAt: row.created_at,
      archivedAt: row.archived_at || undefined,
      tags: row.tags || undefined,
      lastMessageAt: row.last_message_at || undefined,
      userPersona: row.user_persona || undefined,
      pinned: !!row.pinned,
      folderId: row.folder_id ?? undefined,
    };
  }

  /**
   * Get messages for a direct chat with optional limit (ChatMessage shape).
   * Hides messages on archived branches by default — every production caller
   * (renderer view, agent history, markdown export, messaging bridge) treats
   * the active branch as canonical. Pass `activeOnly: false` only when a tool
   * legitimately needs to see abandoned regenerations (none today).
   */
  getMessagesByChatId(chatId: string, limit?: number, options: { activeOnly?: boolean } = {}): ChatMessage[] {
    if (!this.gateSingleAgentOnly(chatId, 'getMessagesByChatId', 'warn')) return [];
    const activeOnly = options.activeOnly ?? true;
    const messages = queryMessages<ChatMessageRow>(this.db, CHAT_MSG_CONFIG, chatId, this.rowToChatMessage, limit, activeOnly) as ChatMessage[];
    this.attachBranchCounts(chatId, messages);
    return messages;
  }

  /**
   * Mutates each message in `messages` to set `branchCount` — the total number
   * of siblings (including itself, including archived) under its parent. The
   * renderer uses this to decide whether to render a regenerate carousel.
   * Single GROUP BY across the chat — fewer queries than per-message lookup.
   */
  private attachBranchCounts(chatId: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    const rows = this.db.prepare(`
      SELECT parent_message_id, COUNT(*) AS count
      FROM messages
      WHERE channel_id = ?
      GROUP BY parent_message_id
    `).all(chatId) as Array<{ parent_message_id: string | null; count: number }>;

    const countByParent = new Map<string | null, number>();
    for (const row of rows) {
      countByParent.set(row.parent_message_id, row.count);
    }
    for (const msg of messages) {
      // Root-level rows (NULL parent) are not siblings of each other — a
      // chat's opening message and any rows imported without a resolvable
      // parent (see `bulkCreateDirectMessages`) would otherwise count as
      // mutual "variants" and grow a phantom regenerate carousel.
      msg.branchCount = msg.parentMessageId
        ? countByParent.get(msg.parentMessageId) ?? 1
        : 1;
    }
  }

  private rowToChatMessage = (row: ChatMessageRow): ChatMessage => ({
    ...mapBaseMessageFields(row, 'chatMessage'),
    // Projected over the `messages` table: the container column is `channel_id`.
    chatId: row.channel_id as string,
    senderType: row.sender_type as ChatMessage['senderType'],
  });

  /**
   * Create a direct-chat message. Pinned storage-event contract: emits
   * exactly one message:created with context 'chat', a chatId key (never
   * channelId), and isDraft always false — chat messages have no draft
   * lifecycle. Also bumps the chat's last_message_at.
   */
  createDirectMessage(message: Omit<ChatMessage, 'id'>): ChatMessage {
    const id = insertMessage(this.db, CHAT_MSG_CONFIG, message, message.chatId);
    const displayName = message.senderDisplayName ?? message.senderId;

    this.db.prepare('UPDATE channels SET last_message_at = ? WHERE id = ?').run(message.timestamp, message.chatId);

    const result: ChatMessage = {
      id,
      ...message,
      senderDisplayName: displayName,
      senderColor: message.senderColor ?? undefined,
      metadata: message.metadata,
    };

    eventBus.emitEvent('message:created', {
      id,
      chatId: message.chatId,
      senderId: message.senderId,
      senderType: message.senderType,
      senderDisplayName: displayName,
      content: message.content,
      timestamp: message.timestamp,
      metadata: message.metadata,
      context: 'chat',
      // ChatMessage has no draft lifecycle (CHAT_MSG_CONFIG writes no
      // is_draft), so chat messages are never created as drafts.
      isDraft: false,
    });

    return result;
  }

  /**
   * Create multiple direct-chat messages in a single transaction. Import-
   * oriented two-pass insert: rows land with NULL parent_message_id first,
   * then parents are remapped through `idMapping` (originalId → new id) so
   * imported/duplicated trees keep their branch structure. Event-silent —
   * bulk import must never reach the dispatcher or side services.
   * @returns Array of created message IDs in the same order
   */
  bulkCreateDirectMessages(messages: Omit<ChatMessage, 'id'>[], options?: { idMapping?: Map<string, string> }): string[] {
    if (messages.length === 0) return [];

    const createdIds: string[] = [];
    const idMapping = options?.idMapping || new Map<string, string>();

    const insertStmt = this.db.prepare(`
      INSERT INTO messages (
        id, channel_id, sender_id, sender_type, sender_display_name, sender_color,
        metadata, metrics, content, timestamp, tool_calls, content_blocks,
        response_messages_json,
        parent_message_id, branch_index, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateParentStmt = this.db.prepare(`
      UPDATE messages SET parent_message_id = ? WHERE id = ?
    `);

    const bulkInsert = this.db.transaction((messagesToInsert: Omit<ChatMessage, 'id'>[]) => {
      let latestTimestamp = 0;
      let chatIdToUpdate: string | null = null;

      // PASS 1: Insert all messages with parent_message_id = NULL
      // and build complete ID mapping (old ChatGPT IDs -> new Enclave UUIDs)
      for (const message of messagesToInsert) {
        // Use provided ID if available (for imports), otherwise generate new one
        const id = (message as any).id || `chatmsg-${randomUUID()}`;
        const displayName = message.senderDisplayName ?? message.senderId;
        const senderColor = message.senderColor ?? null;
        const metadata = message.metadata ? JSON.stringify(message.metadata) : null;
        const metrics = message.metrics ? JSON.stringify(message.metrics) : null;

        // Store mapping for this message (old ID -> new ID)
        if ((message as any).originalId) {
          idMapping.set((message as any).originalId, id);
        }

        // Insert with NULL parent_message_id temporarily to avoid FK constraint
        insertStmt.run(
          id,
          message.chatId,
          message.senderId,
          message.senderType,
          displayName,
          senderColor,
          metadata,
          metrics,
          message.content,
          message.timestamp,
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
          message.responseMessages ? JSON.stringify(message.responseMessages) : null,
          null, // parent_message_id — temporarily NULL, set in Pass 2
          message.branchIndex ?? 0,
          message.status || 'active'
        );

        createdIds.push(id);

        // Track latest timestamp for updating chat
        if (message.timestamp > latestTimestamp) {
          latestTimestamp = message.timestamp;
          chatIdToUpdate = message.chatId;
        }
      }

      // PASS 2: Update parent_message_id with mapped IDs
      // Now all messages exist, so FK constraints will succeed
      let orphanedCount = 0;
      let mappedCount = 0;

      for (let i = 0; i < messagesToInsert.length; i++) {
        const message = messagesToInsert[i];
        const id = createdIds[i];

        if (message.parentMessageId) {
          // Try to map the parent ID (for imports with originalId)
          const mappedParentId = idMapping.get(message.parentMessageId);

          if (mappedParentId) {
            // Valid mapping found - set the parent
            updateParentStmt.run(mappedParentId, id);
            mappedCount++;
          } else {
            orphanedCount++;
          }
        }
      }

      if (orphanedCount > 0) {
        logger.info(`Bulk insert: ${mappedCount} parent links created, ${orphanedCount} orphaned messages`);
      }

      // Update last_message_at for the chat
      if (chatIdToUpdate && latestTimestamp > 0) {
        // Normalize timestamp to milliseconds (handle microseconds from bad imports)
        let normalizedTimestamp = latestTimestamp;
        if (normalizedTimestamp > 10000000000000) {
          normalizedTimestamp = Math.floor(normalizedTimestamp / 1000);
        }
        this.db.prepare('UPDATE channels SET last_message_at = ? WHERE id = ?')
          .run(normalizedTimestamp, chatIdToUpdate);
      }
    });

    bulkInsert(messages);

    return createdIds;
  }

  // ---------------------------------------------------------------------------
  // Branch-aware operations (direct channels only)
  //
  // The chat is a tree of messages: each row links to its parent via
  // parent_message_id, and `branch_index` distinguishes siblings created by
  // regeneration. Exactly one child per parent is `status='active'`; the rest
  // are `archived`. The visible conversation is the active path from root.
  // These methods preserve that invariant. All of them are gated to
  // type='direct' channels — see the section header above for the
  // throw-vs-warn split.
  // ---------------------------------------------------------------------------

  /**
   * Returns the id of the most recent active message in the chat, or null
   * if the chat is empty. Used at message-insert time to default
   * parent_message_id to the message being responded to — that's what makes
   * `getSiblings` and the branch-count computation correctly identify
   * regenerations as variants of the same turn.
   */
  getLatestActiveMessageId(chatId: string): string | null {
    if (!this.gateSingleAgentOnly(chatId, 'getLatestActiveMessageId', 'warn')) return null;
    const row = this.db.prepare(
      `SELECT id FROM messages
       WHERE channel_id = ? AND status = 'active'
       ORDER BY timestamp DESC LIMIT 1`
    ).get(chatId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Returns siblings of the given message (rows sharing its parent_message_id
   * within the same chat), ordered by branch_index. Includes archived siblings
   * and the message itself. Empty array if the message doesn't exist or lives
   * in a non-direct channel.
   */
  getSiblings(messageId: string): ChatMessage[] {
    const target = this.db.prepare(
      'SELECT channel_id, parent_message_id FROM messages WHERE id = ?'
    ).get(messageId) as { channel_id: string; parent_message_id: string | null } | undefined;
    if (!target) return [];
    if (!this.gateSingleAgentOnly(target.channel_id, 'getSiblings', 'warn')) return [];

    const rows = target.parent_message_id === null
      ? this.db.prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND parent_message_id IS NULL
           ORDER BY branch_index ASC, timestamp ASC`
        ).all(target.channel_id) as ChatMessageRow[]
      : this.db.prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND parent_message_id = ?
           ORDER BY branch_index ASC, timestamp ASC`
        ).all(target.channel_id, target.parent_message_id) as ChatMessageRow[];

    return rows.map(this.rowToChatMessage);
  }

  /**
   * Returns max(branch_index) + 1 across siblings under the given parent in
   * the chat. 0 when there are no siblings yet — the first branch.
   */
  getNextBranchIndex(chatId: string, parentMessageId: string | null): number {
    if (!this.gateSingleAgentOnly(chatId, 'getNextBranchIndex', 'warn')) return 0;
    const row = parentMessageId === null
      ? this.db.prepare(
          'SELECT MAX(branch_index) AS max_idx FROM messages WHERE channel_id = ? AND parent_message_id IS NULL'
        ).get(chatId) as { max_idx: number | null } | undefined
      : this.db.prepare(
          'SELECT MAX(branch_index) AS max_idx FROM messages WHERE channel_id = ? AND parent_message_id = ?'
        ).get(chatId, parentMessageId) as { max_idx: number | null } | undefined;

    return row?.max_idx === null || row?.max_idx === undefined ? 0 : row.max_idx + 1;
  }

  /**
   * BFS-archive: marks `messageId` and every currently-active descendant as
   * archived. Stops descending when it hits an already-archived row (its
   * subtree was archived in a prior operation, so leaving it alone preserves
   * historical "what the user saw on this branch" state).
   * Returns IDs that were actually flipped from active to archived.
   */
  private archiveSubtreeIfActive(messageId: string): string[] {
    const archived: string[] = [];
    const queue: string[] = [messageId];
    const updateStmt = this.db.prepare(
      `UPDATE messages SET status = 'archived' WHERE id = ? AND status = 'active'`
    );
    const childrenStmt = this.db.prepare(
      `SELECT id FROM messages WHERE parent_message_id = ? AND status = 'active'`
    );

    while (queue.length > 0) {
      const id = queue.shift()!;
      const result = updateStmt.run(id);
      if (result.changes === 0) continue;
      archived.push(id);
      const children = childrenStmt.all(id) as { id: string }[];
      for (const child of children) queue.push(child.id);
    }

    return archived;
  }

  /**
   * Prepares a chat for a regenerated reply. Archives the target message and
   * its currently-active descendants so they don't bleed into the active
   * path, then returns the parent linkage and the next free branch_index for
   * the new sibling the caller is about to insert. Transactional. Throws on
   * a missing message or a non-direct channel (mutating op — fail loudly).
   */
  regenerateFrom(messageId: string): {
    archivedIds: string[];
    parentMessageId: string | null;
    nextBranchIndex: number;
    chatId: string;
  } {
    let result: {
      archivedIds: string[];
      parentMessageId: string | null;
      nextBranchIndex: number;
      chatId: string;
    } | null = null;

    this.db.transaction(() => {
      const target = this.db.prepare(
        'SELECT channel_id, parent_message_id FROM messages WHERE id = ?'
      ).get(messageId) as { channel_id: string; parent_message_id: string | null } | undefined;
      if (!target) throw new Error(`regenerateFrom: message ${messageId} not found`);
      this.gateSingleAgentOnly(target.channel_id, 'regenerateFrom', 'throw');

      const archivedIds = this.archiveSubtreeIfActive(messageId);
      const nextBranchIndex = this.getNextBranchIndex(target.channel_id, target.parent_message_id);

      result = {
        archivedIds,
        parentMessageId: target.parent_message_id,
        nextBranchIndex,
        chatId: target.channel_id,
      };
    })();

    return result!;
  }

  /**
   * Promotes the path through `messageId` to active, restoring whatever
   * descendant exploration we can reasonably guess at.
   *
   * Walk up: at each ancestor, archive the currently-active sibling subtree
   * and activate the path-self. (Archiving the *subtree* — not just the
   * sibling row — is essential, otherwise that sibling's still-active
   * descendants leak into the visible chain.)
   *
   * Walk down: from `messageId`, follow the child with the highest
   * branch_index at each step and activate it. Highest-branch_index ≈ "most
   * recently created variant", which is the best heuristic available without
   * an explicit last-active timestamp. The user can manually re-swipe at any
   * level to find a different historical exploration.
   *
   * Transactional. No-op if the message is already on the active path AND
   * has no off-path active descendants under siblings, but still safe to call.
   * Throws on a missing message or a non-direct channel (mutating op).
   */
  switchActiveBranch(messageId: string): void {
    this.db.transaction(() => {
      const target = this.db.prepare(
        'SELECT channel_id FROM messages WHERE id = ?'
      ).get(messageId) as { channel_id: string } | undefined;
      if (!target) throw new Error(`switchActiveBranch: message ${messageId} not found`);
      this.gateSingleAgentOnly(target.channel_id, 'switchActiveBranch', 'throw');
      const chatId = target.channel_id;

      const activateStmt = this.db.prepare(
        `UPDATE messages SET status = 'active' WHERE id = ?`
      );

      // Walk up: from messageId to root, activating each ancestor and
      // archiving any displaced sibling's subtree.
      let current: string | null = messageId;
      while (current !== null) {
        const row = this.db.prepare(
          'SELECT parent_message_id FROM messages WHERE id = ?'
        ).get(current) as { parent_message_id: string | null } | undefined;
        if (!row) break;

        const siblings = row.parent_message_id === null
          ? this.db.prepare(
              `SELECT id FROM messages
               WHERE channel_id = ? AND parent_message_id IS NULL AND id != ? AND status = 'active'`
            ).all(chatId, current) as { id: string }[]
          : this.db.prepare(
              `SELECT id FROM messages
               WHERE channel_id = ? AND parent_message_id = ? AND id != ? AND status = 'active'`
            ).all(chatId, row.parent_message_id, current) as { id: string }[];

        for (const sib of siblings) this.archiveSubtreeIfActive(sib.id);
        activateStmt.run(current);

        current = row.parent_message_id;
      }

      // Walk down: pick the highest-branch_index child at each level and
      // activate it, archiving any other active children's subtrees.
      const winnerStmt = this.db.prepare(
        `SELECT id FROM messages WHERE parent_message_id = ?
         ORDER BY branch_index DESC, timestamp DESC LIMIT 1`
      );
      const otherActiveChildrenStmt = this.db.prepare(
        `SELECT id FROM messages
         WHERE parent_message_id = ? AND id != ? AND status = 'active'`
      );

      current = messageId;
      while (current !== null) {
        const winner = winnerStmt.get(current) as { id: string } | undefined;
        if (!winner) break;

        const others = otherActiveChildrenStmt.all(current, winner.id) as { id: string }[];
        for (const other of others) this.archiveSubtreeIfActive(other.id);
        activateStmt.run(winner.id);

        current = winner.id;
      }
    })();
  }
}
