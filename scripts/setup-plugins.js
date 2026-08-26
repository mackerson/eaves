#!/usr/bin/env node
/**
 * Setup plugin development environment.
 *
 * Clones plugin repos into ../plugins/ (sibling to this repo) and links them
 * into ./plugins/ so the dev server picks them up.
 *
 * Usage:
 *   node scripts/setup-plugins.js          # Clone & link all plugins
 *   node scripts/setup-plugins.js --pull   # Pull latest for existing clones
 *   node scripts/setup-plugins.js --clean  # Remove links (not clones)
 *
 * This was scripts/setup-plugins.sh. It moved to Node because the shell version
 * could not run on Windows, in two ways that both failed quietly:
 *
 *   - it shelled out to `jq` to read bundled-plugins.json, and jq ships with
 *     neither Windows nor Git Bash, so the script aborted before doing anything;
 *   - `ln -s` under MSYS *copies* a directory rather than linking it unless the
 *     developer has enabled Developer Mode. plugins/ then looked correctly
 *     populated while every entry was a frozen snapshot, so edits in a sibling
 *     checkout never reached the running app.
 *
 * Node reads the manifest directly, and on Windows creates a junction — which
 * needs no elevation and which fs.lstat reports as a symlink, the same shape
 * SandboxedPluginManager's dev-tier discovery already looks for.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_SRC = path.join(ROOT, '..', 'plugins');
const PLUGINS_LINK = path.join(ROOT, 'plugins');
const MANIFEST = path.join(ROOT, 'bundled-plugins.json');

const args = process.argv.slice(2);
const doPull = args.includes('--pull');
const doClean = args.includes('--clean');

// How to reach GitHub. This used to be hardcoded to `git@github-personal:` — an
// SSH host alias that exists in exactly one developer's ~/.ssh/config, so
// everyone else got "Could not resolve hostname github-personal", plugins/ stayed
// empty, and `yarn build` then failed in copy-plugins.js with "Missing bundled
// plugin(s)". CLAUDE.md documents this script as required after cloning.
//
// Default to HTTPS, which works unauthenticated for public repos and in CI.
// Override with EAVES_GIT_PROTO=ssh, or point EAVES_GIT_HOST at your own
// SSH alias.
const CLONE_PROTO = process.env.EAVES_GIT_PROTO || 'https';
const GIT_HOST = process.env.EAVES_GIT_HOST || 'github.com';

function cloneUrl(repo) {
  return CLONE_PROTO === 'ssh'
    ? `git@${GIT_HOST}:${repo}.git`
    : `https://${GIT_HOST}/${repo}.git`;
}

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { stdio: 'inherit' });
  if (result.error) throw new Error(`Failed to run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} exited with ${result.status}`);
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolves(p) {
  // stat (not lstat) follows the link — false means the target is gone.
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

// Windows will not let unlink() remove a directory junction or directory
// symlink; that is rmdir's job, and rmdir removes the link itself rather than
// anything it points at. POSIX is the other way round.
function removeLink(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (process.platform !== 'win32') throw err;
    fs.rmdirSync(p);
  }
}

function link(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

if (!fs.existsSync(MANIFEST)) {
  console.error(`Error: bundled-plugins.json not found at ${MANIFEST}`);
  process.exit(1);
}

const plugins = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).plugins;

if (doClean) {
  console.log(`Removing plugin links from ${PLUGINS_LINK}/`);
  for (const { name } of plugins) {
    const linkPath = path.join(PLUGINS_LINK, name);
    if (isLink(linkPath)) {
      removeLink(linkPath);
      console.log(`  Removed ${name}`);
    }
  }
  console.log(`Done. Plugin clones in ${PLUGINS_SRC}/ are untouched.`);
  process.exit(0);
}

fs.mkdirSync(PLUGINS_SRC, { recursive: true });
fs.mkdirSync(PLUGINS_LINK, { recursive: true });

console.log(`Plugin source: ${PLUGINS_SRC}`);
console.log(`Plugin links:  ${PLUGINS_LINK}`);
console.log('');

for (const { name, repo, ref } of plugins) {
  const clonePath = path.join(PLUGINS_SRC, name);

  if (fs.existsSync(path.join(clonePath, '.git'))) {
    if (doPull) {
      console.log(`Pulling ${name}...`);
      git(['-C', clonePath, 'pull', '--ff-only']);
    } else {
      console.log(`Exists: ${name} (use --pull to update)`);
    }
  } else {
    console.log(`Cloning ${name} from ${repo} (${CLONE_PROTO})...`);
    git(['clone', cloneUrl(repo), clonePath]);
    if (ref !== 'main') {
      git(['-C', clonePath, 'checkout', ref]);
    }
  }

  // Create the link if not already present. Testing "is a link" alone is true
  // for a *dangling* link too, so a link whose target moved (a repo rename, a
  // relocated checkout) was reported as "exists" and never healed — plugins/
  // looked populated while every entry pointed at nothing.
  const linkPath = path.join(PLUGINS_LINK, name);
  if (isLink(linkPath) && resolves(linkPath)) {
    console.log(`  Linked: ${name} (exists)`);
  } else if (isLink(linkPath)) {
    removeLink(linkPath);
    link(clonePath, linkPath);
    console.log(`  Relinked: ${name} -> ${clonePath} (was dangling)`);
  } else if (fs.existsSync(linkPath)) {
    console.log(`  Warning: ${linkPath} is a real directory, not a link. Skipping.`);
  } else {
    link(clonePath, linkPath);
    console.log(`  Linked: ${name} -> ${clonePath}`);
  }

  console.log('');
}

console.log("Done! Run 'yarn dev' to start with plugins.");
