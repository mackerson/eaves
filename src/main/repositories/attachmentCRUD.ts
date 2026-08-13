import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { MessageAttachment } from '../types';
import { safeJsonParseOptional } from '../utils/safeJson';
import { AttachmentRow } from './row-types';

// Helpers over the single message_attachments table. Attachments hang off
// `messages` rows regardless of whether the parent channel is a direct chat or
// a group channel, so one table and one repository
// (MessageAttachmentRepository) cover both surfaces.

export function mapAttachmentRow(row: AttachmentRow): MessageAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    originalPath: row.original_path || undefined,
    storedPath: row.stored_path,
    mimeType: row.mime_type,
    size: row.size,
    attachmentType: row.attachment_type as MessageAttachment['attachmentType'],
    metadata: safeJsonParseOptional(row.metadata, `attachment:${row.id}:metadata`),
    createdAt: row.created_at,
  };
}

export function queryAttachmentsByMessageId(
  db: Database.Database,
  messageId: string,
): MessageAttachment[] {
  const rows = db.prepare(`
    SELECT * FROM message_attachments
    WHERE message_id = ?
    ORDER BY created_at ASC
  `).all(messageId) as AttachmentRow[];

  return rows.map(row => mapAttachmentRow(row));
}

export function queryAttachmentById(
  db: Database.Database,
  id: string,
): MessageAttachment | null {
  const row = db.prepare(
    'SELECT * FROM message_attachments WHERE id = ?'
  ).get(id) as AttachmentRow | undefined;

  return row ? mapAttachmentRow(row) : null;
}

export function queryAttachmentByAssetPointer(
  db: Database.Database,
  assetPointer: string,
): MessageAttachment | null {
  const row = db.prepare(`
    SELECT * FROM message_attachments
    WHERE json_extract(metadata, '$.asset_pointer') = ?
    LIMIT 1
  `).get(assetPointer) as AttachmentRow | undefined;

  return row ? mapAttachmentRow(row) : null;
}

export function insertAttachment(
  db: Database.Database,
  attachment: Omit<MessageAttachment, 'id' | 'createdAt'>,
): MessageAttachment {
  const id = `att-${randomUUID()}`;
  const createdAt = Date.now();

  db.prepare(`
    INSERT INTO message_attachments (
      id, message_id, filename, original_path, stored_path,
      mime_type, size, attachment_type, metadata, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    attachment.messageId,
    attachment.filename,
    attachment.originalPath || null,
    attachment.storedPath,
    attachment.mimeType,
    attachment.size,
    attachment.attachmentType,
    attachment.metadata ? JSON.stringify(attachment.metadata) : null,
    createdAt,
  );

  return { id, ...attachment, createdAt };
}

export function bulkInsertAttachments(
  db: Database.Database,
  attachments: Omit<MessageAttachment, 'id' | 'createdAt'>[],
): string[] {
  if (attachments.length === 0) return [];

  const createdIds: string[] = [];
  const insertStmt = db.prepare(`
    INSERT INTO message_attachments (
      id, message_id, filename, original_path, stored_path,
      mime_type, size, attachment_type, metadata, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const bulkInsert = db.transaction((toInsert: Omit<MessageAttachment, 'id' | 'createdAt'>[]) => {
    for (const att of toInsert) {
      const id = `att-${randomUUID()}`;
      insertStmt.run(
        id, att.messageId, att.filename, att.originalPath || null,
        att.storedPath, att.mimeType, att.size, att.attachmentType,
        att.metadata ? JSON.stringify(att.metadata) : null, Date.now(),
      );
      createdIds.push(id);
    }
  });

  bulkInsert(attachments);
  return createdIds;
}

export function deleteAttachment(
  db: Database.Database,
  id: string,
): boolean {
  return db.prepare('DELETE FROM message_attachments WHERE id = ?').run(id).changes > 0;
}

export function deleteAttachmentsByMessageId(
  db: Database.Database,
  messageId: string,
): number {
  return db.prepare('DELETE FROM message_attachments WHERE message_id = ?').run(messageId).changes;
}

export function updateAttachmentMetadata(
  db: Database.Database,
  id: string,
  metadata: Record<string, any>,
): boolean {
  return db.prepare('UPDATE message_attachments SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), id).changes > 0;
}
