import type Database from 'better-sqlite3';
import { logger } from '../logger';
import { SYNCED_TABLES, decodeRowId, isSyncedTable } from './syncTables';

/**
 * Oplog read/apply engine for LAN sync.
 *
 * Reading: collapses the append-only sync_changes log to the latest entry per
 * row and attaches CURRENT row data at read time — intermediate states are
 * never shipped, and a row edited 50 times between syncs transfers once.
 *
 * Applying: runs in one transaction with sync_meta.applying = 1 so the
 * change-capture triggers stay silent (no echo), with deferred FK enforcement
 * so batch ordering doesn't matter. Conflict policy is last-write-wins on the
 * change timestamp, ties broken by device id (deterministic on both ends).
 */

export interface SyncChange {
  seq: number;
  table: string;
  rowId: string;
  op: 'insert' | 'update' | 'delete';
  changedAt: number;
  /** Current row data; absent for deletes. */
  row?: Record<string, unknown>;
}

export interface ChangeBatch {
  changes: SyncChange[];
  /** Highest oplog seq covered by this batch; the receiver acks this. */
  upToSeq: number;
}

export interface ApplyResult {
  applied: number;
  /** Skipped because the local version was newer (LWW). */
  skippedOlder: number;
  /** Skipped because the table is unknown locally or the entry was malformed. */
  skippedInvalid: number;
}

interface OplogRow {
  seq: number;
  table_name: string;
  row_id: string;
  op: 'insert' | 'update' | 'delete';
  changed_at: number;
}

const DEFAULT_BATCH_LIMIT = 500;

/** Column cache per table — pragma table_info is stable for a process run. */
const columnCache = new Map<string, string[]>();

function tableColumns(db: Database.Database, table: string): string[] {
  let cols = columnCache.get(table);
  if (!cols) {
    cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name);
    columnCache.set(table, cols);
  }
  return cols;
}

/** Test hook: pragma results are cached per table name across db instances. */
export function clearColumnCache(): void {
  columnCache.clear();
}

/**
 * Read the collapsed change set after `sinceSeq`, attaching current row data.
 *
 * Note the bare-column GROUP BY: with a single MAX(seq) aggregate, SQLite
 * guarantees op/changed_at come from the max-seq row. Batches are capped;
 * callers page by re-requesting with the returned upToSeq. Collapse happens
 * within the page window — a row touched on both sides of a page boundary is
 * sent twice with identical (current) data, which apply treats idempotently.
 */
export function getChangesSince(
  db: Database.Database,
  sinceSeq: number,
  limit: number = DEFAULT_BATCH_LIMIT,
): ChangeBatch {
  const rows = db.prepare(`
    SELECT table_name, row_id, op, MAX(seq) AS seq, changed_at
    FROM sync_changes
    WHERE seq > ?
    GROUP BY table_name, row_id
    ORDER BY seq ASC
    LIMIT ?
  `).all(sinceSeq, limit) as OplogRow[];

  const changes: SyncChange[] = [];
  let upToSeq = sinceSeq;

  for (const entry of rows) {
    upToSeq = Math.max(upToSeq, entry.seq);
    if (!isSyncedTable(entry.table_name)) {
      // Oplog written by a newer schema than this runtime knows — skip rather
      // than ship rows we can't read consistently.
      logger.warn('[sync] Oplog entry for unknown table, skipping', { table: entry.table_name });
      continue;
    }

    if (entry.op === 'delete') {
      changes.push({
        seq: entry.seq,
        table: entry.table_name,
        rowId: entry.row_id,
        op: 'delete',
        changedAt: entry.changed_at,
      });
      continue;
    }

    const row = readRow(db, entry.table_name, entry.row_id);
    if (!row) {
      // Row vanished without its delete being the latest entry (shouldn't
      // happen — delete triggers append last). Degrade to a delete so the
      // peer converges with reality instead of erroring.
      changes.push({
        seq: entry.seq,
        table: entry.table_name,
        rowId: entry.row_id,
        op: 'delete',
        changedAt: entry.changed_at,
      });
      continue;
    }

    changes.push({
      seq: entry.seq,
      table: entry.table_name,
      rowId: entry.row_id,
      op: entry.op,
      changedAt: entry.changed_at,
      row,
    });
  }

  return { changes, upToSeq };
}

function readRow(db: Database.Database, table: string, rowId: string): Record<string, unknown> | undefined {
  const def = SYNCED_TABLES[table];
  const pkValues = decodeRowId(table, rowId);
  const where = def.pk.map(c => `${c} = ?`).join(' AND ');
  return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...pkValues) as
    | Record<string, unknown>
    | undefined;
}

/**
 * The version a row currently holds locally, for LWW comparison: the newer of
 * (a) the latest local oplog entry for the row (a local edit) and (b) the last
 * remote version applied to it (sync_row_state).
 */
function localRowVersion(
  db: Database.Database,
  ourDeviceId: string,
  table: string,
  rowId: string,
): { changedAt: number; deviceId: string } | undefined {
  const local = db.prepare(`
    SELECT changed_at FROM sync_changes
    WHERE table_name = ? AND row_id = ?
    ORDER BY seq DESC LIMIT 1
  `).get(table, rowId) as { changed_at: number } | undefined;

  const applied = db.prepare(`
    SELECT changed_at, device_id FROM sync_row_state
    WHERE table_name = ? AND row_id = ?
  `).get(table, rowId) as { changed_at: number; device_id: string } | undefined;

  const candidates: Array<{ changedAt: number; deviceId: string }> = [];
  if (local) candidates.push({ changedAt: local.changed_at, deviceId: ourDeviceId });
  if (applied) candidates.push({ changedAt: applied.changed_at, deviceId: applied.device_id });
  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) =>
    b.changedAt - a.changedAt || b.deviceId.localeCompare(a.deviceId),
  )[0];
}

/**
 * Remote wins on strictly-newer timestamp; ties break on device id.
 *
 * Except when both versions came from the same device — those aren't
 * concurrent, so there is no conflict to arbitrate. That device orders its own
 * writes by oplog seq and only ever ships a row's latest state, so a same-device
 * version at the same millisecond is an advance (or a harmless re-delivery) and
 * must land. Falling through to the device-id tie-break here would compare a
 * device against itself and always answer "loses", silently dropping a row's own
 * delete whenever it shared a millisecond with the insert it supersedes.
 */
function remoteWins(
  remote: { changedAt: number; deviceId: string },
  local: { changedAt: number; deviceId: string } | undefined,
): boolean {
  if (!local) return true;
  if (remote.deviceId === local.deviceId) return remote.changedAt >= local.changedAt;
  if (remote.changedAt !== local.changedAt) return remote.changedAt > local.changedAt;
  return remote.deviceId > local.deviceId;
}

/**
 * Apply a batch of remote changes inside a single guarded transaction.
 *
 * Upserts use INSERT ... ON CONFLICT DO UPDATE — never INSERT OR REPLACE,
 * whose internal DELETE would fire ON DELETE CASCADE and silently wipe child
 * rows (e.g. replacing a chats row would delete its chat_messages).
 */
export function applyRemoteChanges(
  db: Database.Database,
  ourDeviceId: string,
  fromDeviceId: string,
  changes: SyncChange[],
): ApplyResult {
  const result: ApplyResult = { applied: 0, skippedOlder: 0, skippedInvalid: 0 };
  if (changes.length === 0) return result;

  const txn = db.transaction(() => {
    db.prepare('UPDATE sync_meta SET applying = 1 WHERE id = 1').run();
    // Children may arrive before parents within the batch; enforcement is
    // deferred to commit. Resets automatically at transaction end.
    db.pragma('defer_foreign_keys = ON');
    try {
      for (const change of changes) {
        if (!isSyncedTable(change.table)) {
          result.skippedInvalid++;
          continue;
        }

        const local = localRowVersion(db, ourDeviceId, change.table, change.rowId);
        if (!remoteWins({ changedAt: change.changedAt, deviceId: fromDeviceId }, local)) {
          result.skippedOlder++;
          continue;
        }

        if (change.op === 'delete') {
          deleteRow(db, change.table, change.rowId);
        } else {
          if (!change.row || !upsertRow(db, change.table, change.row)) {
            result.skippedInvalid++;
            continue;
          }
        }

        db.prepare(`
          INSERT INTO sync_row_state (table_name, row_id, changed_at, device_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(table_name, row_id) DO UPDATE SET
            changed_at = excluded.changed_at,
            device_id = excluded.device_id
        `).run(change.table, change.rowId, change.changedAt, fromDeviceId);
        result.applied++;
      }
    } finally {
      db.prepare('UPDATE sync_meta SET applying = 0 WHERE id = 1').run();
    }
  });
  txn();

  return result;
}

function deleteRow(db: Database.Database, table: string, rowId: string): void {
  const def = SYNCED_TABLES[table];
  const pkValues = decodeRowId(table, rowId);
  const where = def.pk.map(c => `${c} = ?`).join(' AND ');
  db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...pkValues);
}

/**
 * Insert-or-update from a remote row object. Column names are taken from OUR
 * schema (pragma table_info) intersected with the remote keys — never from
 * the wire — and all values are parameterized. Remote-only columns (newer
 * peer schema) are dropped; sync refuses mismatched schema versions upstream,
 * so this is defense in depth.
 */
function upsertRow(db: Database.Database, table: string, row: Record<string, unknown>): boolean {
  const def = SYNCED_TABLES[table];
  const cols = tableColumns(db, table).filter(c =>
    Object.prototype.hasOwnProperty.call(row, c),
  );
  // Refuse rows that don't even carry the primary key.
  if (!def.pk.every(pk => cols.includes(pk))) return false;

  const nonPk = cols.filter(c => !def.pk.includes(c));
  const placeholders = cols.map(() => '?').join(', ');
  const updates = nonPk.map(c => `${c} = excluded.${c}`).join(', ');
  const conflictClause = nonPk.length > 0
    ? `ON CONFLICT(${def.pk.join(', ')}) DO UPDATE SET ${updates}`
    : `ON CONFLICT(${def.pk.join(', ')}) DO NOTHING`;

  const values = cols.map(c => normalizeValue(row[c]));
  db.prepare(`
    INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${placeholders})
    ${conflictClause}
  `).run(...values);
  return true;
}

/** SQLite bindings accept string/number/bigint/Buffer/null only. */
function normalizeValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

/**
 * Trim the oplog. Entries every paired peer has acked are no longer needed;
 * with no paired peers, keep a 30-day window so enabling sync later still has
 * recent history to offer.
 */
export function pruneChanges(db: Database.Database, now: number = Date.now()): number {
  const peer = db.prepare(
    'SELECT COUNT(*) AS n, MIN(last_acked_seq) AS minAcked FROM sync_peers',
  ).get() as { n: number; minAcked: number | null };

  let info: Database.RunResult;
  if (peer.n > 0) {
    info = db.prepare('DELETE FROM sync_changes WHERE seq <= ?').run(peer.minAcked ?? 0);
  } else {
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    info = db.prepare('DELETE FROM sync_changes WHERE changed_at < ?').run(cutoff);
  }
  return info.changes;
}

/**
 * Startup safety: a crash outside applyRemoteChanges' transaction can't leave
 * applying = 1 (the transaction rolls it back), but reset defensively so a
 * stuck flag can never silently stop change capture.
 */
export function resetApplyGuard(db: Database.Database): void {
  db.prepare('UPDATE sync_meta SET applying = 0 WHERE id = 1').run();
}
