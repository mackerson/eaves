/**
 * Tests for repointing absolute paths that used to live inside the profile.
 *
 * The distinction under test is the whole point: a project directory the app
 * created lives inside userData and moved with the rename; one the user picked
 * themselves did not. Only a prefix match tells them apart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { repairProfilePaths } from './repairProfilePaths';

const LEGACY = '/home/u/.config/enclave';
const CURRENT = '/home/u/.config/eaves';

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
      .run('managed', `${LEGACY}/projects/personal-a3c27b5c`);

    const { updated } = repairProfilePaths(db, LEGACY, CURRENT);

    expect(directoryOf('managed')).toBe(`${CURRENT}/projects/personal-a3c27b5c`);
    expect(updated['projects.directory']).toBe(1);
  });

  it('leaves a project directory the user chose alone', () => {
    // Nothing moved it, so rewriting it would point the project at a path that
    // does not exist.
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('external', '/home/u/code/myapp');
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('lookalike', '/home/u/.config/enclave-notes/x');

    repairProfilePaths(db, LEGACY, CURRENT);

    expect(directoryOf('external')).toBe('/home/u/code/myapp');
    // Matching the root without its separator would have caught this sibling.
    expect(directoryOf('lookalike')).toBe('/home/u/.config/enclave-notes/x');
  });

  it('repoints attachment paths, which are read straight off the column', () => {
    db.prepare('INSERT INTO message_attachments VALUES (?, ?)')
      .run('a', `${LEGACY}/enclave-data/enclave-attachments/abc.png`);

    repairProfilePaths(db, LEGACY, CURRENT);

    const row = db.prepare('SELECT stored_path FROM message_attachments').get() as { stored_path: string };
    expect(row.stored_path).toBe(`${CURRENT}/enclave-data/enclave-attachments/abc.png`);
  });

  it('repoints the copy of the path inside content blocks', () => {
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('m', JSON.stringify([
      { type: 'text', text: 'here it is' },
      { type: 'attachment', metadata: { storedPath: `${LEGACY}/eaves-data/eaves-attachments/x.png` } },
    ]));

    repairProfilePaths(db, LEGACY, CURRENT);

    const row = db.prepare('SELECT content_blocks FROM messages').get() as { content_blocks: string };
    const blocks = JSON.parse(row.content_blocks);
    expect(blocks[1].metadata.storedPath).toBe(`${CURRENT}/eaves-data/eaves-attachments/x.png`);
    expect(blocks[0].text).toBe('here it is');
  });

  it('does not rewrite prose that merely mentions the old name', () => {
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('m', JSON.stringify([
      { type: 'text', text: 'I used to call this Enclave, in ~/.config/enclave land' },
    ]));

    repairProfilePaths(db, LEGACY, CURRENT);

    const row = db.prepare('SELECT content_blocks FROM messages').get() as { content_blocks: string };
    expect(JSON.parse(row.content_blocks)[0].text)
      .toBe('I used to call this Enclave, in ~/.config/enclave land');
  });

  it('is idempotent and reports nothing on a second run', () => {
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('managed', `${LEGACY}/projects/p`);

    repairProfilePaths(db, LEGACY, CURRENT);
    const { updated } = repairProfilePaths(db, LEGACY, CURRENT);

    expect(updated).toEqual({});
    expect(directoryOf('managed')).toBe(`${CURRENT}/projects/p`);
  });

  it('survives a schema without the optional tables', () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, directory TEXT)');

    expect(() => repairProfilePaths(bare, LEGACY, CURRENT)).not.toThrow();
    bare.close();
  });
});
