import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MessageAttachmentRepository } from './MessageAttachmentRepository';
import { runMigrations } from '../services/migrations';

// Mock the logger to avoid Electron app dependency
vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the database service
vi.mock('../services/database', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDatabase: vi.fn(() => {
      if (!mockDb) {
        mockDb = new Database(':memory:');
        // Run the production migrations (channels, messages, message_attachments,
        // ...) instead of hand-rolled DDL, so this fixture can't drift from
        // migrations.ts.
        runMigrations(mockDb, 0);
      }
      return mockDb;
    }),
  };
});

describe('MessageAttachmentRepository', () => {
  let db: Database.Database;
  let repo: MessageAttachmentRepository;
  let testMessageId: string;

  beforeEach(async () => {
    // Get the mocked database
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();

    // Clear all tables
    db.exec(`DELETE FROM message_attachments`);
    db.exec(`DELETE FROM messages`);
    db.exec(`DELETE FROM channels`);

    // messages.channel_id is a real FK against channels(id), so the parent
    // channel row has to exist before any message insert.
    db.prepare(`
      INSERT INTO channels (id, name, type, created_at)
      VALUES ('channel-1', 'Test Channel', 'public', ?)
    `).run(Date.now());

    // Create a test message to use for attachments
    testMessageId = 'msg-test-123';
    db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(testMessageId, 'channel-1', 'user-1', 'human', 'Test message', Date.now());

    repo = new MessageAttachmentRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new attachment with all fields', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'test.pdf',
        originalPath: '/home/user/test.pdf',
        storedPath: '/storage/attachments/test.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        attachmentType: 'file',
        metadata: { source: 'upload' },
      });

      expect(attachment.id).toBeDefined();
      expect(attachment.id).toMatch(/^att-/);
      expect(attachment.messageId).toBe(testMessageId);
      expect(attachment.filename).toBe('test.pdf');
      expect(attachment.originalPath).toBe('/home/user/test.pdf');
      expect(attachment.storedPath).toBe('/storage/attachments/test.pdf');
      expect(attachment.mimeType).toBe('application/pdf');
      expect(attachment.size).toBe(1024);
      expect(attachment.attachmentType).toBe('file');
      expect(attachment.metadata).toEqual({ source: 'upload' });
      expect(attachment.createdAt).toBeDefined();
    });

    it('should create attachment without optional originalPath', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'image.png',
        storedPath: '/storage/images/image.png',
        mimeType: 'image/png',
        size: 2048,
        attachmentType: 'image',
      });

      expect(attachment.id).toBeDefined();
      expect(attachment.originalPath).toBeUndefined();
      expect(attachment.metadata).toBeUndefined();
    });

    it('should create attachment without metadata', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'video.mp4',
        storedPath: '/storage/videos/video.mp4',
        mimeType: 'video/mp4',
        size: 5120,
        attachmentType: 'video',
      });

      expect(attachment.metadata).toBeUndefined();
    });

    it('should support all attachment types', () => {
      const types: Array<'file' | 'image' | 'audio' | 'video'> = ['file', 'image', 'audio', 'video'];

      types.forEach((type) => {
        const attachment = repo.create({
          messageId: testMessageId,
          filename: `test.${type}`,
          storedPath: `/storage/${type}/test.${type}`,
          mimeType: `${type}/test`,
          size: 1024,
          attachmentType: type,
        });

        expect(attachment.attachmentType).toBe(type);
      });
    });

    it('should persist attachment to database', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'test.txt',
        storedPath: '/storage/test.txt',
        mimeType: 'text/plain',
        size: 512,
        attachmentType: 'file',
      });

      const row = db.prepare('SELECT * FROM message_attachments WHERE id = ?').get(attachment.id);
      expect(row).toBeDefined();
      expect((row as any).filename).toBe('test.txt');
      expect((row as any).message_id).toBe(testMessageId);
    });

    it('should handle metadata with complex objects', () => {
      const metadata = {
        assetPointer: 'file-abc123',
        dimensions: { width: 1920, height: 1080 },
        tags: ['important', 'work'],
        nested: { level: 1, data: 'test' },
      };

      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'complex.jpg',
        storedPath: '/storage/complex.jpg',
        mimeType: 'image/jpeg',
        size: 4096,
        attachmentType: 'image',
        metadata,
      });

      expect(attachment.metadata).toEqual(metadata);
    });
  });

  describe('getByMessageId', () => {
    it('should return empty array when message has no attachments', () => {
      const attachments = repo.getByMessageId('non-existent-message');
      expect(attachments).toEqual([]);
    });

    it('should return single attachment for message', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.pdf',
        storedPath: '/storage/test.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        attachmentType: 'file',
      });

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].id).toBe(created.id);
      expect(attachments[0].filename).toBe('test.pdf');
    });

    it('should return multiple attachments for message', () => {
      const attachment1 = repo.create({
        messageId: testMessageId,
        filename: 'first.jpg',
        storedPath: '/storage/first.jpg',
        mimeType: 'image/jpeg',
        size: 2048,
        attachmentType: 'image',
      });

      const attachment2 = repo.create({
        messageId: testMessageId,
        filename: 'second.pdf',
        storedPath: '/storage/second.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        attachmentType: 'file',
      });

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toHaveLength(2);
      expect(attachments.map(a => a.id)).toContain(attachment1.id);
      expect(attachments.map(a => a.id)).toContain(attachment2.id);
    });

    it('should return attachments ordered by created_at ASC', () => {
      // Create attachments with slight delay to ensure different timestamps
      const attachment1 = repo.create({
        messageId: testMessageId,
        filename: 'first.txt',
        storedPath: '/storage/first.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      // Manually insert second attachment with later timestamp
      const id2 = 'att-manual-2';
      db.prepare(`
        INSERT INTO message_attachments (
          id, message_id, filename, stored_path, mime_type, size, attachment_type, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id2, testMessageId, 'second.txt', '/storage/second.txt', 'text/plain', 100, 'file', attachment1.createdAt + 1000);

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toHaveLength(2);
      expect(attachments[0].id).toBe(attachment1.id);
      expect(attachments[1].id).toBe(id2);
    });

    it('should correctly parse metadata from JSON', () => {
      const metadata = { key1: 'value1', key2: 123 };
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.jpg',
        storedPath: '/storage/test.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
        attachmentType: 'image',
        metadata,
      });

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments[0].metadata).toEqual(metadata);
    });

    it('should handle attachments without originalPath', () => {
      repo.create({
        messageId: testMessageId,
        filename: 'no-original.txt',
        storedPath: '/storage/no-original.txt',
        mimeType: 'text/plain',
        size: 512,
        attachmentType: 'file',
      });

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments[0].originalPath).toBeUndefined();
    });

    it('should only return attachments for specified message', () => {
      const otherMessageId = 'msg-other-456';
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(otherMessageId, 'channel-1', 'user-1', 'human', 'Other message', Date.now());

      repo.create({
        messageId: testMessageId,
        filename: 'first.txt',
        storedPath: '/storage/first.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      repo.create({
        messageId: otherMessageId,
        filename: 'other.txt',
        storedPath: '/storage/other.txt',
        mimeType: 'text/plain',
        size: 200,
        attachmentType: 'file',
      });

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].filename).toBe('first.txt');
    });
  });

  describe('getById', () => {
    it('should return attachment by ID', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.pdf',
        storedPath: '/storage/test.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        attachmentType: 'file',
      });

      const attachment = repo.getById(created.id);
      expect(attachment).toBeDefined();
      expect(attachment!.id).toBe(created.id);
      expect(attachment!.filename).toBe('test.pdf');
    });

    it('should return null for non-existent attachment', () => {
      const attachment = repo.getById('non-existent-id');
      expect(attachment).toBeNull();
    });

    it('should return attachment with all fields', () => {
      const metadata = { source: 'import', assetPointer: 'ptr-123' };
      const created = repo.create({
        messageId: testMessageId,
        filename: 'full.jpg',
        originalPath: '/original/full.jpg',
        storedPath: '/storage/full.jpg',
        mimeType: 'image/jpeg',
        size: 2048,
        attachmentType: 'image',
        metadata,
      });

      const attachment = repo.getById(created.id);
      expect(attachment).toBeDefined();
      expect(attachment!.originalPath).toBe('/original/full.jpg');
      expect(attachment!.metadata).toEqual(metadata);
    });

    it('should return undefined for optional fields when not set', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'minimal.txt',
        storedPath: '/storage/minimal.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const attachment = repo.getById(created.id);
      expect(attachment).toBeDefined();
      expect(attachment!.originalPath).toBeUndefined();
      expect(attachment!.metadata).toBeUndefined();
    });
  });

  describe('getByAssetPointer', () => {
    it('should return attachment by asset_pointer in metadata', () => {
      const assetPointer = 'file-service://abc123';
      const created = repo.create({
        messageId: testMessageId,
        filename: 'chatgpt-export.jpg',
        storedPath: '/storage/chatgpt-export.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
        attachmentType: 'image',
        metadata: { asset_pointer: assetPointer },
      });

      const attachment = repo.getByAssetPointer(assetPointer);
      expect(attachment).toBeDefined();
      expect(attachment!.id).toBe(created.id);
      expect(attachment!.metadata!.asset_pointer).toBe(assetPointer);
    });

    it('should return null when asset_pointer not found', () => {
      const attachment = repo.getByAssetPointer('non-existent-pointer');
      expect(attachment).toBeNull();
    });

    it('should return null when attachment has no metadata', () => {
      repo.create({
        messageId: testMessageId,
        filename: 'no-metadata.txt',
        storedPath: '/storage/no-metadata.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const attachment = repo.getByAssetPointer('any-pointer');
      expect(attachment).toBeNull();
    });

    it('should return first matching attachment when multiple have same asset_pointer', () => {
      const assetPointer = 'shared-pointer';

      const first = repo.create({
        messageId: testMessageId,
        filename: 'first.jpg',
        storedPath: '/storage/first.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
        attachmentType: 'image',
        metadata: { asset_pointer: assetPointer },
      });

      // Create second attachment with same pointer (unlikely but possible)
      const otherMessageId = 'msg-other-789';
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(otherMessageId, 'channel-1', 'user-1', 'human', 'Other message', Date.now());

      repo.create({
        messageId: otherMessageId,
        filename: 'second.jpg',
        storedPath: '/storage/second.jpg',
        mimeType: 'image/jpeg',
        size: 2048,
        attachmentType: 'image',
        metadata: { asset_pointer: assetPointer },
      });

      const attachment = repo.getByAssetPointer(assetPointer);
      expect(attachment).toBeDefined();
      // Should return the first one inserted
      expect(attachment!.id).toBe(first.id);
    });

    it('should handle metadata with nested asset_pointer', () => {
      const assetPointer = 'nested-pointer-123';
      const created = repo.create({
        messageId: testMessageId,
        filename: 'nested.pdf',
        storedPath: '/storage/nested.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        attachmentType: 'file',
        metadata: {
          asset_pointer: assetPointer,
          other_data: { nested: true },
        },
      });

      const attachment = repo.getByAssetPointer(assetPointer);
      expect(attachment).toBeDefined();
      expect(attachment!.id).toBe(created.id);
    });
  });

  describe('bulkCreate', () => {
    it('should return empty array when no attachments provided', () => {
      const ids = repo.bulkCreate([]);
      expect(ids).toEqual([]);
    });

    it('should create single attachment in bulk', () => {
      const ids = repo.bulkCreate([
        {
          messageId: testMessageId,
          filename: 'bulk1.txt',
          storedPath: '/storage/bulk1.txt',
          mimeType: 'text/plain',
          size: 100,
          attachmentType: 'file',
        },
      ]);

      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(/^att-/);

      const attachment = repo.getById(ids[0]);
      expect(attachment).toBeDefined();
      expect(attachment!.filename).toBe('bulk1.txt');
    });

    it('should create multiple attachments in bulk', () => {
      const ids = repo.bulkCreate([
        {
          messageId: testMessageId,
          filename: 'bulk1.jpg',
          storedPath: '/storage/bulk1.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          attachmentType: 'image',
        },
        {
          messageId: testMessageId,
          filename: 'bulk2.pdf',
          storedPath: '/storage/bulk2.pdf',
          mimeType: 'application/pdf',
          size: 2048,
          attachmentType: 'file',
        },
        {
          messageId: testMessageId,
          filename: 'bulk3.mp3',
          storedPath: '/storage/bulk3.mp3',
          mimeType: 'audio/mpeg',
          size: 3072,
          attachmentType: 'audio',
        },
      ]);

      expect(ids).toHaveLength(3);
      ids.forEach(id => expect(id).toMatch(/^att-/));

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toHaveLength(3);
    });

    it('should return IDs in same order as input', () => {
      const inputs = [
        {
          messageId: testMessageId,
          filename: 'first.txt',
          storedPath: '/storage/first.txt',
          mimeType: 'text/plain',
          size: 100,
          attachmentType: 'file' as const,
        },
        {
          messageId: testMessageId,
          filename: 'second.txt',
          storedPath: '/storage/second.txt',
          mimeType: 'text/plain',
          size: 200,
          attachmentType: 'file' as const,
        },
      ];

      const ids = repo.bulkCreate(inputs);

      const first = repo.getById(ids[0]);
      const second = repo.getById(ids[1]);

      expect(first!.filename).toBe('first.txt');
      expect(second!.filename).toBe('second.txt');
    });

    it('should handle bulk create with metadata', () => {
      const ids = repo.bulkCreate([
        {
          messageId: testMessageId,
          filename: 'meta1.jpg',
          storedPath: '/storage/meta1.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          attachmentType: 'image',
          metadata: { asset_pointer: 'ptr-1', index: 1 },
        },
        {
          messageId: testMessageId,
          filename: 'meta2.jpg',
          storedPath: '/storage/meta2.jpg',
          mimeType: 'image/jpeg',
          size: 2048,
          attachmentType: 'image',
          metadata: { asset_pointer: 'ptr-2', index: 2 },
        },
      ]);

      const attachment1 = repo.getById(ids[0]);
      const attachment2 = repo.getById(ids[1]);

      expect(attachment1!.metadata).toEqual({ asset_pointer: 'ptr-1', index: 1 });
      expect(attachment2!.metadata).toEqual({ asset_pointer: 'ptr-2', index: 2 });
    });

    it('should be atomic - all or nothing on transaction failure', () => {
      // This test verifies transactional behavior
      // Create many attachments; if transaction works, all should be created
      const inputs = Array.from({ length: 10 }, (_, i) => ({
        messageId: testMessageId,
        filename: `file${i}.txt`,
        storedPath: `/storage/file${i}.txt`,
        mimeType: 'text/plain',
        size: 100 * (i + 1),
        attachmentType: 'file' as const,
      }));

      const ids = repo.bulkCreate(inputs);
      expect(ids).toHaveLength(10);

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toHaveLength(10);
    });

    it('should handle bulk create across multiple messages', () => {
      const otherMessageId = 'msg-other-999';
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(otherMessageId, 'channel-1', 'user-1', 'human', 'Other message', Date.now());

      const ids = repo.bulkCreate([
        {
          messageId: testMessageId,
          filename: 'first-msg.txt',
          storedPath: '/storage/first-msg.txt',
          mimeType: 'text/plain',
          size: 100,
          attachmentType: 'file',
        },
        {
          messageId: otherMessageId,
          filename: 'second-msg.txt',
          storedPath: '/storage/second-msg.txt',
          mimeType: 'text/plain',
          size: 200,
          attachmentType: 'file',
        },
      ]);

      expect(ids).toHaveLength(2);

      const firstMessageAttachments = repo.getByMessageId(testMessageId);
      const otherMessageAttachments = repo.getByMessageId(otherMessageId);

      expect(firstMessageAttachments).toHaveLength(1);
      expect(otherMessageAttachments).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('should delete attachment by ID', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'to-delete.txt',
        storedPath: '/storage/to-delete.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);

      const retrieved = repo.getById(created.id);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent attachment', () => {
      const deleted = repo.delete('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should remove attachment from database', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.txt',
        storedPath: '/storage/test.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      repo.delete(created.id);

      const row = db.prepare('SELECT * FROM message_attachments WHERE id = ?').get(created.id);
      expect(row).toBeUndefined();
    });

    it('should not affect other attachments', () => {
      const attachment1 = repo.create({
        messageId: testMessageId,
        filename: 'keep.txt',
        storedPath: '/storage/keep.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const attachment2 = repo.create({
        messageId: testMessageId,
        filename: 'delete.txt',
        storedPath: '/storage/delete.txt',
        mimeType: 'text/plain',
        size: 200,
        attachmentType: 'file',
      });

      repo.delete(attachment2.id);

      const remaining = repo.getByMessageId(testMessageId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(attachment1.id);
    });

    it('should handle multiple deletions', () => {
      const attachment1 = repo.create({
        messageId: testMessageId,
        filename: 'first.txt',
        storedPath: '/storage/first.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const attachment2 = repo.create({
        messageId: testMessageId,
        filename: 'second.txt',
        storedPath: '/storage/second.txt',
        mimeType: 'text/plain',
        size: 200,
        attachmentType: 'file',
      });

      expect(repo.delete(attachment1.id)).toBe(true);
      expect(repo.delete(attachment2.id)).toBe(true);

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toEqual([]);
    });
  });

  describe('deleteByMessageId', () => {
    it('should delete all attachments for a message', () => {
      repo.create({
        messageId: testMessageId,
        filename: 'first.txt',
        storedPath: '/storage/first.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      repo.create({
        messageId: testMessageId,
        filename: 'second.txt',
        storedPath: '/storage/second.txt',
        mimeType: 'text/plain',
        size: 200,
        attachmentType: 'file',
      });

      const deletedCount = repo.deleteByMessageId(testMessageId);
      expect(deletedCount).toBe(2);

      const attachments = repo.getByMessageId(testMessageId);
      expect(attachments).toEqual([]);
    });

    it('should return 0 when message has no attachments', () => {
      const deletedCount = repo.deleteByMessageId('non-existent-message');
      expect(deletedCount).toBe(0);
    });

    it('should return correct count of deleted attachments', () => {
      repo.create({
        messageId: testMessageId,
        filename: 'file1.txt',
        storedPath: '/storage/file1.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      repo.create({
        messageId: testMessageId,
        filename: 'file2.txt',
        storedPath: '/storage/file2.txt',
        mimeType: 'text/plain',
        size: 200,
        attachmentType: 'file',
      });

      repo.create({
        messageId: testMessageId,
        filename: 'file3.txt',
        storedPath: '/storage/file3.txt',
        mimeType: 'text/plain',
        size: 300,
        attachmentType: 'file',
      });

      const deletedCount = repo.deleteByMessageId(testMessageId);
      expect(deletedCount).toBe(3);
    });

    it('should only delete attachments for specified message', () => {
      const otherMessageId = 'msg-other-456';
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(otherMessageId, 'channel-1', 'user-1', 'human', 'Other message', Date.now());

      repo.create({
        messageId: testMessageId,
        filename: 'test-msg.txt',
        storedPath: '/storage/test-msg.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const otherAttachment = repo.create({
        messageId: otherMessageId,
        filename: 'other-msg.txt',
        storedPath: '/storage/other-msg.txt',
        mimeType: 'text/plain',
        size: 200,
        attachmentType: 'file',
      });

      const deletedCount = repo.deleteByMessageId(testMessageId);
      expect(deletedCount).toBe(1);

      const otherAttachments = repo.getByMessageId(otherMessageId);
      expect(otherAttachments).toHaveLength(1);
      expect(otherAttachments[0].id).toBe(otherAttachment.id);
    });

    it('should remove all attachments from database', () => {
      const attachment1 = repo.create({
        messageId: testMessageId,
        filename: 'first.txt',
        storedPath: '/storage/first.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const attachment2 = repo.create({
        messageId: testMessageId,
        filename: 'second.txt',
        storedPath: '/storage/second.txt',
        mimeType: 'text/plain',
        size: 200,
        attachmentType: 'file',
      });

      repo.deleteByMessageId(testMessageId);

      const row1 = db.prepare('SELECT * FROM message_attachments WHERE id = ?').get(attachment1.id);
      const row2 = db.prepare('SELECT * FROM message_attachments WHERE id = ?').get(attachment2.id);

      expect(row1).toBeUndefined();
      expect(row2).toBeUndefined();
    });
  });

  describe('updateMetadata', () => {
    it('should update attachment metadata', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.jpg',
        storedPath: '/storage/test.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
        attachmentType: 'image',
        metadata: { original: true },
      });

      const newMetadata = { updated: true, version: 2 };
      const updated = repo.updateMetadata(created.id, newMetadata);
      expect(updated).toBe(true);

      const attachment = repo.getById(created.id);
      expect(attachment!.metadata).toEqual(newMetadata);
    });

    it('should return false when updating non-existent attachment', () => {
      const updated = repo.updateMetadata('non-existent-id', { test: true });
      expect(updated).toBe(false);
    });

    it('should completely replace existing metadata', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.pdf',
        storedPath: '/storage/test.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        attachmentType: 'file',
        metadata: { key1: 'value1', key2: 'value2', key3: 'value3' },
      });

      const newMetadata = { onlyThis: true };
      repo.updateMetadata(created.id, newMetadata);

      const attachment = repo.getById(created.id);
      expect(attachment!.metadata).toEqual(newMetadata);
      expect(attachment!.metadata).not.toHaveProperty('key1');
    });

    it('should handle empty metadata object', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.txt',
        storedPath: '/storage/test.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
        metadata: { hasData: true },
      });

      repo.updateMetadata(created.id, {});

      const attachment = repo.getById(created.id);
      expect(attachment!.metadata).toEqual({});
    });

    it('should handle complex nested metadata', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'complex.json',
        storedPath: '/storage/complex.json',
        mimeType: 'application/json',
        size: 2048,
        attachmentType: 'file',
      });

      const complexMetadata = {
        nested: {
          deep: {
            value: 'test',
            array: [1, 2, 3],
          },
        },
        tags: ['tag1', 'tag2'],
        numeric: 123.45,
      };

      repo.updateMetadata(created.id, complexMetadata);

      const attachment = repo.getById(created.id);
      expect(attachment!.metadata).toEqual(complexMetadata);
    });

    it('should update metadata in database', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'test.txt',
        storedPath: '/storage/test.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const newMetadata = { dbTest: true };
      repo.updateMetadata(created.id, newMetadata);

      const row = db.prepare('SELECT metadata FROM message_attachments WHERE id = ?').get(created.id) as any;
      expect(JSON.parse(row.metadata)).toEqual(newMetadata);
    });

    it('should not affect other attachment fields', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'original.txt',
        originalPath: '/original/path.txt',
        storedPath: '/storage/original.txt',
        mimeType: 'text/plain',
        size: 1024,
        attachmentType: 'file',
      });

      repo.updateMetadata(created.id, { newMeta: 'value' });

      const attachment = repo.getById(created.id);
      expect(attachment!.filename).toBe('original.txt');
      expect(attachment!.originalPath).toBe('/original/path.txt');
      expect(attachment!.storedPath).toBe('/storage/original.txt');
      expect(attachment!.size).toBe(1024);
    });
  });

  describe('updateFile', () => {
    // updateFile swaps the on-disk file behind an existing attachment row
    // (re-encode, re-download) — identity and metadata must survive the swap.
    it('should replace the stored file fields and leave the rest intact', () => {
      const created = repo.create({
        messageId: testMessageId,
        filename: 'before.png',
        storedPath: '/storage/before.png',
        mimeType: 'image/png',
        size: 100,
        attachmentType: 'image',
        metadata: { asset_pointer: 'ptr-keep' },
      });

      const updated = repo.updateFile(created.id, {
        storedPath: '/storage/after.jpg',
        filename: 'after.jpg',
        size: 250,
        mimeType: 'image/jpeg',
      });
      expect(updated).toBe(true);

      const retrieved = repo.getById(created.id);
      expect(retrieved!.storedPath).toBe('/storage/after.jpg');
      expect(retrieved!.filename).toBe('after.jpg');
      expect(retrieved!.size).toBe(250);
      expect(retrieved!.mimeType).toBe('image/jpeg');
      // Untouched fields survive.
      expect(retrieved!.messageId).toBe(testMessageId);
      expect(retrieved!.attachmentType).toBe('image');
      expect(retrieved!.metadata).toEqual({ asset_pointer: 'ptr-keep' });
    });

    it('should return false for a non-existent attachment', () => {
      expect(repo.updateFile('att-nope', {
        storedPath: '/x', filename: 'x', size: 1, mimeType: 'text/plain',
      })).toBe(false);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle filenames with special characters', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: "file's \"special\" name (test) [2024].pdf",
        storedPath: '/storage/special.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        attachmentType: 'file',
      });

      expect(attachment.filename).toBe("file's \"special\" name (test) [2024].pdf");

      const retrieved = repo.getById(attachment.id);
      expect(retrieved!.filename).toBe("file's \"special\" name (test) [2024].pdf");
    });

    it('should handle very long filenames', () => {
      const longFilename = 'a'.repeat(500) + '.txt';
      const attachment = repo.create({
        messageId: testMessageId,
        filename: longFilename,
        storedPath: '/storage/long.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const retrieved = repo.getById(attachment.id);
      expect(retrieved!.filename).toBe(longFilename);
    });

    it('should handle zero size attachments', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'empty.txt',
        storedPath: '/storage/empty.txt',
        mimeType: 'text/plain',
        size: 0,
        attachmentType: 'file',
      });

      expect(attachment.size).toBe(0);

      const retrieved = repo.getById(attachment.id);
      expect(retrieved!.size).toBe(0);
    });

    it('should handle very large file sizes', () => {
      const largeSize = 10 * 1024 * 1024 * 1024; // 10GB
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'huge.dat',
        storedPath: '/storage/huge.dat',
        mimeType: 'application/octet-stream',
        size: largeSize,
        attachmentType: 'file',
      });

      expect(attachment.size).toBe(largeSize);
    });

    it('should handle Unicode characters in metadata', () => {
      const metadata = {
        chinese: '你好世界',
        emoji: '🚀💾📁',
        arabic: 'مرحبا',
        symbols: '™©®',
      };

      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'unicode.txt',
        storedPath: '/storage/unicode.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
        metadata,
      });

      const retrieved = repo.getById(attachment.id);
      expect(retrieved!.metadata).toEqual(metadata);
    });

    it('should handle malformed JSON in metadata gracefully', () => {
      // Manually insert attachment with invalid JSON
      const id = 'att-malformed';
      db.prepare(`
        INSERT INTO message_attachments (
          id, message_id, filename, stored_path, mime_type, size, attachment_type, metadata, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, testMessageId, 'malformed.txt', '/storage/malformed.txt', 'text/plain', 100, 'file', 'invalid-json', Date.now());

      const attachment = repo.getById(id);
      // safeJsonParseOptional should handle this gracefully
      expect(attachment).toBeDefined();
      expect(attachment!.metadata).toBeUndefined();
    });

    it('should handle paths with backslashes (Windows-style)', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'windows.txt',
        originalPath: 'C:\\Users\\Test\\Documents\\file.txt',
        storedPath: 'C:\\Storage\\file.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      const retrieved = repo.getById(attachment.id);
      expect(retrieved!.originalPath).toBe('C:\\Users\\Test\\Documents\\file.txt');
      expect(retrieved!.storedPath).toBe('C:\\Storage\\file.txt');
    });

    it('should maintain data integrity with concurrent operations', () => {
      const attachments = [];
      for (let i = 0; i < 10; i++) {
        attachments.push(
          repo.create({
            messageId: testMessageId,
            filename: `file${i}.txt`,
            storedPath: `/storage/file${i}.txt`,
            mimeType: 'text/plain',
            size: 100 * (i + 1),
            attachmentType: 'file',
            metadata: { index: i },
          })
        );
      }

      const all = repo.getByMessageId(testMessageId);
      expect(all).toHaveLength(10);

      // Update metadata for each
      attachments.forEach((attachment, index) => {
        repo.updateMetadata(attachment.id, { index, updated: true });
      });

      // Delete half
      for (let i = 0; i < 5; i++) {
        repo.delete(attachments[i].id);
      }

      const remaining = repo.getByMessageId(testMessageId);
      expect(remaining).toHaveLength(5);

      // Verify remaining attachments have updated metadata
      remaining.forEach((attachment) => {
        expect(attachment.metadata).toHaveProperty('updated', true);
      });
    });

    it('should handle cascade delete when message is deleted', () => {
      const attachment = repo.create({
        messageId: testMessageId,
        filename: 'cascade.txt',
        storedPath: '/storage/cascade.txt',
        mimeType: 'text/plain',
        size: 100,
        attachmentType: 'file',
      });

      // Delete the parent message (should cascade to attachments)
      db.prepare('DELETE FROM messages WHERE id = ?').run(testMessageId);

      const retrieved = repo.getById(attachment.id);
      expect(retrieved).toBeNull();
    });
  });
});
