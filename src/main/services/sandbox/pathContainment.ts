import * as fs from 'fs';
import * as path from 'path';

/**
 * True when `child` resolves to a path strictly inside `parent`.
 *
 * Replaces an unsafe `resolvedPath.startsWith(pluginDir)` containment check.
 * `startsWith` let a sandboxed plugin escape its directory two ways:
 *   - sibling-prefix: `/plugins/foo-bar/evil.js`.startsWith(`/plugins/foo`) is
 *     true, so a plugin in `foo` could require modules from sibling `foo-bar`;
 *   - on Windows, byte-for-byte comparison ignored separator (`\`) and the
 *     case-insensitivity of NTFS volumes.
 *
 * Using path.relative + normalize fixes both: a path is contained only when the
 * relative path from parent to child is non-empty, not absolute, and does not
 * start with `..` (i.e. does not climb out of the directory).
 */
export function isInsideDirectory(child: string, parent: string): boolean {
  const relative = path.relative(path.normalize(parent), path.normalize(child));
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

/**
 * A plugin id folded into a single safe path segment.
 *
 * Install and uninstall used to derive the directory independently as
 * `id.split('.').pop()`, which collapsed `com.alice.notes` and `org.bob.notes`
 * onto the same `plugins/notes` — installing one deleted the other out from
 * under its running worker. Both sites now call this, because the bug was not
 * the derivation itself but that there were two of them: whatever install
 * writes, uninstall has to be able to name exactly. `PluginIdSchema` admits
 * only `[a-zA-Z0-9._-]`, so in practice this just folds `.` to `-`.
 */
export function sanitizeFolderName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * The plugin id a directory declares, or null when it declares none that can
 * be read.
 *
 * Containment answers "is this path inside the plugins directory"; it cannot
 * answer "is this path the plugin I was asked about". Both install and
 * uninstall need the second question, because a folder name derived from an
 * id is a guess about what occupies that path, not proof — and the operation
 * on the other side of the guess is `rmSync`.
 *
 * A missing or malformed manifest returns null rather than throwing, so each
 * caller decides what an unidentifiable directory means for the thing it is
 * about to do.
 */
export function readInstalledPluginId(dir: string): string | null {
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const id = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
