import * as path from 'path';
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
 * The profile root is not the only thing that moved. `enclave-data` became
 * `eaves-data` and `enclave-attachments` became `eaves-attachments`, so
 * substituting the root alone produces a path that is still wrong in its
 * middle — which is how every migrated attachment could keep 404ing while
 * looking repaired.
 *
 * Scoped to the columns the app actually resolves against the filesystem.
 * Conversation and audit history is left alone even where it quotes a path:
 * those rows describe what happened, and nothing reads a path back out of them.
 *
 * Idempotent, and a no-op once no row carries an old prefix.
 */

/** `table.column` pairs holding a single absolute path. */
const PATH_COLUMNS: Array<[table: string, column: string]> = [
  // Projects the app created live at <userData>/projects/<name>-<hash>, so
  // these moved. A project pointed at a directory elsewhere on disk did not,
  // and the prefix check is what keeps this from breaking those.
  ['projects', 'directory'],
  // Attachment bytes are read straight off this column, so every attachment in
  // existing history 404s without this.
  ['message_attachments', 'stored_path'],
  // Files added to a project can live under an app-created project directory.
  ['files', 'path'],
];

const LEGACY_DATA_DIR = 'enclave-data';
const LEGACY_ATTACHMENTS = 'enclave-attachments';
const DATA_DIR = 'eaves-data';
const ATTACHMENTS = 'eaves-attachments';

export interface PathRepairResult {
  /** Rows rewritten, by `table.column`. Empty when there was nothing to do. */
  updated: Record<string, number>;
}

interface PrefixMapping {
  from: string;
  to: string;
  /** Whether this prefix is specific enough to rewrite inside message JSON. */
  machineOnly: boolean;
}

/** Trailing separator included: it is what stops a sibling directory matching. */
function dir(...parts: string[]): string {
  return path.join(...parts) + path.sep;
}

/**
 * Prefix rewrites, most specific first.
 *
 * Ordering matters and is what lets each rewrite be a single substring
 * replacement: once a row has been rewritten by an earlier, more specific
 * mapping it no longer matches a later, broader one.
 *
 * The `currentRoot`-based entries cover a row written *after* the profile
 * moved but before its interior was renamed — the state an interrupted
 * migration leaves behind.
 */
function prefixMappings(legacyRoot: string, currentRoot: string): PrefixMapping[] {
  const mappings: PrefixMapping[] = [];

  for (const root of [legacyRoot, currentRoot]) {
    mappings.push({
      from: dir(root, LEGACY_DATA_DIR, LEGACY_ATTACHMENTS),
      to: dir(currentRoot, DATA_DIR, ATTACHMENTS),
      machineOnly: true,
    });
    mappings.push({
      from: dir(root, LEGACY_DATA_DIR),
      to: dir(currentRoot, DATA_DIR),
      machineOnly: true,
    });
  }

  // The bare root last: broad, and plausible for a person to have typed into a
  // message, so it never rewrites anything inside conversation content.
  mappings.push({ from: dir(legacyRoot), to: dir(currentRoot), machineOnly: false });

  return mappings.filter(m => m.from !== m.to);
}

export function repairProfilePaths(
  db: Database.Database,
  legacyRoot: string,
  currentRoot: string,
): PathRepairResult {
  const updated: Record<string, number> = {};
  const mappings = prefixMappings(legacyRoot, currentRoot);
  if (mappings.length === 0) return { updated };

  const bump = (key: string, changes: number) => {
    if (changes > 0) updated[key] = (updated[key] ?? 0) + changes;
  };

  for (const [table, column] of PATH_COLUMNS) {
    if (!tableHasColumn(db, table, column)) continue;

    for (const { from, to } of mappings) {
      // substr rather than LIKE: a path can contain _ and %, which LIKE would
      // read as wildcards, and this avoids needing an ESCAPE clause for a
      // string we do not control.
      const result = db.prepare(
        `UPDATE ${table}
            SET ${column} = ? || substr(${column}, ?)
          WHERE substr(${column}, 1, ?) = ?`
      ).run(to, from.length + 1, from.length, from);

      bump(`${table}.${column}`, result.changes);
    }
  }

  bump('messages.content_blocks', repairContentBlockPaths(db, mappings));

  return { updated };
}

/**
 * Attachment blocks carry the same path again inside their JSON metadata, and
 * the renderer resolves attachments from there.
 *
 * Only the machine-only prefixes are rewritten here. A blanket replace of the
 * profile root would also rewrite a message where someone simply mentioned
 * their old data directory, which is exactly the history this module promises
 * not to touch — and no attachment path is stored without the attachments
 * directory in it, so the narrower prefixes lose nothing.
 */
function repairContentBlockPaths(db: Database.Database, mappings: PrefixMapping[]): number {
  if (!tableHasColumn(db, 'messages', 'content_blocks')) return 0;

  let changes = 0;
  for (const { from, to, machineOnly } of mappings) {
    if (!machineOnly) continue;

    changes += db.prepare(
      `UPDATE messages
          SET content_blocks = replace(content_blocks, ?, ?)
        WHERE instr(content_blocks, ?) > 0`
    ).run(from, to, from).changes;
  }

  return changes;
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .some(c => c.name === column);
  } catch {
    return false;
  }
}
