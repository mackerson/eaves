import Database from 'better-sqlite3';
import { MessageAttachment } from '../types';
import { getDatabase } from '../services/database';
import {
  queryAttachmentsByMessageId,
  queryAttachmentById,
  queryAttachmentByAssetPointer,
  insertAttachment,
  bulkInsertAttachments,
  deleteAttachment,
  deleteAttachmentsByMessageId,
  updateAttachmentMetadata,
} from './attachmentCRUD';

// The one attachment repository. Attachments hang off `messages` rows
// regardless of whether the parent channel is a direct chat or a group
// channel, so a single table (message_attachments) and a single repository
// serve both surfaces — a parallel chat-side projection would be identical
// code over identical rows.
export class MessageAttachmentRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  getByMessageId(messageId: string): MessageAttachment[] {
    return queryAttachmentsByMessageId(this.db, messageId);
  }

  getById(id: string): MessageAttachment | null {
    return queryAttachmentById(this.db, id);
  }

  getByAssetPointer(assetPointer: string): MessageAttachment | null {
    return queryAttachmentByAssetPointer(this.db, assetPointer);
  }

  create(attachment: Omit<MessageAttachment, 'id' | 'createdAt'>): MessageAttachment {
    return insertAttachment(this.db, attachment);
  }

  bulkCreate(attachments: Omit<MessageAttachment, 'id' | 'createdAt'>[]): string[] {
    return bulkInsertAttachments(this.db, attachments);
  }

  delete(id: string): boolean {
    return deleteAttachment(this.db, id);
  }

  deleteByMessageId(messageId: string): number {
    return deleteAttachmentsByMessageId(this.db, messageId);
  }

  updateMetadata(id: string, metadata: Record<string, any>): boolean {
    return updateAttachmentMetadata(this.db, id, metadata);
  }

  updateFile(id: string, updates: { storedPath: string; filename: string; size: number; mimeType: string }): boolean {
    const result = this.db.prepare(`
      UPDATE message_attachments
      SET stored_path = ?, filename = ?, size = ?, mime_type = ?
      WHERE id = ?
    `).run(updates.storedPath, updates.filename, updates.size, updates.mimeType, id);
    return result.changes > 0;
  }
}
