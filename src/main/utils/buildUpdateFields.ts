/**
 * Shared SQL field mapping utilities for repositories.
 * Eliminates hand-maintained column lists and positional parameters.
 *
 * Transforms:
 *  - 'direct': pass value as-is (default for UPDATE), null for undefined (INSERT)
 *  - 'nullable': convert falsy to null (empty string → null; use for strings)
 *  - 'numeric': null only for null/undefined — preserves a valid 0 (use for numbers)
 *  - 'json': JSON.stringify truthy, null for falsy
 *  - 'boolInt': convert boolean to 1/0
 */
type FieldTransform = 'direct' | 'nullable' | 'numeric' | 'json' | 'boolInt';

interface FieldDef {
  column: string;
  transform?: FieldTransform;
}

export type FieldMap<T> = Partial<Record<keyof T & string, string | FieldDef>>;

export function buildUpdateFields<T extends Record<string, unknown>>(
  updates: T,
  fieldMap: FieldMap<T>
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, mapping] of Object.entries(fieldMap)) {
    const value = updates[key];
    if (value === undefined) continue;

    const def: FieldDef = typeof mapping === 'string'
      ? { column: mapping }
      : mapping as FieldDef;

    clauses.push(`${def.column} = ?`);

    switch (def.transform) {
      case 'nullable':
        params.push(value || null);
        break;
      case 'numeric':
        params.push(value ?? null);
        break;
      case 'json':
        params.push(value ? JSON.stringify(value) : null);
        break;
      case 'boolInt':
        params.push(value ? 1 : 0);
        break;
      default:
        params.push(value);
    }
  }

  return { clauses, params };
}

/**
 * Build SQL INSERT columns and params from a data object and a field mapping.
 * Unlike buildUpdateFields, this includes ALL mapped fields — undefined values
 * become null (or their appropriate transform default).
 *
 * Usage:
 *   const { columns, placeholders, params } = buildInsertFields(data, fieldMap);
 *   db.prepare(`INSERT INTO t (${columns}) VALUES (${placeholders})`).run(...params);
 */
export function buildInsertFields<T extends Record<string, unknown>>(
  data: T,
  fieldMap: FieldMap<T>
): { columns: string[]; placeholders: string[]; params: unknown[] } {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const params: unknown[] = [];

  for (const [key, mapping] of Object.entries(fieldMap)) {
    const value = data[key];
    const def: FieldDef = typeof mapping === 'string'
      ? { column: mapping }
      : mapping as FieldDef;

    columns.push(def.column);
    placeholders.push('?');

    switch (def.transform) {
      case 'nullable':
        params.push(value || null);
        break;
      case 'numeric':
        params.push(value ?? null);
        break;
      case 'json':
        params.push(value ? JSON.stringify(value) : null);
        break;
      case 'boolInt':
        params.push(value ? 1 : 0);
        break;
      default:
        params.push(value ?? null);
    }
  }

  return { columns: columns, placeholders, params };
}
