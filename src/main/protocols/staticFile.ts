import * as fs from 'fs';
import * as path from 'path';
import { getImageMimeType } from '../utils/mimeTypes';
import { isInsideDirectory } from '../services/sandbox/pathContainment';
import { logger } from '../services/logger';

export async function serveStaticFile(
  baseDir: string,
  filename: string,
  opts: { defaultMime: string; cacheMaxAge: number; label: string }
): Promise<Response> {
  const resolvedPath = path.join(baseDir, filename);
  const normalizedPath = path.normalize(resolvedPath);

  // startsWith(baseDir) let a sibling sharing the prefix through; isInsideDirectory
  // is a real containment check (relative path can't climb out).
  if (!isInsideDirectory(normalizedPath, baseDir)) {
    // Containment rejection: a security event, so it belongs in the log file
    // rather than only on a stdout nobody is reading in a packaged build.
    logger.warn('[protocol] Blocked path outside directory', { label: opts.label, path: normalizedPath, baseDir });
    return new Response('Forbidden', { status: 403 });
  }

  if (!fs.existsSync(normalizedPath)) {
    return new Response(`${opts.label} not found`, { status: 404 });
  }

  const fileBuffer = await fs.promises.readFile(normalizedPath);

  return new Response(fileBuffer, {
    status: 200,
    headers: {
      'Content-Type': getImageMimeType(normalizedPath, opts.defaultMime),
      'Content-Length': fileBuffer.length.toString(),
      'Cache-Control': `max-age=${opts.cacheMaxAge}`,
    },
  });
}
