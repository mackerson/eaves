import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as tar from 'tar';
import { getSandboxedPluginManager } from './sandbox';
import { isInsideDirectory, sanitizeFolderName } from './sandbox/pathContainment';
import { getPluginGrantsRepository } from '../repositories';
import { logger } from './logger';

/**
 * Plugin marketplace — V1.
 *
 * First-party, GitHub-backed: fetch a curated static registry, and install a
 * plugin by downloading its published release bundle, verifying the sha256 in
 * the registry, unpacking it into userData/plugins/ (zip-slip guarded), and
 * loading it via the sandbox manager. No hosting/signing infra; the curated
 * registry + checksum integrity is the V1 trust root. The renderer passes only
 * a registry id — never a URL — so install is confined to registry entries.
 */

const REGISTRY_URL =
  process.env.ENCLAVE_REGISTRY_URL ||
  'https://raw.githubusercontent.com/mackerson/enclave-plugin-registry/main/registry.json';

export interface RegistryRelease {
  tag: string;
  asset: string;
  url: string;
  sha256: string;
}
export interface RegistryPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage: string;
  tier: string;
  latest: string;
  minAppVersion?: string;
  permissions: string[];
  release: RegistryRelease | null;
}
interface Registry {
  schemaVersion: number;
  updated: string;
  plugins: RegistryPlugin[];
}

const EMPTY: Registry = { schemaVersion: 1, updated: '', plugins: [] };
let cached: Registry | null = null;

function cachePath(): string {
  return path.join(app.getPath('userData'), 'marketplace', 'registry.json');
}

function isRegistry(v: unknown): v is Registry {
  return !!v && typeof v === 'object'
    && (v as Registry).schemaVersion === 1
    && Array.isArray((v as Registry).plugins);
}

/** Fetch the registry (main-process, over TLS), cache to disk, fall back to the
 *  on-disk cache when offline. Returns an empty registry if nothing is available. */
export async function fetchRegistry(force = false): Promise<Registry> {
  if (cached && !force) return cached;
  try {
    const res = await fetch(REGISTRY_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const data = await res.json();
    if (!isRegistry(data)) throw new Error('malformed registry');
    cached = data;
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(data));
    return data;
  } catch (err) {
    logger.warn('[Marketplace] registry fetch failed, trying disk cache:', err);
    try {
      const disk = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
      if (isRegistry(disk)) { cached = disk; return disk; }
    } catch { /* no cache */ }
    return EMPTY;
  }
}

/** Registry + the set of currently-installed (user-source) plugin ids/versions. */
export async function getMarketplaceListing(): Promise<{
  plugins: RegistryPlugin[];
  installed: Record<string, string>; // id -> installed version
}> {
  const reg = await fetchRegistry();
  const manager = getSandboxedPluginManager();
  const installed: Record<string, string> = {};
  for (const m of manager.getLoadedPlugins()) {
    if ((m as unknown as { source?: string }).source === 'user') {
      installed[m.id] = (m as unknown as { version: string }).version;
    }
  }
  return { plugins: reg.plugins, installed };
}

/** Human-readable labels for the permission grants shown at install consent. */
const PERMISSION_LABELS: Record<string, string> = {
  'data:agents:read': 'Read your agents',
  'data:agents:write': 'Create or modify agents',
  'data:chats:read': 'Read your chats',
  'data:chats:write': 'Create or modify chats',
  'data:messages:read': 'Read messages',
  'data:messages:write': 'Write messages',
  'data:projects:read': 'Read projects',
  'data:projects:write': 'Modify projects',
  'storage:read': 'Read its own stored data',
  'storage:write': 'Store its own data',
  'tools:register': 'Add tools your agents can use',
  'services:register': 'Provide services to other plugins',
  'services:call': 'Use services from other plugins',
  'ui:views:register': 'Add its own views to the app',
  'ui:notifications:show': 'Show notifications',
  'events:listen': 'Observe app events',
  'events:emit': 'Emit app events',
  'network:http': 'Make network requests',
  'system:filesystem': 'Read and write files on your computer',
};

function permsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((p) => sa.has(p));
}

/**
 * Host-enforced pre-install consent. Because the marketplace UI runs unsandboxed
 * in the renderer and can call install directly, consent must be shown by a
 * trusted surface the plugin can't spoof — a native dialog from main. Returns
 * true if the user approves. `ENCLAVE_PLUGIN_AUTO_CONSENT` (1=approve, 0=decline)
 * bypasses the dialog for headless tests only.
 */
async function promptConsent(entry: RegistryPlugin): Promise<boolean> {
  const flag = process.env.ENCLAVE_PLUGIN_AUTO_CONSENT;
  if (flag === '1') return true;
  if (flag === '0') return false;

  const { dialog, BrowserWindow } = await import('electron');
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const perms = entry.permissions.length
    ? entry.permissions.map((p) => `  • ${PERMISSION_LABELS[p] || p}`).join('\n')
    : '  • No special access';
  const opts = {
    type: 'question' as const,
    buttons: ['Cancel', 'Install'],
    defaultId: 1,
    cancelId: 0,
    title: 'Install plugin',
    message: `Install “${entry.name}” by ${entry.author}?`,
    detail: `This plugin will be able to:\n${perms}\n\nSource: ${entry.homepage}`,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return response === 1;
}

/**
 * Refuse to clear `dest` unless it's empty/unoccupied or its own plugin.json
 * already declares this same id (legitimate upgrade-in-place). `folderName`
 * is now derived from the full id so two different ids can't collide going
 * forward, but a directory installed under the old collapsed name — before
 * this fix — can still occupy the path a new id resolves to. Fail closed: an
 * unreadable/mismatched manifest blocks the overwrite rather than allowing it.
 */
export function assertDestOwnership(dest: string, id: string): void {
  const manifestPath = path.join(dest, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return; // nothing plugin-shaped occupies dest
  let existingId: string | undefined;
  try {
    existingId = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))?.id;
  } catch { /* malformed manifest — treated as a mismatch below, fails closed */ }
  if (existingId !== id) {
    throw new Error(
      `Refusing to install "${id}": ${dest} is occupied by a different plugin` +
      (existingId ? ` ("${existingId}")` : ' (its manifest could not be read)') + '.'
    );
  }
}

/**
 * Retire the pre-fix install directory for `id`, if one exists and is not the
 * new destination. Installs before `sanitizeFolderName` landed used the last
 * dot-segment, so upgrading `com.alice.notes` now writes `com-alice-notes` and
 * would strand the old `notes/` directory — leaving two directories declaring
 * the same id for discovery to load. Guarded twice: the legacy path must stay
 * inside the plugins dir, and its manifest must claim this exact id.
 */
export function removeLegacyCollapsedInstall(userPluginsDir: string, id: string, dest: string): void {
  const legacyName = id.split('.').pop();
  if (!legacyName || legacyName === path.basename(dest)) return;
  const legacyDir = path.join(userPluginsDir, legacyName);
  if (legacyDir === dest || !isInsideDirectory(legacyDir, userPluginsDir)) return;
  const manifestPath = path.join(legacyDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return;
  try {
    if (JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))?.id !== id) return;
  } catch {
    return; // unreadable manifest: not provably ours, so leave it alone
  }
  fs.rmSync(legacyDir, { recursive: true, force: true });
  logger.info(`[Marketplace] removed legacy install directory for ${id}`, { legacyDir });
}

/** Semver-ish compare of dotted versions. a<b -> -1, a==b -> 0, a>b -> 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Install (or update) a plugin by its registry id. Steps: resolve in the cached
 * registry -> download the release asset -> verify sha256 -> unpack (zip-slip
 * guarded) -> validate manifest (id match + sandboxVersion) -> move into
 * userData/plugins/<folder> -> loadPlugin. Throws with a user-facing message on
 * any failure; leaves no partial install.
 */
export async function installPlugin(id: string): Promise<{ id: string; folderName: string; version: string }> {
  const reg = await fetchRegistry();
  const entry = reg.plugins.find((p) => p.id === id);
  if (!entry) throw new Error(`"${id}" is not in the plugin registry`);
  if (!entry.release) throw new Error(`"${entry.name}" has no published build yet`);
  if (entry.minAppVersion && compareVersions(app.getVersion(), entry.minAppVersion) < 0) {
    throw new Error(`"${entry.name}" needs Enclave ${entry.minAppVersion}+ (you have ${app.getVersion()})`);
  }
  const { url, sha256 } = entry.release;
  if (!url.startsWith('https://') && !url.startsWith('http://localhost')) {
    throw new Error('release url must be https');
  }

  // Pre-install consent (host-enforced). Skip only if the user already consented
  // to this exact permission set (re-install / same-perm update).
  const grants = getPluginGrantsRepository();
  const priorGrant = grants.get(id);
  if (!priorGrant || !permsEqual(priorGrant.permissions, entry.permissions)) {
    const approved = await promptConsent(entry);
    if (!approved) throw new Error('Installation cancelled');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-plugin-'));
  try {
    // 1. download
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tgz = path.join(tmpDir, 'bundle.tgz');
    fs.writeFileSync(tgz, buf);

    // 2. verify integrity
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== sha256) {
      throw new Error(`checksum mismatch — expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…`);
    }

    // 3. unpack with a zip-slip guard (reject entries escaping the stage dir)
    const stage = path.join(tmpDir, 'unpacked');
    fs.mkdirSync(stage);
    await tar.extract({
      file: tgz,
      cwd: stage,
      filter: (entryPath) => {
        const rel = path.relative(stage, path.resolve(stage, entryPath));
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      },
    });

    // 4. validate the unpacked manifest
    const manifestPath = path.join(stage, 'plugin.json');
    if (!fs.existsSync(manifestPath)) throw new Error('bundle is missing plugin.json at its root');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (manifest.id !== id) throw new Error(`bundle id "${manifest.id}" does not match "${id}"`);
    if (manifest.sandboxVersion !== 1) throw new Error('bundle manifest is missing "sandboxVersion": 1');
    // Consent honesty: the bundle must request exactly the permissions the
    // registry declared (which the user consented to) — no silent escalation.
    if (!permsEqual(manifest.permissions || [], entry.permissions)) {
      throw new Error('bundle requests permissions that differ from the registry listing');
    }

    // 5. move into place (cpSync handles a cross-filesystem tmp -> userData move)
    const manager = getSandboxedPluginManager();
    const folderName = sanitizeFolderName(id);
    const dest = path.join(manager.getUserPluginsDir(), folderName);
    // Containment: never rm/cp outside the plugins dir even if a registry id
    // yields a stray folderName (mirrors removeUserPlugin's guard).
    if (!isInsideDirectory(dest, manager.getUserPluginsDir())) {
      throw new Error(`Refusing to install plugin outside the plugins directory: ${dest}`);
    }
    if (manager.isPluginLoaded(id)) await manager.unloadPlugin(id); // free files for update
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Ownership, not just containment: dest may already hold a different
    // plugin (e.g. installed pre-fix under a collapsed folder name).
    assertDestOwnership(dest, id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(stage, dest, { recursive: true });
    // Upgrading a plugin installed before the folder-name fix would otherwise
    // leave its old collapsed-name directory behind, and discovery would then
    // load two directories declaring the same id. Only ever removes a
    // directory whose manifest claims *this* id.
    removeLegacyCollapsedInstall(manager.getUserPluginsDir(), id, dest);

    // 6. load (no restart) + record the consented grant
    await manager.loadUserPlugin(folderName);
    grants.set(id, entry.permissions, entry.latest, Date.now());
    logger.info(`[Marketplace] installed ${id}@${entry.latest}`);
    return { id, folderName, version: entry.latest };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Uninstall a user-installed plugin (worker stop + folder removal + state/grant drop). */
export async function uninstallPlugin(id: string): Promise<void> {
  await getSandboxedPluginManager().removeUserPlugin(id);
  getPluginGrantsRepository().delete(id);
  logger.info(`[Marketplace] uninstalled ${id}`);
}
