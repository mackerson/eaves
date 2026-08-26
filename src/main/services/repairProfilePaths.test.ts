/**
 * Tests for repointing absolute paths that used to live inside the profile.
 *
 * The distinction under test is the whole point: a project directory the app
 * created lives inside userData and moved with the rename; one the user picked
 * themselves did not. Only a prefix match tells them apart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';

import { repairProfilePaths } from './repairProfilePaths';

// Profile roots in the running platform's own shape, and every path below them
// built with path.join. repairProfilePaths compares prefixes using path.sep, so
// POSIX literals here matched nothing at all on Windows: each assertion failed
// against a path the code had quite correctly declined to touch.
const HOME = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u';
const BASE =
  process.platform === 'win32' ? path.join(HOME, 'AppData', 'Roaming') : path.join(HOME, '.config');
const LEGACY = path.join(BASE, 'enclave');
const CURRENT = path.join(BASE, 'eaves');

describe('repairProfilePaths', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message_attachments (id TEXT PRIMARY KEY, stored_path TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, content_blocks TEXT);
    `);
  });

  afterEach(() => db.close());

  const directoryOf = (id: string) =>
    (db.prepare('SELECT directory FROM projects WHERE id = ?').get(id) as { directory: string }).directory;

  it('repoints a project directory the app created inside the profile', () => {
    db.prepare('INSERT INTO projects VALUES (?, ?)')
      .run('managed', path.join(LEGACY, 'projects', 'personal-a3c27b5c'));

    const { updated } = repairProfilePaths(db, LEGACY, CURRENT);

    expect(directoryOf('managed')).toBe(path.join(CURRENT, 'projects', 'personal-a3c27b5c'));
    expect(updated['projects.directory']).toBe(1);
  });

  it('leaves a project directory the user chose alone', () => {
    // Nothing moved it, so rewriting it would point the project at a path that
    // does not exist.
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('external', path.join(HOME, 'code', 'myapp'));
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('lookalike', path.join(BASE, 'enclave-notes', 'x'));

    repairProfilePaths(db, LEGACY, CURRENT);

    expect(directoryOf('external')).toBe(path.join(HOME, 'code', 'myapp'));
    // Matching the root without its separator would have caught this sibling.
    expect(directoryOf('lookalike')).toBe(path.join(BASE, 'enclave-notes', 'x'));
  });

  it('repoints attachment paths, interior directory names included', () => {
    // The real legacy shape: BOTH the profile root and the two directory names
    // below it changed. Substituting only the root leaves a path that looks
    // repaired and still points at nothing.
    db.prepare('INSERT INTO message_attachments VALUES (?, ?)')
      .run('a', path.join(LEGACY, 'enclave-data', 'enclave-attachments', 'abc.png'));

    repairProfilePaths(db, LEGACY, CURRENT);

    const row = db.prepare('SELECT stored_path FROM message_attachments').get() as { stored_path: string };
    expect(row.stored_path).toBe(path.join(CURRENT, 'eaves-data', 'eaves-attachments', 'abc.png'));
  });

  it('repoints a path left half-migrated under the new root', () => {
    // What an interruption between the profile move and the interior rename
    // leaves behind.
    db.prepare('INSERT INTO message_attachments VALUES (?, ?)')
      .run('a', path.join(CURRENT, 'enclave-data', 'enclave-attachments', 'abc.png'));

    repairProfilePaths(db, LEGACY, CURRENT);

    const row = db.prepare('SELECT stored_path FROM message_attachments').get() as { stored_path: string };
    expect(row.stored_path).toBe(path.join(CURRENT, 'eaves-data', 'eaves-attachments', 'abc.png'));
  });

  it('repoints the copy of the path inside content blocks', () => {
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('m', JSON.stringify([
      { type: 'text', text: 'here it is' },
      { type: 'attachment', metadata: { storedPath: path.join(LEGACY, 'enclave-data', 'enclave-attachments', 'x.png') } },
    ]));

    repairProfilePaths(db, LEGACY, CURRENT);

    const row = db.prepare('SELECT content_blocks FROM messages').get() as { content_blocks: string };
    const blocks = JSON.parse(row.content_blocks);
    expect(blocks[1].metadata.storedPath).toBe(path.join(CURRENT, 'eaves-data', 'eaves-attachments', 'x.png'));
    expect(blocks[0].text).toBe('here it is');
  });

  it('does not rewrite prose that quotes the old profile path', () => {
    // The absolute root is something a person can plausibly have typed into a
    // message. Only the attachment-directory prefixes are specific enough to
    // rewrite inside conversation content.
    const prose = `my data used to live in ${LEGACY}${path.sep} and I moved it`;
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('m', JSON.stringify([
      { type: 'text', text: prose },
    ]));

    repairProfilePaths(db, LEGACY, CURRENT);

    const row = db.prepare('SELECT content_blocks FROM messages').get() as { content_blocks: string };
    expect(JSON.parse(row.content_blocks)[0].text).toBe(prose);
  });

  it('is idempotent and reports nothing on a second run', () => {
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('managed', path.join(LEGACY, 'projects', 'p'));

    repairProfilePaths(db, LEGACY, CURRENT);
    const { updated } = repairProfilePaths(db, LEGACY, CURRENT);

    expect(updated).toEqual({});
    expect(directoryOf('managed')).toBe(path.join(CURRENT, 'projects', 'p'));
  });

  it('survives a schema without the optional tables', () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, directory TEXT)');

    expect(() => repairProfilePaths(bare, LEGACY, CURRENT)).not.toThrow();
    bare.close();
  });
});
