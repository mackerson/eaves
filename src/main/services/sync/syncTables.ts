/**
 * Runtime registry of tables replicated by LAN sync.
 *
 * Must stay a SUPERSET of the trigger sets installed by migrations (the v52
 * baseline installs triggers for exactly this list). Adding a table here
 * requires a new migration installing its triggers — see
 * seedSyncIdentityAndTriggers in migrations.ts.
 *
 * Composite primary keys are encoded in oplog row_id as values joined with
 * '|' in the order listed (matches the trigger expressions).
 */
export interface SyncedTable {
  /** Primary key column(s), in row_id encoding order. */
  pk: string[];
}

export const SYNCED_TABLES: Record<string, SyncedTable> = {
  agents: { pk: ['id'] },
  projects: { pk: ['id'] },
  users: { pk: ['id'] },
  channels: { pk: ['id'] },
  messages: { pk: ['id'] },
  tasks: { pk: ['id'] },
  notes: { pk: ['id'] },
  channel_participants: { pk: ['channel_id', 'participant_id'] },
  conversation_folders: { pk: ['id'] },
};

export function isSyncedTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(SYNCED_TABLES, table);
}

/** Split an oplog row_id back into PK values for the given table. */
export function decodeRowId(table: string, rowId: string): string[] {
  const def = SYNCED_TABLES[table];
  if (!def) throw new Error(`Not a synced table: ${table}`);
  if (def.pk.length === 1) return [rowId];
  const parts = rowId.split('|');
  if (parts.length !== def.pk.length) {
    throw new Error(`Malformed row_id for ${table}: expected ${def.pk.length} parts`);
  }
  return parts;
}
