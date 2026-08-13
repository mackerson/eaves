import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { validateProjectPath } from './pathValidation';

// path.resolve normalizes to the host platform, so these hold cross-platform.
const root = path.resolve('/projects/number-1');

describe('validateProjectPath', () => {
  it('allows a file inside the project', () => {
    expect(validateProjectPath(root, 'notes/todo.md')).toBe(path.join(root, 'notes', 'todo.md'));
  });

  it('allows the project root itself (list ".")', () => {
    expect(validateProjectPath(root, '.')).toBe(root);
  });

  it('normalizes nested traversal that stays inside', () => {
    expect(validateProjectPath(root, 'a/../b/c.txt')).toBe(path.join(root, 'b', 'c.txt'));
  });

  it('rejects a sibling that shares the path prefix (the startsWith escape)', () => {
    // /projects/number-1-backup startsWith /projects/number-1 — the old check
    // served it. path.relative makes it climb out (../), so it's rejected.
    expect(() => validateProjectPath(root, '../number-1-backup/secret.txt')).toThrow(/Access denied/);
  });

  it('rejects ../ climbing out of the project', () => {
    expect(() => validateProjectPath(root, '../../etc/passwd')).toThrow(/Access denied/);
  });

  it('rejects an absolute path outside the project', () => {
    expect(() => validateProjectPath(root, '/etc/passwd')).toThrow(/Access denied/);
  });
});
