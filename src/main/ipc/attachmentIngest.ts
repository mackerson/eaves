import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../services/logger';
import { getMessageAttachmentRepository } from '../repositories';
import {
  getImageMimeType,
  getMimeType,
  isImageAttachmentExt,
  IMAGE_ATTACHMENT_EXTS,
  TEXT_ATTACHMENT_EXTS,
} from '../utils/mimeTypes';

/**
 * Attachment ingestion for message sends.
 *
 * Validates raw file paths (the dialog already filters, but the IPC accepts
 * arbitrary paths — bypassing the picker is the threat model), copies the
 * files into the app's attachment store, and produces the image/file content
 * blocks the renderer and turn core consume. `chats.ts` `send-chat-message`
 * carries a byte-for-byte congruent inline copy of this logic — the two must
 * stay congruent, and if the chat IPC domain folds into the channel domain
 * that handler should delegate here rather than keep its own.
 */

// Per-message attachment limits — same rationale and values as chats.ts:
// generous for normal uploads, protective against a malicious renderer
// streaming gigabytes through the endpoint.
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;       // 10 MB per file
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB combined
export const ALLOWED_ATTACHMENT_EXTS = new Set([
  ...IMAGE_ATTACHMENT_EXTS,
  ...TEXT_ATTACHMENT_EXTS,
]);

export type IngestResult =
  | { ok: true; blocks: any[]; failedAttachments: number }
  | { ok: false; error: string };

/**
 * Validate + copy attachments into the store, returning renderer-shape
 * content blocks (block.metadata.storedPath carries the disk location for
 * `bindAttachmentRecords` below). Rejects the whole batch on any violation so
 * no orphan files land on disk.
 */
export function ingestAttachments(attachments: string[]): IngestResult {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      error: `Too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message)`,
    };
  }
  let totalBytes = 0;
  for (const filePath of attachments) {
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTS.has(ext)) {
      return {
        ok: false,
        error: `Unsupported file type "${ext}" — allowed: images (jpg, png, gif, webp) and text/documents (md, txt, csv, json, code, …)`,
      };
    }
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return { ok: false, error: `Attachment not found or unreadable: ${path.basename(filePath)}` };
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        error: `Attachment "${path.basename(filePath)}" exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per-file limit`,
      };
    }
    totalBytes += size;
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `Total attachment size exceeds ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB limit`,
    };
  }

  const dataDir = path.join(app.getPath('userData'), 'eaves-data');
  const attachmentsDir = path.join(dataDir, 'eaves-attachments');
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  const blocks: any[] = [];
  let failedAttachments = 0;
  for (const filePath of attachments) {
    try {
      const ext = path.extname(filePath);
      const filename = path.basename(filePath);
      const stats = fs.statSync(filePath);

      const storedFilename = `${randomUUID()}${ext}`;
      const storedPath = path.join(attachmentsDir, storedFilename);

      fs.copyFileSync(filePath, storedPath);

      if (isImageAttachmentExt(ext)) {
        const mimeType = getImageMimeType(ext, 'application/octet-stream');
        blocks.push({
          type: 'image',
          url: `file-service://${storedFilename}`,
          alt: filename,
          metadata: { storedPath, filename, mimeType, size: stats.size },
        });
      } else {
        // Text/document file — stored the same way, but rendered as a chip
        // and inlined as text (not a vision part) by the turn core.
        const mimeType = getMimeType(ext) ?? 'text/plain';
        blocks.push({
          type: 'file',
          filename,
          mimeType,
          size: stats.size,
          url: `file-service://${storedFilename}`,
          metadata: { storedPath, filename, mimeType, size: stats.size },
        });
      }
    } catch (error) {
      failedAttachments++;
      logger.error(`[attachmentIngest] Failed to process attachment ${filePath}:`, error);
    }
  }

  return { ok: true, blocks, failedAttachments };
}

/**
 * Create attachment DB records for the ingested blocks (must run AFTER the
 * message insert — attachments FK onto message_id), then rewrite each block's
 * URL to the stable attachment id and drop the raw storedPath from block
 * metadata. Mutates the blocks in place (the caller's persisted contentBlocks
 * array and its returned message share them). Returns true when any block was
 * bound, i.e. the caller must re-save contentBlocks.
 */
export function bindAttachmentRecords(messageId: string, contentBlocks: any[]): boolean {
  const attachmentRepo = getMessageAttachmentRepository();
  const attachmentBlocks = contentBlocks.filter(
    b => (b.type === 'image' || b.type === 'file') && b.metadata?.storedPath,
  );

  for (const block of attachmentBlocks) {
    const attachment = attachmentRepo.create({
      messageId,
      filename: block.metadata.filename,
      storedPath: block.metadata.storedPath,
      mimeType: block.metadata.mimeType,
      size: block.metadata.size,
      attachmentType: block.type === 'image' ? 'image' : 'file',
      metadata: {},
    });

    block.url = `file-service://${attachment.id}`;
    delete block.metadata.storedPath;
  }

  return attachmentBlocks.length > 0;
}
