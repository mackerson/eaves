#!/usr/bin/env node
/**
 * Copy plugins into dist/plugins for packaging — but ONLY those marked
 * `tier: "bundled"` in bundled-plugins.json.
 *
 * Previously this was `cp -rL plugins/* dist/plugins/`, which shipped
 * everything symlinked into plugins/ (including qa/example/community-tier
 * plugins like openmemory, and stray local dirs). The shipped set is now
 * driven deterministically by the manifest, not by whatever happens to be
 * on disk.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'bundled-plugins.json');
const srcDir = path.join(root, 'plugins');
const destDir = path.join(root, 'dist', 'plugins');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const all = manifest.plugins || [];
const bundled = all.filter((p) => p.tier === 'bundled');
const skipped = all.filter((p) => p.tier !== 'bundled');

// Reset destination
fs.rmSync(destDir, { recursive: true, force: true });
fs.mkdirSync(destDir, { recursive: true });

/**
 * Everything under a plugin directory used to be copied verbatim, which put each
 * plugin's full `.git` object store, its devDependency `node_modules`, and any
 * local dotfiles inside the shipped asar — ~76 MB per plugin against a runtime
 * payload of a few hundred KB, and a redistribution of every repo's commit
 * history to every user.
 *
 * Bundled plugins declare no runtime dependencies (they require only Node
 * builtins and `electron`), so `node_modules` is build-time only. Build tooling
 * is dropped too: it cannot run from inside the asar, and its presence is what
 * makes PluginWatcher attempt a rebuild that can never succeed in a packaged app.
 */
const EXCLUDED_DIRS = new Set(['.git', '.github', 'node_modules', 'scripts']);
const EXCLUDED_FILES = new Set([
  '.gitignore',
  'yarn.lock',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'vite.config.js',
]);

function shipFilter(pluginDir) {
  return (src) => {
    const rel = path.relative(pluginDir, src);
    if (!rel) return true;
    const segments = rel.split(path.sep);
    if (segments.some((s) => EXCLUDED_DIRS.has(s))) return false;
    // Source lives beside the built bundle; only ui/dist is loaded at runtime.
    if (segments[0] === 'ui' && segments[1] && segments[1] !== 'dist') return false;
    const base = segments[segments.length - 1];
    if (EXCLUDED_FILES.has(base)) return false;
    // Never ship an environment file that happens to be in a dev clone.
    if (base === '.env' || base.startsWith('.env.')) return false;
    return true;
  };
}

const missing = [];
for (const plugin of bundled) {
  const from = path.join(srcDir, plugin.name);
  const to = path.join(destDir, plugin.name);
  if (!fs.existsSync(from)) {
    missing.push(plugin.name);
    continue;
  }
  // dereference: true follows the dev symlinks (matches old `cp -rL`).
  // `from` is resolved first so the filter's relative paths are stable across
  // the symlink boundary.
  const resolved = fs.realpathSync(from);
  fs.cpSync(resolved, to, { recursive: true, dereference: true, filter: shipFilter(resolved) });
  console.log(`  ✓ shipped  ${plugin.name}`);
}

for (const plugin of skipped) {
  console.log(`  – skipped  ${plugin.name} (tier: ${plugin.tier})`);
}

if (missing.length > 0) {
  console.error(
    `\n✗ Missing bundled plugin(s) in plugins/: ${missing.join(', ')}\n` +
      `  Run \`yarn setup:plugins\` to clone them before building.`
  );
  process.exit(1);
}

console.log(
  `\nBundled ${bundled.length} plugin(s) into dist/plugins; skipped ${skipped.length} non-bundled.`
);
