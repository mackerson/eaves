import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * Keep the crash dump directory bounded.
 *
 * Crashpad writes minidumps and, with uploading disabled, never removes them —
 * so the directory grows for the life of the install. That matters more than
 * disk usage: a minidump is a memory image that can contain conversation text
 * and API keys, so an unbounded pile of them is an unbounded amount of the
 * user's plaintext sitting on disk indefinitely.
 *
 * Recent dumps are what make a crash diagnosable, so keep a handful and drop
 * the rest.
 */

const KEEP = 10;

export function pruneCrashDumps(keep: number = KEEP): void {
  let dir: string;
  try {
    dir = app.getPath('crashDumps');
  } catch {
    return; // Path not configured on this platform; nothing to prune.
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // No dumps yet, which is the common case.
  }

  const dumps = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.dmp'))
    .map(entry => {
      const full = path.join(dir, entry.name);
      // A dump whose mtime cannot be read sorts oldest, so it is dropped first
      // rather than pinned forever at the front of the queue.
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* treat as oldest */ }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const stale = dumps.slice(keep);
  if (stale.length === 0) return;

  let removed = 0;
  for (const dump of stale) {
    try {
      fs.rmSync(dump.full, { force: true });
      removed++;
    } catch {
      // Never fatal: failing to prune is untidy, failing to start is not.
    }
  }

  if (removed > 0) {
    logger.info(`[CrashDumps] Removed ${removed} old crash dump(s), keeping the ${keep} most recent`);
  }
}
