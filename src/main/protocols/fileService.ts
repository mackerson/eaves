import { protocol } from 'electron';
import * as fs from 'fs';
import { getMessageAttachmentRepository } from '../repositories';
import { logger } from '../services/logger';

export function registerFileServiceProtocol(): void {
  protocol.handle('file-service', async (request) => {
    try {
      const url = new URL(request.url);
      const attachmentRepo = getMessageAttachmentRepository();

      let attachment: { storedPath: string; mimeType: string; size: number } | null = null;

      if (url.host === 'asset' && url.pathname) {
        const assetPointer = decodeURIComponent(url.pathname.slice(1));
        attachment = attachmentRepo.getByAssetPointer(assetPointer);
      } else {
        attachment = attachmentRepo.getById(url.host);
      }

      if (!attachment) {
        logger.warn('[protocol] Attachment not found', { url: request.url });
        return new Response('File not found', { status: 404 });
      }

      const fileBuffer = await fs.promises.readFile(attachment.storedPath);

      return new Response(fileBuffer, {
        status: 200,
        headers: {
          'Content-Type': attachment.mimeType,
          'Content-Length': attachment.size.toString(),
        },
      });
    } catch (error) {
      logger.error('[protocol] Failed to serve attachment', { url: request.url, error: error instanceof Error ? error.message : String(error) });
      return new Response('Internal server error', { status: 500 });
    }
  });
}
