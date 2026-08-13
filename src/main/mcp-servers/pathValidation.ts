import * as path from 'path';

/**
 * Resolve `filePath` against `projectRoot` and confirm the result stays inside
 * the project directory (or is the root itself). Returns the absolute path, or
 * throws if it escapes.
 *
 * Uses path.relative rather than `absolute.startsWith(projectRoot)`: the latter
 * let a sibling that shares the path prefix (…/proj-backup vs …/proj) through,
 * so an agent could read/write/delete outside its project via the filesystem
 * MCP tools. The root itself is allowed so `list_directory "."` still works.
 */
export function validateProjectPath(projectRoot: string, filePath: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, filePath);
  const rel = path.relative(root, absolute);
  if (absolute !== root && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error('Access denied: Path is outside project directory');
  }
  return absolute;
}
