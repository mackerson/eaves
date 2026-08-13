import * as path from 'path';

const MIME_TYPES: Record<string, string> = {
  // Documents
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.pdf': 'application/pdf',
  // Code
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.jsx': 'text/javascript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.sh': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
};

// Attachment extension allowlists — the single source of truth shared by the
// file picker (files.ts), send-time validation (chats.ts), and the model-
// context reader (ChatService.ts) so they can't drift out of sync.
export const IMAGE_ATTACHMENT_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
]);

// Text-based files we can read as UTF-8 and hand to the model inline. Binary
// documents (pdf, docx, indd) are intentionally excluded — they need
// extraction, tracked separately.
export const TEXT_ATTACHMENT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.xml',
  '.html', '.htm', '.css', '.toml', '.ini', '.env', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c',
  '.cpp', '.h', '.hpp', '.rs', '.go', '.rb', '.php', '.sh', '.bash',
  '.zsh', '.sql',
]);

export function isImageAttachmentExt(ext: string): boolean {
  return IMAGE_ATTACHMENT_EXTS.has(ext.toLowerCase());
}

export function isTextAttachmentExt(ext: string): boolean {
  return TEXT_ATTACHMENT_EXTS.has(ext.toLowerCase());
}

/**
 * Get MIME type for a file extension or file path.
 * Returns undefined if the extension is not recognized.
 */
export function getMimeType(extOrPath: string): string | undefined {
  const ext = extOrPath.startsWith('.') ? extOrPath.toLowerCase() : path.extname(extOrPath).toLowerCase();
  return MIME_TYPES[ext];
}

/**
 * Get MIME type with a fallback default for image files.
 * Useful for protocol handlers serving images.
 */
export function getImageMimeType(extOrPath: string, defaultMime = 'image/png'): string {
  return getMimeType(extOrPath) || defaultMime;
}
