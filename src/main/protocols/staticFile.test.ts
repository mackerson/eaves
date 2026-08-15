import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The containment rejection is logged (it is a security event, not just a 403),
// and the logger resolves its directory from electron's app at import time.
vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { serveStaticFile } from './staticFile';

const opts = { defaultMime: 'image/png', cacheMaxAge: 0, label: 'image' };

describe('serveStaticFile containment', () => {
  let root: string;
  let baseDir: string;
  let siblingDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaves-static-'));
    baseDir = path.join(root, 'img');
    siblingDir = path.join(root, 'img-secret'); // shares the "img" prefix
    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(baseDir, 'ok.png'), 'PNGDATA');
    await fs.writeFile(path.join(siblingDir, 'secret.png'), 'SECRET');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('serves a file that is genuinely inside the base directory', async () => {
    const res = await serveStaticFile(baseDir, 'ok.png', opts);
    expect(res.status).toBe(200);
  });

  it('rejects a sibling directory that shares the path prefix', async () => {
    // path.join(baseDir, '../img-secret/secret.png') resolves into the sibling
    // whose path startsWith(baseDir) — the old check served it (200). Now 403.
    const res = await serveStaticFile(baseDir, '../img-secret/secret.png', opts);
    expect(res.status).toBe(403);
  });

  it('404s a missing file inside the base directory', async () => {
    const res = await serveStaticFile(baseDir, 'missing.png', opts);
    expect(res.status).toBe(404);
  });
});
