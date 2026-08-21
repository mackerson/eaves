/**
 * Staging agent-authored plugins.
 *
 * A draft is an ordinary plugin directory under `userData/plugins-draft/`. It
 * is not installed: nothing discovers it at startup, nothing surfaces its view,
 * and it only ever runs because someone activated it in this session.
 *
 * Everything here treats the incoming spec as hostile. It is not — it comes
 * from a model the user is talking to — but the difference between "written by
 * an agent" and "written by an attacker steering an agent" is not something
 * this layer can see, and the operation on the other side is writing files and
 * then executing them.
 *
 * Defining is deliberately effect-free with respect to what is running. It
 * writes files and stops. Activation is a separate, separately-approved verb —
 * see SandboxedPluginManager.loadDraftPlugin.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSandboxedPluginManager } from './sandbox';
import { isInsideDirectory, readInstalledPluginId, sanitizeFolderName } from './sandbox/pathContainment';
import { PluginManifestSchema, validateWithSchema, isValidationFailure } from '../../shared/validation';
import { assertDestOwnership } from './MarketplaceService';
import { getPluginGrantsRepository } from '../repositories';
import { legacyEnv } from '../utils/legacyEnv';
import { getRenderReport, clearRenderReport } from './pluginRenderReports';
import { logger } from './logger';
import type { PluginDraft, PluginManifest } from '../../shared/types';

/**
 * Caps. These are not tuned — they are the point at which "a plugin" has
 * clearly become something else, and a staged directory that large is a
 * mistake worth failing loudly rather than writing.
 */
const MAX_FILES = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * Extensions a draft may contain. File contents cross as strings, so a binary
 * cannot be staged in the first place; this is the second layer, and it exists
 * because the worker's module blocking is advisory (see CLAUDE.md) — a staged
 * `.node` would be loadable if it could ever get here.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.json', '.css', '.svg', '.md', '.txt', '.html',
]);

export interface DraftFile {
  /** POSIX-style path relative to the plugin directory, e.g. `ui/index.js`. */
  path: string;
  content: string;
}

export interface DraftSpec {
  manifest: unknown;
  files: DraftFile[];
}

/** The renderer lists drafts too, so the shape is shared. */
export type DraftRecord = PluginDraft;

export class PluginDraftError extends Error {}

function draftsRoot(): string {
  return getSandboxedPluginManager().getDraftPluginsDir();
}

/**
 * Resolve one declared file path inside the plugin directory, or throw.
 *
 * Rejects absolute paths, traversal, and Windows-style separators before
 * resolving, then re-checks containment on the resolved path — the belt and
 * the braces, because a normalization difference between the two is exactly
 * how this class of check gets bypassed.
 */
function resolveDraftFile(pluginDir: string, declared: string): string {
  if (typeof declared !== 'string' || declared.trim() === '') {
    throw new PluginDraftError('Every file needs a non-empty path.');
  }
  if (declared.includes('\\')) {
    throw new PluginDraftError(`Use forward slashes in file paths: "${declared}"`);
  }
  if (path.posix.isAbsolute(declared) || path.isAbsolute(declared)) {
    throw new PluginDraftError(`File paths must be relative to the plugin directory: "${declared}"`);
  }
  if (declared.split('/').some(segment => segment === '..')) {
    throw new PluginDraftError(`File paths may not climb out of the plugin directory: "${declared}"`);
  }
  const extension = path.posix.extname(declared).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new PluginDraftError(
      `"${declared}" has extension "${extension || '(none)'}", which a draft may not contain. ` +
      `Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(', ')}`
    );
  }
  const resolved = path.resolve(pluginDir, declared);
  if (!isInsideDirectory(resolved, pluginDir)) {
    throw new PluginDraftError(`"${declared}" resolves outside the plugin directory.`);
  }
  return resolved;
}

function assertWithinCaps(files: DraftFile[]): void {
  if (files.length === 0) {
    throw new PluginDraftError('A draft needs at least its entry file.');
  }
  if (files.length > MAX_FILES) {
    throw new PluginDraftError(`A draft may contain at most ${MAX_FILES} files (got ${files.length}).`);
  }
  let total = 0;
  for (const file of files) {
    if (typeof file.content !== 'string') {
      throw new PluginDraftError(`"${file.path}" has no text content. Draft files are text only.`);
    }
    const bytes = Buffer.byteLength(file.content, 'utf-8');
    if (bytes > MAX_FILE_BYTES) {
      throw new PluginDraftError(`"${file.path}" is ${bytes} bytes; the per-file cap is ${MAX_FILE_BYTES}.`);
    }
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new PluginDraftError(`The draft totals ${total} bytes; the cap is ${MAX_TOTAL_BYTES}.`);
  }
}

/** The manifest a draft may have, or a thrown explanation of why it may not. */
function validateManifest(raw: unknown, files: DraftFile[]): PluginManifest {
  const withDefaults = { sandboxVersion: 1, ...(raw as Record<string, unknown>) };
  const validation = validateWithSchema(PluginManifestSchema, withDefaults);
  if (isValidationFailure(validation)) {
    throw new PluginDraftError(`Invalid plugin manifest: ${validation.error}`);
  }
  const manifest = validation.data as PluginManifest;

  // The schema caps sandboxVersion at the protocol this build implements, so
  // anything else already failed above. This is the positive assertion: a
  // draft that somehow arrived unsandboxed must not be written.
  if (manifest.sandboxVersion !== 1) {
    throw new PluginDraftError('A draft must declare "sandboxVersion": 1.');
  }

  const declared = new Set(files.map(file => file.path));
  const entry = manifest.entry ?? 'index.js';
  if (!declared.has(entry)) {
    throw new PluginDraftError(
      `The manifest names "${entry}" as its entry, but no file with that path was provided.`
    );
  }
  if (manifest.ui?.entry && !declared.has(manifest.ui.entry)) {
    throw new PluginDraftError(
      `The manifest names "${manifest.ui.entry}" as its UI bundle, but no file with that path was provided.`
    );
  }
  return manifest;
}

/** Refuse an id that something other than a draft already answers to. */
function assertIdIsAvailable(id: string): void {
  const manager = getSandboxedPluginManager();
  const existing = manager.getPluginManifest(id);
  if (existing && existing.source !== 'draft') {
    throw new PluginDraftError(
      `"${id}" is already the id of a loaded ${existing.source} plugin. Choose a different id.`
    );
  }
}

/**
 * Write a draft to disk, replacing any earlier draft with the same id.
 *
 * Refuses while that draft is running rather than deleting a directory out
 * from under a live worker: retracting first is one tool call, and it makes
 * "what is on disk" and "what is running" impossible to get out of step.
 */
export function writeDraft(spec: DraftSpec): DraftRecord {
  const files = Array.isArray(spec?.files) ? spec.files : [];
  assertWithinCaps(files);
  const manifest = validateManifest(spec?.manifest, files);
  assertIdIsAvailable(manifest.id);

  const manager = getSandboxedPluginManager();
  if (manager.isPluginLoaded(manifest.id)) {
    throw new PluginDraftError(
      `Draft "${manifest.id}" is running. Retract it before redefining it.`
    );
  }

  const folderName = sanitizeFolderName(manifest.id);
  const root = draftsRoot();
  const pluginDir = path.join(root, folderName);
  if (!isInsideDirectory(pluginDir, root)) {
    throw new PluginDraftError(`Refusing to write outside the draft directory: "${manifest.id}"`);
  }

  // Resolve every path before writing anything, so a rejected file cannot
  // leave a half-written draft behind.
  const resolved = files.map(file => ({ ...file, target: resolveDraftFile(pluginDir, file.path) }));
  const seen = new Set<string>();
  for (const file of resolved) {
    if (seen.has(file.target)) {
      throw new PluginDraftError(`"${file.path}" is declared twice.`);
    }
    seen.add(file.target);
  }

  // The old files are about to be replaced, so any recorded render outcome
  // describes code that will not exist in a moment.
  clearRenderReport(manifest.id);

  if (fs.existsSync(pluginDir)) {
    const occupant = readInstalledPluginId(pluginDir);
    if (occupant !== null && occupant !== manifest.id) {
      throw new PluginDraftError(
        `${pluginDir} holds a different draft ("${occupant}"). Retract that one first.`
      );
    }
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
  fs.mkdirSync(pluginDir, { recursive: true });

  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );
  for (const file of resolved) {
    fs.mkdirSync(path.dirname(file.target), { recursive: true });
    fs.writeFileSync(file.target, file.content, 'utf-8');
  }

  logger.info('[PluginDraft] Staged a draft', {
    id: manifest.id,
    files: resolved.length,
    permissions: manifest.permissions ?? [],
  });

  return toRecord(manifest, folderName, files.map(file => file.path));
}

function toRecord(manifest: PluginManifest, folderName: string, files: string[]): DraftRecord {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    description: manifest.description,
    folderName,
    permissions: manifest.permissions ?? [],
    files: [...files].sort(),
    running: getSandboxedPluginManager().isPluginLoaded(manifest.id),
    bundleUrl: manifest.ui?.entry ? `plugin://draft.${folderName}/${manifest.ui.entry}` : undefined,
    ui: manifest.ui,
    lastRender: getRenderReport(manifest.id),
  };
}

/** Every staged draft, whether or not it is running. */
export function listDrafts(): DraftRecord[] {
  const root = draftsRoot();
  if (!fs.existsSync(root)) return [];

  const records: DraftRecord[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(root, entry.name);
    let manifest: PluginManifest;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf-8'));
      const validation = validateWithSchema(PluginManifestSchema, raw);
      if (isValidationFailure(validation)) continue;
      manifest = validation.data as PluginManifest;
    } catch {
      continue; // an unreadable directory is not a draft we can report on
    }
    records.push(toRecord(manifest, entry.name, listFilesUnder(pluginDir, pluginDir)));
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

function listFilesUnder(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesUnder(full, root));
    else if (entry.name !== 'plugin.json') out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

/** One draft's manifest and source, for an agent reading back what it wrote. */
export function readDraft(id: string): { record: DraftRecord; files: DraftFile[] } | null {
  const record = listDrafts().find(draft => draft.id === id);
  if (!record) return null;

  const pluginDir = path.join(draftsRoot(), record.folderName);
  const files = record.files.map(relative => ({
    path: relative,
    content: fs.readFileSync(path.join(pluginDir, relative), 'utf-8'),
  }));
  return { record, files };
}

/**
 * Promotion: a draft stops being an experiment and becomes an installed plugin.
 *
 * This is the one place a draft crosses out of quarantine, so it is the one
 * place that asks. Consent is the same main-owned modal the marketplace uses —
 * not renderer UI — because after this the plugin's bundle is import()ed into
 * the main window's realm, where renderer-drawn dialogs can be spoofed. The
 * copy differs (`kind: 'promote'`): there was no download and no checksum, and
 * saying otherwise would be a lie at the exact moment it matters.
 *
 * There is deliberately no agent tool for this. An agent can write a plugin and
 * run it; only a person can install one. That keeps a prompt-injected agent
 * from even being able to ask, which is a stronger property than any dialog.
 *
 * One-way per id: `writeDraft` refuses an id an installed plugin holds, so
 * shipping a v2 means uninstalling first. Installed code is not agent-rewritable.
 */
export async function promoteDraft(id: string): Promise<{ id: string; folderName: string }> {
  const staged = readDraft(id);
  if (!staged) throw new PluginDraftError(`No draft with id "${id}".`);

  const manager = getSandboxedPluginManager();
  const existing = manager.getPluginManifest(id);
  if (existing && existing.source !== 'draft') {
    throw new PluginDraftError(
      `"${id}" is already the id of a loaded ${existing.source} plugin.`
    );
  }

  const permissions = staged.record.permissions;
  const approved = await promptPromotionConsent(staged.record);
  if (!approved) throw new PluginDraftError('Keeping this plugin was cancelled.');

  const userRoot = manager.getUserPluginsDir();
  const dest = path.join(userRoot, staged.record.folderName);
  if (!isInsideDirectory(dest, userRoot)) {
    throw new PluginDraftError(`Refusing to install outside the plugins directory: ${dest}`);
  }
  // Ownership, not just containment: dest may already hold a different plugin.
  assertDestOwnership(dest, id);

  const draftDir = path.join(draftsRoot(), staged.record.folderName);
  if (manager.isPluginLoaded(id)) await manager.unloadPlugin(id); // free the files

  // Copy, load, and only then drop the draft. A rename would be atomic but
  // cannot cross a filesystem boundary, and more importantly it would destroy
  // the draft before we know the install loads. If the load fails, the copy is
  // rolled back and the draft is still there to fix.
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(draftDir, dest, { recursive: true });

  try {
    await manager.loadUserPlugin(staged.record.folderName);
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new PluginDraftError(
      `"${id}" failed to load as an installed plugin, so nothing was kept and the draft is untouched: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  fs.rmSync(draftDir, { recursive: true, force: true });
  getPluginGrantsRepository().set(id, permissions, staged.record.version, Date.now());
  logger.info('[PluginDraft] Promoted a draft to an installed plugin', { id, permissions });

  return { id, folderName: staged.record.folderName };
}

/**
 * Ask, unless a headless test has pre-answered. Mirrors the marketplace's
 * `EAVES_PLUGIN_AUTO_CONSENT` escape hatch (1 = approve, 0 = decline) — the
 * same flag, because a second one would be a second thing to get wrong.
 */
async function promptPromotionConsent(draft: DraftRecord): Promise<boolean> {
  const flag = legacyEnv('EAVES_PLUGIN_AUTO_CONSENT');
  if (flag === '1') return true;
  if (flag === '0') return false;

  const { showPluginConsent } = await import('../windows/pluginConsentWindow');
  return showPluginConsent({
    kind: 'promote',
    name: draft.name,
    author: 'an agent in this app',
    version: draft.version,
    tier: 'draft',
    homepage: '',
    permissions: draft.permissions,
  });
}
