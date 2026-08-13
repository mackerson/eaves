import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { app } from 'electron';
import { getDatabase, beginDatabaseRestore } from './database';
import { getLogger } from './logger';

const logger = getLogger();

export type SnapshotReason = 'startup' | 'periodic' | 'manual' | 'pre-restore';

export interface Snapshot {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: number;
  reason: SnapshotReason;
}

const PERIODIC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_FRESHNESS_MS = 12 * 60 * 60 * 1000;
const DEFAULT_RETENTION = 10;

// Millisecond precision in the timestamp + optional `-N` counter suffix so
// rapid-fire snapshots (pre-restore + fresh manual in the same tick) don't
// collide on filename and silently overwrite each other.
const FILENAME_PATTERN = /^enclave-(\d{8}T\d{6}\d{3}Z)-(startup|periodic|manual|pre-restore)(?:-(\d+))?\.db$/;

/**
 * Manages periodic + on-demand SQLite snapshots of the live database and
 * restoring from them. Snapshots use better-sqlite3's `db.backup(path)` which
 * runs a hot online backup against the open connection (safe with WAL mode).
 *
 * File layout: `<userData>/enclave-data/backups/enclave-<ISO>-<reason>.db`
 * ISO timestamp embedded in the name so sort order == chronological order.
 *
 * Restore is destructive — it closes the DB, replaces `enclave.db` (+ wipes
 * WAL/SHM sidecars), and the caller relaunches the app. A `pre-restore`
 * snapshot of current state is taken first so the user has a one-step undo.
 */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private backupsDir: string;
  private dataDir: string;
  private dbPath: string;
  private retention: number;
  private getDb: () => Database.Database;
  private beginRestore: () => void;

  constructor(opts?: {
    dataDir?: string;
    retention?: number;
    // Injected so tests can drive a real DB at a custom path without going
    // through the electron-bound singleton in ./database. Defaults to the
    // production singletons.
    getDb?: () => Database.Database;
    // Closes the DB *and* locks out reopens for the duration of the restore —
    // see beginDatabaseRestore. Closing alone is not enough: the singleton
    // would silently reopen the file we are about to replace.
    beginRestore?: () => void;
  }) {
    this.dataDir = opts?.dataDir ?? path.join(app.getPath('userData'), 'enclave-data');
    this.backupsDir = path.join(this.dataDir, 'backups');
    this.dbPath = path.join(this.dataDir, 'enclave.db');
    this.retention = opts?.retention ?? DEFAULT_RETENTION;
    this.getDb = opts?.getDb ?? getDatabase;
    this.beginRestore = opts?.beginRestore ?? beginDatabaseRestore;
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.backupsDir, { recursive: true });

    try {
      const snapshots = this.listSnapshots();
      const newest = snapshots[0];
      const stale = !newest || (Date.now() - newest.createdAt) > STARTUP_FRESHNESS_MS;
      if (stale) {
        await this.createSnapshot('startup');
      } else {
        logger.debug(`[Backup] Skipping startup snapshot — newest is ${Math.round((Date.now() - newest.createdAt) / 1000 / 60)}min old`);
      }
    } catch (error) {
      logger.error('[Backup] Startup snapshot failed:', error);
    }

    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.createSnapshot('periodic').catch((error) => {
        logger.error('[Backup] Periodic snapshot failed:', error);
      });
    }, PERIODIC_INTERVAL_MS);

    logger.info(`[Backup] Service started (retention=${this.retention}, period=${PERIODIC_INTERVAL_MS / 1000 / 60}min)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async createSnapshot(reason: SnapshotReason): Promise<Snapshot> {
    fs.mkdirSync(this.backupsDir, { recursive: true });

    const { filename, fullPath } = this.allocateSnapshotPath(reason);

    const db = this.getDb();
    await db.backup(fullPath);

    const stat = fs.statSync(fullPath);
    const snapshot: Snapshot = {
      filename,
      path: fullPath,
      sizeBytes: stat.size,
      createdAt: stat.mtimeMs,
      reason,
    };

    logger.info(`[Backup] Created ${filename} (${formatBytes(stat.size)}, reason=${reason})`);
    this.pruneOldSnapshots();
    return snapshot;
  }

  listSnapshots(): Snapshot[] {
    if (!fs.existsSync(this.backupsDir)) return [];

    const entries = fs.readdirSync(this.backupsDir);
    const snapshots: Snapshot[] = [];
    for (const filename of entries) {
      const match = FILENAME_PATTERN.exec(filename);
      if (!match) continue;
      const fullPath = path.join(this.backupsDir, filename);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        snapshots.push({
          filename,
          path: fullPath,
          sizeBytes: stat.size,
          createdAt: stat.mtimeMs,
          reason: match[2] as SnapshotReason,
        });
      } catch {
        // File vanished between readdir and stat — skip rather than throw.
      }
    }
    snapshots.sort((a, b) => b.createdAt - a.createdAt);
    return snapshots;
  }

  deleteSnapshot(filename: string): void {
    if (!FILENAME_PATTERN.test(filename)) {
      throw new Error(`Refusing to delete non-snapshot filename: ${filename}`);
    }
    const fullPath = path.join(this.backupsDir, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Snapshot not found: ${filename}`);
    }
    fs.unlinkSync(fullPath);
    logger.info(`[Backup] Deleted ${filename}`);
  }

  /**
   * Restore the named snapshot over the live DB. Steps:
   *  1. Validate filename against the canonical pattern.
   *  2. Take a `pre-restore` snapshot of current state so the user can undo.
   *  3. Close the active DB handle *and* lock out reopens. Closing only nulls
   *     a module singleton, so the next `getDatabase()` from any live
   *     timer-driven service (routines, sync, activity persistence, this
   *     service's own 24h timer) would transparently reopen the file we are
   *     about to overwrite — leaving a stale handle open across the
   *     replacement. The caller quiesces those services first; the lock is
   *     the backstop for anything it misses.
   *  4. Copy the chosen snapshot over `enclave.db` and remove the WAL/SHM
   *     sidecars (stale sidecars against a freshly-restored DB cause silent
   *     data corruption — drop them and let WAL be rebuilt on next open).
   *  5. Caller relaunches the app — we don't call `app.relaunch()` here so
   *     this method stays testable. The lock is never released on success:
   *     the relaunch is what clears it.
   */
  async restoreFromSnapshot(filename: string): Promise<void> {
    if (!FILENAME_PATTERN.test(filename)) {
      throw new Error(`Refusing to restore non-snapshot filename: ${filename}`);
    }
    const snapshotPath = path.join(this.backupsDir, filename);
    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`Snapshot not found: ${filename}`);
    }

    logger.info(`[Backup] Restoring from ${filename}`);
    await this.createSnapshot('pre-restore');

    // Stop our own timer before the lock goes up, so a periodic snapshot
    // can't fire into a locked database and log a spurious failure.
    this.stop();
    this.beginRestore();

    try {
      fs.copyFileSync(snapshotPath, this.dbPath);
      for (const sidecar of [this.dbPath + '-wal', this.dbPath + '-shm']) {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      }
    } catch (error) {
      // Leave the lock up. The copy may have partially written enclave.db, and
      // reopening a half-replaced file is the exact outcome the lock exists to
      // prevent. The user restarts; the pre-restore snapshot above is intact.
      logger.error('[Backup] Restore failed mid-copy — database stays locked until restart', error);
      throw error;
    }

    logger.info(`[Backup] Restore complete — caller must relaunch`);
  }

  /** Find a non-colliding `enclave-<iso>-<reason>[-N].db` filename. Two
   *  snapshots in the same millisecond get a numeric suffix. Cap the search
   *  so a wedged filesystem can't infinite-loop us. */
  private allocateSnapshotPath(reason: SnapshotReason): { filename: string; fullPath: string } {
    const iso = isoForFilename(new Date());
    const base = `enclave-${iso}-${reason}`;
    for (let suffix = 0; suffix < 1000; suffix++) {
      const filename = suffix === 0 ? `${base}.db` : `${base}-${suffix}.db`;
      const fullPath = path.join(this.backupsDir, filename);
      if (!fs.existsSync(fullPath)) return { filename, fullPath };
    }
    throw new Error(`Failed to allocate snapshot filename — 1000 collisions on base ${base}`);
  }

  private pruneOldSnapshots(): void {
    const snapshots = this.listSnapshots();
    if (snapshots.length <= this.retention) return;
    const toDelete = snapshots.slice(this.retention);
    for (const snap of toDelete) {
      try {
        fs.unlinkSync(snap.path);
        logger.debug(`[Backup] Pruned ${snap.filename}`);
      } catch (error) {
        logger.warn(`[Backup] Failed to prune ${snap.filename}:`, error);
      }
    }
  }
}

function isoForFilename(d: Date): string {
  // 2026-05-14T14:32:18.456Z → 20260514T143218456Z
  return d.toISOString().replace(/[-:.]/g, '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let backupServiceInstance: BackupService | null = null;

export function getBackupService(): BackupService {
  if (!backupServiceInstance) {
    backupServiceInstance = new BackupService();
  }
  return backupServiceInstance;
}

export function resetBackupService(): void {
  backupServiceInstance?.stop();
  backupServiceInstance = null;
}
