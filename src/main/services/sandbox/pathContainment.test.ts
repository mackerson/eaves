import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isInsideDirectory, readInstalledPluginId } from './pathContainment';

// path.resolve normalizes to the host platform (drive letters on Windows,
// POSIX roots elsewhere), so these assertions hold cross-platform.
describe('isInsideDirectory', () => {
  const parent = path.resolve('/plugins/foo');

  it('allows a file directly inside the directory', () => {
    expect(isInsideDirectory(path.resolve('/plugins/foo/index.js'), parent)).toBe(true);
  });

  it('allows a deeply nested file', () => {
    expect(isInsideDirectory(path.resolve('/plugins/foo/lib/util.js'), parent)).toBe(true);
  });

  it('rejects the directory itself (empty relative path)', () => {
    expect(isInsideDirectory(parent, parent)).toBe(false);
  });

  it('rejects a sibling directory with a shared name prefix (the escape)', () => {
    // The bug: 'startsWith("/plugins/foo")' was true for '/plugins/foo-bar'.
    expect(isInsideDirectory(path.resolve('/plugins/foo-bar/evil.js'), parent)).toBe(false);
  });

  it('rejects a parent-traversal sibling', () => {
    expect(isInsideDirectory(path.resolve('/plugins/other/x.js'), parent)).toBe(false);
  });

  it('rejects an explicit ../ escape', () => {
    expect(isInsideDirectory(path.resolve(parent, '../bar/evil.js'), parent)).toBe(false);
  });
});

describe('readInstalledPluginId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-owner-'));

  const write = (name: string, contents: string) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'plugin.json'), contents);
    return d;
  };

  it('reads the id a directory declares', () => {
    expect(readInstalledPluginId(write('good', '{"id":"com.alice.notes"}')))
      .toBe('com.alice.notes');
  });

  it('returns null for a directory with no manifest', () => {
    const d = path.join(dir, 'bare');
    fs.mkdirSync(d, { recursive: true });
    expect(readInstalledPluginId(d)).toBeNull();
  });

  it('returns null for a directory that does not exist', () => {
    expect(readInstalledPluginId(path.join(dir, 'nope'))).toBeNull();
  });

  // Unidentifiable, not "any id" — a caller about to rmSync must not read a
  // malformed manifest as permission.
  it('returns null for a malformed manifest', () => {
    expect(readInstalledPluginId(write('broken', '{not json'))).toBeNull();
  });

  it('returns null when the manifest declares no id', () => {
    expect(readInstalledPluginId(write('anonymous', '{"name":"x"}'))).toBeNull();
  });

  it('returns null when the id is not a string', () => {
    expect(readInstalledPluginId(write('numeric', '{"id":42}'))).toBeNull();
  });
});
