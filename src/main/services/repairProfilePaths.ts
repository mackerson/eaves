import type Database from 'better-sqlite3';

/**
 * Repoint absolute paths that used to live inside the Enclave profile.
 *
 * Some stored paths point *into* userData and therefore moved with the profile
 * rename; others are directories the user picked themselves and did not move.
 * Only a prefix match can tell them apart, which is why this is not part of
 * migration 77 — a schema migration is handed a database and nothing else,
 * while this needs both profile roots.
 *
 * Scoped to the columns the app actually resolves against the filesystem.
 * Conversation and audit history is left alone even where it quotes a path:
 * those rows describe what happened, and nothing reads a path back out of them.
 *
 * Idempotent, and a no-op once no row carries the old root.
 */

/** `table.column` pairs holding a single absolute path. */
const PATH_COLUMNS: Array<[table: string, column: string]> = [
  // Projects the app created live at <userData>/projects/<name>-<hash>, so
  // these moved. A project pointed at a directory elsewhere on disk did not,
  // and the prefix check is what keeps this from breaking those.
  ['projects', 'directory'],
  // Attachment bytes live at <userData>/<data-dir>/<attachments>/<uuid>.<ext>
  // and are read straight off this column, so every attachment in existing
  // history 404s without this.
  ['message_attachments', 'stored_path'],
];

export interface PathRepairResult {
  /** Rows rewritten, by `table.column`. Empty when there was nothing to do. */
  updated: Record<string, number>;
}

export function repairProfilePaths(
  db: Database.Database,
  legacyRoot: string,
  currentRoot: string,
): PathRepairResult {
  const updated: Record<string, number> = {};
  if (legacyRoot === currentRoot) return { updated };

  // Match the root with its separator attached. Without it, a sibling profile
  // directory whose name merely starts with the old one would also match.
  const legacyPrefix = legacyRoot.endsWith('/') ? legacyRoot : `${legacyRoot}/`;
  const currentPrefix = currentRoot.endsWith('/') ? currentRoot : `${currentRoot}/`;

  for (const [table, column] of PATH_COLUMNS) {
    if (!tableHasColumn(db, table, column)) continue;

    // LIKE would treat _ and % in the path as wildcards; substr comparison
    // avoids needing an ESCAPE clause for a path we do not control.
    const result = db.prepare(
      `UPDATE ${table}
          SET ${column} = ? || substr(${column}, ?)
        WHERE substr(${column}, 1, ?) = ?`
    ).run(currentPrefix, legacyPrefix.length + 1, legacyPrefix.length, legacyPrefix);

    if (result.changes > 0) updated[`${table}.${column}`] = result.changes;
  }

  const blocks = repairContentBlockPaths(db, legacyPrefix, currentPrefix);
  if (blocks > 0) updated['messages.content_blocks'] = blocks;

  return { updated };
}

/**
 * Attachment blocks carry the same path again inside their JSON metadata, and
 * the renderer resolves attachments from there. Replacing only the root prefix
 * keeps this from touching anything else in the blob.
 */
function repairContentBlockPaths(
  db: Database.Database,
  legacyPrefix: string,
  currentPrefix: string,
): number {
  if (!tableHasColumn(db, 'messages', 'content_blocks')) return 0;

  const result = db.prepare(
    `UPDATE messages
        SET content_blocks = replace(content_blocks, ?, ?)
      WHERE content_blocks LIKE '%' || ? || '%'`
  ).run(legacyPrefix, currentPrefix, legacyPrefix);

  return result.changes;
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .some(c => c.name === column);
  } catch {
    return false;
  }
}
