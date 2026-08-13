import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { BaseMessage } from '../types';
import { safeJsonParseOptional } from '../utils/safeJson';

export interface MessageTableConfig {
  tableName: string;         // 'messages' — one table for channels and chats
  containerIdColumn: string; // 'channel_id'
  idPrefix: string;          // 'msg-' | 'chatmsg-'
  extraColumns?: string[];   // e.g. ['is_draft'] for channel messages
}

interface BaseRow {
  id: string;
  sender_id: string;
  sender_type: string;
  sender_display_name: string;
  sender_color: string | null;
  content: string;
  timestamp: number;
  tool_calls: string | null;
  content_blocks: string | null;
  response_messages_json: string | null;
  metadata: string | null;
  metrics: string | null;
  parent_message_id: string | null;
  branch_index: number | null;
  status: string | null;
  [key: string]: unknown;
}

export function queryMessages<TRow extends BaseRow>(
  db: Database.Database,
  config: MessageTableConfig,
  containerId: string,
  mapRow: (row: TRow) => unknown,
  limit?: number,
  activeOnly?: boolean,
): unknown[] {
  const { tableName, containerIdColumn } = config;
  // activeOnly hides messages on archived branches — used by the conversation
  // view + agent context so regenerated/abandoned branches don't bleed in.
  // `status` carries a schema-level default of 'active', so the filter can
  // compare it directly without coalescing NULLs.
  const statusFilter = activeOnly ? ` AND status = 'active'` : '';
  if (limit) {
    const rows = db.prepare(
      `SELECT * FROM ${tableName} WHERE ${containerIdColumn} = ?${statusFilter} ORDER BY timestamp DESC LIMIT ?`
    ).all(containerId, limit) as TRow[];
    return rows.map(mapRow).reverse();
  }
  const rows = db.prepare(
    `SELECT * FROM ${tableName} WHERE ${containerIdColumn} = ?${statusFilter} ORDER BY timestamp ASC`
  ).all(containerId) as TRow[];
  return rows.map(mapRow);
}

export function mapBaseMessageFields(row: BaseRow, label: string): Omit<BaseMessage, 'id'> & { id: string } {
  return {
    id: row.id,
    senderId: row.sender_id,
    senderDisplayName: row.sender_display_name || row.sender_id,
    senderColor: row.sender_color || undefined,
    metadata: safeJsonParseOptional<Record<string, any>>(row.metadata, `${label}:${row.id}:metadata`),
    metrics: safeJsonParseOptional<BaseMessage['metrics']>(row.metrics, `${label}:${row.id}:metrics`),
    content: row.content,
    timestamp: row.timestamp,
    toolCalls: safeJsonParseOptional<BaseMessage['toolCalls']>(row.tool_calls, `${label}:${row.id}:toolCalls`),
    contentBlocks: safeJsonParseOptional<BaseMessage['contentBlocks']>(row.content_blocks, `${label}:${row.id}:contentBlocks`),
    responseMessages: safeJsonParseOptional<BaseMessage['responseMessages']>(row.response_messages_json, `${label}:${row.id}:responseMessages`),
    parentMessageId: row.parent_message_id || undefined,
    branchIndex: row.branch_index ?? 0,
    status: (row.status || 'active') as BaseMessage['status'],
  };
}

export function insertMessage(
  db: Database.Database,
  config: MessageTableConfig,
  message: Omit<BaseMessage, 'id'> & { [key: string]: unknown },
  containerId: string,
): string {
  const id = `${config.idPrefix}${randomUUID()}`;
  const displayName = message.senderDisplayName ?? message.senderId;
  const senderColor = message.senderColor ?? null;
  const metadata = message.metadata ? JSON.stringify(message.metadata) : null;
  const metrics = message.metrics ? JSON.stringify(message.metrics) : null;

  const columns = [
    'id', config.containerIdColumn, 'sender_id', 'sender_type', 'sender_display_name', 'sender_color',
    'metadata', 'metrics', 'content', 'timestamp', 'tool_calls', 'content_blocks',
    'response_messages_json',
    'parent_message_id', 'branch_index', 'status',
    ...(config.extraColumns ?? []),
  ];
  const placeholders = columns.map(() => '?').join(', ');

  const values: unknown[] = [
    id, containerId, message.senderId, message.senderType, displayName, senderColor,
    metadata, metrics, message.content, message.timestamp,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
    message.responseMessages ? JSON.stringify(message.responseMessages) : null,
    message.parentMessageId || null,
    message.branchIndex ?? 0,
    message.status || 'active',
  ];

  // Append extra column values
  for (const col of config.extraColumns ?? []) {
    if (col === 'is_draft') {
      values.push(message.isDraft ? 1 : 0);
    }
  }

  db.prepare(`INSERT INTO ${config.tableName} (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);

  return id;
}

export function bulkInsertMessages(
  db: Database.Database,
  config: MessageTableConfig,
  messages: Array<Omit<BaseMessage, 'id'> & { [key: string]: unknown }>,
  getContainerId: (msg: any) => string,
): string[] {
  if (messages.length === 0) return [];

  const columns = [
    'id', config.containerIdColumn, 'sender_id', 'sender_type', 'sender_display_name', 'sender_color',
    'metadata', 'metrics', 'content', 'timestamp', 'tool_calls', 'content_blocks',
    'response_messages_json',
    'parent_message_id', 'branch_index', 'status',
  ];
  const placeholders = columns.map(() => '?').join(', ');

  const insertStmt = db.prepare(
    `INSERT INTO ${config.tableName} (${columns.join(', ')}) VALUES (${placeholders})`
  );

  const createdIds: string[] = [];

  const bulkInsert = db.transaction((msgs: typeof messages) => {
    for (const message of msgs) {
      const id = `${config.idPrefix}${randomUUID()}`;
      const displayName = message.senderDisplayName ?? message.senderId;
      const senderColor = message.senderColor ?? null;
      const metadata = message.metadata ? JSON.stringify(message.metadata) : null;
      const metrics = message.metrics ? JSON.stringify(message.metrics) : null;

      insertStmt.run(
        id, getContainerId(message),
        message.senderId, message.senderType, displayName, senderColor,
        metadata, metrics, message.content, message.timestamp,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
        message.responseMessages ? JSON.stringify(message.responseMessages) : null,
        message.parentMessageId || null,
        message.branchIndex ?? 0,
        message.status || 'active',
      );

      createdIds.push(id);
    }
  });

  bulkInsert(messages);
  return createdIds;
}

export function deleteMessage(db: Database.Database, config: MessageTableConfig, messageId: string): boolean {
  const result = db.prepare(`DELETE FROM ${config.tableName} WHERE id = ?`).run(messageId);
  return result.changes > 0;
}

/**
 * Update a message's text after a user edit, keeping content_blocks in sync.
 *
 * The renderer displays content_blocks when present, so editing only the
 * content column would leave the old text visible forever. The first text
 * block is rewritten in place; non-text blocks (attachments) are preserved.
 * Rows stored without blocks keep content_blocks NULL and render via content.
 */
export function updateMessageText(
  db: Database.Database,
  config: MessageTableConfig,
  messageId: string,
  content: string,
): { contentBlocks: any[] | null } | null {
  const row = db
    .prepare(`SELECT content_blocks FROM ${config.tableName} WHERE id = ?`)
    .get(messageId) as { content_blocks: string | null } | undefined;
  if (!row) return null;

  let blocks: any[] | null = null;
  if (row.content_blocks) {
    blocks = safeJsonParseOptional<any[]>(row.content_blocks, `updateMessageText:${messageId}`) ?? [];
    const textIdx = blocks.findIndex((b) => b?.type === 'text');
    if (textIdx >= 0) {
      blocks[textIdx] = { ...blocks[textIdx], content };
    } else {
      blocks.unshift({ type: 'text', content });
    }
  }

  db.prepare(`UPDATE ${config.tableName} SET content = ?, content_blocks = ? WHERE id = ?`)
    .run(content, blocks ? JSON.stringify(blocks) : null, messageId);
  return { contentBlocks: blocks };
}
