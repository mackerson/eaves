import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeFolderName } from './sandbox/pathContainment';

/**
 * One-time move of the on-disk profile from the Enclave name to the Eaves one.
 *
 * `app.getPath('userData')` is derived from the package name, so the rename
 * silently pointed every install at an empty directory: the app would come up
 * looking like a fresh install with the user's conversations, agents, plugins
 * and API keys still sitting under the old path.
 *
 * This runs as early in main as it can, but it cannot be genuinely first:
 * module-level side effects in anything main imports happen before any
 * statement in main does, and Electron itself writes into userData during
 * startup. So the destination existing is the normal case, not the exception,
 * and the merge below is what actually makes this correct — not the ordering.
 */

const LEGACY_APP_DIR = 'enclave';
const LEGACY_DATA_DIR = 'enclave-data';
const LEGACY_DB = 'enclave.db';
const LEGACY_ATTACHMENTS = 'enclave-attachments';

const DATA_DIR = 'eaves-data';
const DB = 'eaves.db';
const ATTACHMENTS = 'eaves-attachments';

/**
 * Written only once every step has completed. The migration's own progress is
 * not inferable from the files, because the work continues past the point
 * where the profile already looks migrated.
 */
const MARKER = '.migrated-from-enclave';

/** Plugin ids the project owns. A third-party id is never ours to rewrite. */
const LEGACY_ID_PREFIX = 'com.enclave.';
const ID_PREFIX = 'com.eaves.';

/**
 * Chromium's process-singleton state. Never migrated: these encode a pid, a
 * host and a socket path belonging to whichever process created them, and
 * `app.requestSingleInstanceLock()` would then evaluate a lock inherited from
 * a different app. If it reads as live, the first launch after the migration
 * quits with no window and no message.
 */
const NEVER_MIGRATE = /^(Singleton|\.org\.chromium\.Chromium\.)/;

/**
 * Backups and logs are both found by filename prefix, so one named for the old
 * app is invisible to the UI that lists them *and* to the retention that
 * prunes them — it lingers forever while appearing not to exist. For backups
 * that means the one thing a user reaches for after a bad migration is exactly
 * what gets hidden.
 */
const LEGACY_BACKUP = /^enclave-(\d{8}T\d{9}Z-(?:startup|periodic|manual|pre-restore)(?:-\d+)?\.db)$/;
const LEGACY_LOG = /^enclave-(.+\.log)$/;

/** Rename, falling back to a copy when src and dst are on different filesystems. */
function move(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Merge `src` into an existing `dst`, recursing into directories.
 *
 * The destination is rarely empty in practice. Electron starts writing into
 * userData before this runs — the crash reporter creates `Crashpad/`, the
 * logger creates `logs/` — and an all-or-nothing skip on those top-level
 * entries stranded the entire history they contain at the old path.
 *
 * Recursing means a directory the destination happens to have already is still
 * populated from the old profile, while individual files that exist at the
 * destination are left alone: those were written by this build, and the point
 * is to fill gaps, never to overwrite live state.
 */
function mergeInto(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src)) {
    if (NEVER_MIGRATE.test(entry)) continue;

    const from = path.join(src, entry);
    const to = path.join(dst, entry);

    // lstat, not existsSync: the latter follows symlinks, so a dangling one at
    // the destination reads as absent and would be silently clobbered.
    if (!fs.lstatSync(to, { throwIfNoEntry: false })) {
      move(from, to);
      continue;
    }

    // lstat, not stat: a symlink to a directory is not a directory to recurse
    // into. The profile has several (SingletonLock and friends), and following
    // one would merge into wherever it happens to point.
    if (fs.lstatSync(from).isDirectory() && fs.lstatSync(to).isDirectory()) {
      mergeInto(from, to);
      // Recursing moves the contents out but leaves the source directory
      // standing, and an emptied directory still counts as the old profile
      // being present. Only ever removed once actually empty, so a child that
      // could not transfer keeps its parent — and stays visible.
      removeIfEmptied(from);
    }
  }
}

/**
 * @returns a human-readable summary when a migration happened, else null.
 *          Deliberately returns rather than logs: the logger itself lives in
 *          userData, so the caller reports this once logging is safe.
 */
export function migrateLegacyProfile(): string | null {
  const userData = app.getPath('userData');
  const legacyProfile = path.join(path.dirname(userData), LEGACY_APP_DIR);

  // Anything still carrying an old name means there is work left, wherever it
  // sits. Keying "already done" on the new database existing was wrong: the
  // work is a sequence of renames and that file is created partway through it,
  // so an interruption immediately after it — but before its -wal followed —
  // read as complete on the next launch. The app then booted, created a fresh
  // database over the top, and the real one was never looked at again.
  const dataDir = path.join(userData, DATA_DIR);
  const marker = path.join(userData, MARKER);

  // Completion is recorded explicitly rather than inferred from the state of
  // the files. Inferring it was wrong in both directions: the work continues
  // past the database rename (attachments, backups, logs, plugin ids), so an
  // interruption after that point left those stranded forever, and any thrown
  // error was equally permanent — the caller boots anyway, a fresh database
  // appears, and every later launch concluded there was nothing to do.
  //
  // Every step below is idempotent, so re-running until the marker lands
  // costs nothing and is the only thing that makes a failure recoverable.
  if (fs.existsSync(marker) && !hasMigratableEntries(legacyProfile)) return null;

  // Two databases means two profiles, and nothing here can know which one the
  // user wants. Renaming the legacy sidecars would be actively destructive:
  // the main file is skipped because the destination exists, but its WAL is
  // not, and SQLite binds a WAL by filename — so `enclave.db-wal` arriving as
  // `eaves.db-wal` replays the legacy database's pages into the live one, and
  // reports integrity_check: ok afterwards. Refuse, and say so.
  const legacyDbLocations = [
    path.join(legacyProfile, LEGACY_DATA_DIR, LEGACY_DB),
    path.join(userData, LEGACY_DATA_DIR, LEGACY_DB),
    path.join(dataDir, LEGACY_DB),
  ].filter(candidate => fs.existsSync(candidate));

  if (fs.existsSync(path.join(dataDir, DB)) && legacyDbLocations.length > 0) {
    rekeyPluginIds(userData);
    throw new Error(
      `Found databases under both names: ${path.join(dataDir, DB)} and ${legacyDbLocations[0]}. ` +
      'Refusing to migrate, because merging them automatically would mean choosing which of ' +
      'your two profiles to discard. Move the one you do not want aside and restart.'
    );
  }

  // Sidecars beside a live database with no legacy database anywhere belong to
  // that live database — a rename interrupted after the main file moved.
  if (fs.existsSync(path.join(dataDir, DB))) {
    renameDatabaseFiles(dataDir);
    finishRenames(userData, dataDir, legacyProfile);
    return null;
  }

  const pending =
    fs.existsSync(path.join(legacyProfile, LEGACY_DATA_DIR)) ||
    fs.existsSync(path.join(userData, LEGACY_DATA_DIR)) ||
    // A lone sidecar counts. Interrupting after the main file was renamed but
    // before its -wal followed leaves exactly this, and treating it as done
    // is what discards the WAL.
    hasLegacyDatabaseFile(dataDir);

  if (!pending) {
    // Nothing to move, but the id and path rewrites are cheap and idempotent,
    // and gating them on the move meant a profile migrated by an earlier build
    // never received them — leaving manifests on the old ids while the
    // database had already been remapped.
    finishRenames(userData, dataDir, legacyProfile);
    return null;
  }

  // Always a merge, never a wholesale directory rename. The destination
  // usually exists already (Electron writes into userData before this runs),
  // and merging is the only form that both handles that and applies the
  // skip list uniformly. Everything not skipped comes across, so the Chromium
  // state — localStorage, cookies, window bounds — stays with the data it
  // belongs to.
  if (fs.existsSync(legacyProfile)) {
    mergeInto(legacyProfile, userData);
    removeIfEmptied(legacyProfile);
  }

  // Merge rather than rename: the destination can already exist from an
  // interrupted run, and renaming a directory onto a non-empty one is ENOTEMPTY
  // — which threw partway through and left the profile split across both names.
  const legacyDataDir = path.join(userData, LEGACY_DATA_DIR);
  if (fs.existsSync(legacyDataDir)) {
    mergeInto(legacyDataDir, dataDir);
    removeIfEmptied(legacyDataDir);
  }

  renameDatabaseFiles(dataDir);

  const attachments = path.join(dataDir, LEGACY_ATTACHMENTS);
  if (fs.existsSync(attachments)) mergeInto(attachments, path.join(dataDir, ATTACHMENTS));

  finishRenames(userData, dataDir, legacyProfile);

  return `Migrated profile from ${legacyProfile} to ${userData}`;
}

/**
 * Everything that follows the database rename, plus the completion marker.
 *
 * Shared by every exit path, because each of them leaves work that has to be
 * finished — and the marker has to be written by all of them or the migration
 * runs again on the next launch forever.
 */
function finishRenames(userData: string, dataDir: string, legacyProfile: string): void {
  // Depth-first, because a profile migrated by 0.5.0 was left holding the
  // skeleton of its own directory tree — that build moved the files out but
  // never removed the directories it walked, and those profiles exist in the
  // wild. Without this the fix would only ever reach fresh migrations.
  pruneEmptyDirs(legacyProfile);
  // Same reasoning one level down: a profile 0.5.0 migrated has already moved
  // these files, so the merge that used to clear this never runs again.
  removeIfEmptied(path.join(dataDir, LEGACY_ATTACHMENTS));
  renamePrefixed(path.join(dataDir, 'backups'), LEGACY_BACKUP);
  renamePrefixed(path.join(userData, 'logs'), LEGACY_LOG);
  rekeyPluginIds(userData);

  // Only into a profile that already exists. A fresh install has nothing to
  // migrate and no directory yet, and creating one here just to record that
  // fact would have this function inventing the profile it exists to move.
  if (!fs.existsSync(userData)) return;

  try {
    fs.writeFileSync(path.join(userData, MARKER), new Date().toISOString(), 'utf-8');
  } catch {
    // Unwritable marker just means doing this idempotent work again next time.
  }
}

/**
 * Remove a directory only once it is actually empty.
 *
 * A recursive delete here would discard whatever `mergeInto` could not
 * transfer — a source entry whose destination exists with a conflicting type
 * is skipped silently, and deleting it afterwards turns "stranded" into
 * "gone". An empty directory means everything really did move.
 */
function removeIfEmptied(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Non-empty, so something did not transfer. Leaving the directory is both
    // the safe outcome and the visible one — deliberately not logged, because
    // this runs before the logger has anywhere to write.
  }
}

/**
 * Remove the directory skeleton a migration leaves behind, bottom-up.
 *
 * Only ever removes directories that are already empty, so it cannot discard
 * anything a merge could not move: a child that stayed keeps its parent, and
 * stays visible.
 */
function pruneEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const child = path.join(dir, entry);
    // lstat, not stat: a symlink to a directory is not a directory to descend
    // into, and the profile keeps several pointing outside itself.
    if (fs.lstatSync(child, { throwIfNoEntry: false })?.isDirectory()) pruneEmptyDirs(child);
  }

  removeIfEmptied(dir);
}

/**
 * Whether a legacy profile still holds anything this migration would move.
 *
 * The directory itself outlives the migration by design: every entry on the
 * skip list is deliberately left where it is, because those encode a pid and a
 * socket belonging to whichever process wrote them. So keying "already done"
 * on the directory being *gone* never came true, and a fully migrated profile
 * re-ran the whole idempotent tail — two directory scans plus a rewrite of
 * every installed plugin manifest — on every single launch, forever.
 *
 * Unreadable counts as work remaining: declaring a profile done is the one
 * answer that cannot be revisited later.
 */
function hasMigratableEntries(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some(entry => !NEVER_MIGRATE.test(entry));
  } catch {
    return true;
  }
}

/** Whether a directory still holds the database or any sidecar under its old name. */
function hasLegacyDatabaseFile(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(name => name.startsWith(LEGACY_DB));
}

/**
 * Rename the database and every sidecar SQLite derives from its filename.
 *
 * Matched by prefix rather than a fixed list. `-wal` and `-shm` are the ones
 * WAL mode uses, but WAL silently falls back to a rollback journal on
 * filesystems without shared-memory support (network and FUSE homes), and
 * moving the database without a hot `-journal` means SQLite opens a file that
 * should have been rolled back and treats it as clean.
 *
 * The main `.db` is renamed last, so an interruption always leaves a legacy
 * name behind for the resume check above to find.
 */
function renameDatabaseFiles(dataDir: string): void {
  if (!fs.existsSync(dataDir)) return;

  const sidecars = fs.readdirSync(dataDir)
    .filter(name => name.startsWith(LEGACY_DB) && name !== LEGACY_DB)
    .sort();

  for (const name of [...sidecars, LEGACY_DB]) {
    const from = path.join(dataDir, name);
    const to = path.join(dataDir, `${DB}${name.slice(LEGACY_DB.length)}`);
    // renameSync replaces the destination without complaint, so guard rather
    // than trust the caller: overwriting here would mean losing a live
    // database to a stale one.
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    move(from, to);
  }
}

/** Bring files named for the old app under the prefix their listing matches. */
function renamePrefixed(dir: string, pattern: RegExp): void {
  if (!fs.existsSync(dir)) return;

  for (const name of fs.readdirSync(dir)) {
    const match = pattern.exec(name);
    if (!match) continue;

    const to = path.join(dir, `eaves-${match[1]}`);
    if (!fs.existsSync(to)) move(path.join(dir, name), to);
  }
}

/** The id rewrites that no database migration can reach. Idempotent. */
function rekeyPluginIds(userData: string): void {
  migratePluginConfigIds(userData);
  migrateInstalledPluginIds(userData);
}

/**
 * Rewrite the id an installed plugin declares in its own manifest.
 *
 * Migration 77 remaps plugin ids in the database, but a marketplace-installed
 * plugin also carries its id in `plugin.json`, and discovery reads it from
 * there. Renaming only one side leaves the plugin loading under its old id
 * while its grants, storage and — most visibly — its enabled flag sit under
 * the new one, so a plugin the user had disabled comes back enabled with none
 * of its settings.
 *
 * Worse, discovery dedupes by id, so an installed `com.enclave.x` and a
 * bundled `com.eaves.x` are two different plugins and both load. That is the
 * same failure `removeLegacyCollapsedInstall` exists to prevent.
 *
 * The install directory is derived from the id, so it moves too.
 */
function migrateInstalledPluginIds(userData: string): void {
  const pluginsDir = path.join(userData, 'plugins');
  if (!fs.existsSync(pluginsDir)) return;

  for (const entry of fs.readdirSync(pluginsDir)) {
    const dir = path.join(pluginsDir, entry);
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: { id?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue; // unreadable manifest: not provably ours, so leave it alone
    }

    const id = manifest.id;
    if (typeof id !== 'string' || !id.startsWith(LEGACY_ID_PREFIX)) continue;

    const newId = `${ID_PREFIX}${id.slice(LEGACY_ID_PREFIX.length)}`;
    manifest.id = newId;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const newDir = path.join(pluginsDir, sanitizeFolderName(newId));
    if (newDir !== dir && !fs.existsSync(newDir)) move(dir, newDir);
  }
}

/**
 * Plugin configuration is keyed by plugin id but lives in a JSON file rather
 * than the database, so migration 77's id remap does not reach it. Left alone,
 * a plugin comes back with its stored settings — including any API keys the
 * user entered — orphaned under its old id.
 *
 * Rewrites keys only. Values are the plugin's own data and are never inspected.
 */
function migratePluginConfigIds(userData: string): void {
  const configPath = path.join(userData, 'plugin-configs.json');
  if (!fs.existsSync(configPath)) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Unreadable config is not ours to repair, and throwing here would fail
    // the migration on every launch over an otherwise healthy profile.
    return;
  }
  const remapped: Record<string, unknown> = {};
  let changed = false;

  for (const [id, value] of Object.entries(parsed)) {
    if (id.startsWith(LEGACY_ID_PREFIX)) {
      remapped[`${ID_PREFIX}${id.slice(LEGACY_ID_PREFIX.length)}`] = value;
      changed = true;
    } else {
      remapped[id] = value;
    }
  }

  if (changed) fs.writeFileSync(configPath, JSON.stringify(remapped, null, 2), 'utf-8');
}
