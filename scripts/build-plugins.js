#!/usr/bin/env node
/**
 * Build Plugin UIs (Incremental)
 * Automatically builds plugin UI bundles, skipping unchanged plugins
 *
 * Usage:
 *   node scripts/build-plugins.js             # Build changed plugins only
 *   node scripts/build-plugins.js --force     # Force rebuild all
 *   node scripts/build-plugins.js my-plugin   # Build specific plugin in plugins/
 *   node scripts/build-plugins.js /abs/path   # Build a plugin outside plugins/
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pluginsDir = path.join(__dirname, '../plugins');
const args = process.argv.slice(2);
const specificPlugin = args.find(arg => !arg.startsWith('--'));
const forceRebuild = args.includes('--force');

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Command exited with code ${result.status}`);
  }

  return result;
}

/**
 * Get the most recent mtime from a directory recursively
 */
function getNewestMtime(dir, extensions = ['.js', '.jsx', '.ts', '.tsx', '.css', '.json']) {
  let newest = 0;

  if (!fs.existsSync(dir)) return 0;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip node_modules and dist directories
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const subMtime = getNewestMtime(fullPath, extensions);
      if (subMtime > newest) newest = subMtime;
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  }

  return newest;
}

/**
 * Check if plugin needs rebuilding
 */
function needsRebuild(pluginPath) {
  const outputFile = path.join(pluginPath, 'ui', 'dist', 'index.js');

  // No output = needs build
  if (!fs.existsSync(outputFile)) {
    return { needed: true, reason: 'no output file' };
  }

  const outputMtime = fs.statSync(outputFile).mtimeMs;

  // Check plugin root files (package.json, vite.config.ts, etc.)
  const rootFiles = ['package.json', 'vite.config.ts', 'tsconfig.json'];
  for (const file of rootFiles) {
    const filePath = path.join(pluginPath, file);
    if (fs.existsSync(filePath)) {
      const fileMtime = fs.statSync(filePath).mtimeMs;
      if (fileMtime > outputMtime) {
        return { needed: true, reason: `${file} changed` };
      }
    }
  }

  // Check ui/src directory
  const srcDir = path.join(pluginPath, 'ui', 'src');
  if (fs.existsSync(srcDir)) {
    const srcMtime = getNewestMtime(srcDir);
    if (srcMtime > outputMtime) {
      return { needed: true, reason: 'source files changed' };
    }
  }

  return { needed: false };
}

function buildPlugin(pluginName, buildDir, reason) {
  console.log(`\n🔨 Building ${pluginName}... (${reason})`);

  try {
    // Install dependencies if needed
    const hasNodeModules = fs.existsSync(path.join(buildDir, 'node_modules'));
    if (!hasNodeModules) {
      console.log(`   Installing dependencies for ${pluginName}...`);
      runCommand('yarn', ['install', '--silent'], buildDir);
    }

    // Build the plugin
    runCommand('yarn', ['build'], buildDir);

    console.log(`✅ ${pluginName} built successfully`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to build ${pluginName}:`, error.message);
    return false;
  }
}

/**
 * Build a plugin addressed by directory rather than by name. Plugins installed
 * from the marketplace, or authored live, live under userData — outside the
 * repo's `plugins/` tree — so a bare name cannot reach them.
 */
function buildByPath(pluginPath) {
  const name = path.basename(pluginPath);

  if (!fs.existsSync(pluginPath) || !fs.statSync(pluginPath).isDirectory()) {
    console.log(`\n⚠️  Plugin directory not found: ${pluginPath}`);
    process.exit(1);
  }

  const hasUI = fs.existsSync(path.join(pluginPath, 'package.json')) &&
    fs.existsSync(path.join(pluginPath, 'vite.config.ts'));

  if (!hasUI) {
    console.log(`\n✅ ${name} has no UI bundle to build`);
    process.exit(0);
  }

  const { needed, reason } = forceRebuild
    ? { needed: true, reason: 'forced' }
    : needsRebuild(pluginPath);

  if (!needed) {
    console.log(`\n✅ Plugin "${name}" is up to date`);
    process.exit(0);
  }

  process.exit(buildPlugin(name, pluginPath, reason || 'unknown') ? 0 : 1);
}

function main() {
  console.log('🔧 Enclave Plugin Builder (Incremental)\n');

  if (forceRebuild) {
    console.log('⚡ Force rebuild mode - rebuilding all plugins\n');
  }

  if (specificPlugin && (path.isAbsolute(specificPlugin) || specificPlugin.includes(path.sep))) {
    buildByPath(path.resolve(specificPlugin));
    return;
  }

  // Get list of plugins with UI
  const plugins = fs.readdirSync(pluginsDir).filter(name => {
    const pluginPath = path.join(pluginsDir, name);
    const stats = fs.statSync(pluginPath);
    return stats.isDirectory() && !name.startsWith('.');
  });

  const pluginsToBuild = [];
  const pluginsSkipped = [];

  for (const plugin of plugins) {
    const pluginPath = path.join(pluginsDir, plugin);
    const packageJson = path.join(pluginPath, 'package.json');
    const viteConfig = path.join(pluginPath, 'vite.config.ts');

    // Plugin has UI if it has both package.json and vite.config.ts at root
    const hasUI = fs.existsSync(packageJson) && fs.existsSync(viteConfig);

    if (hasUI) {
      // Skip if specific plugin requested and this isn't it
      if (specificPlugin && plugin !== specificPlugin) {
        continue;
      }

      // Check if rebuild needed
      const { needed, reason } = forceRebuild
        ? { needed: true, reason: 'forced' }
        : needsRebuild(pluginPath);

      if (needed) {
        pluginsToBuild.push({
          name: plugin,
          buildDir: pluginPath,
          reason: reason || 'unknown'
        });
      } else {
        pluginsSkipped.push(plugin);
      }
    }
  }

  // Report what we're doing
  if (pluginsSkipped.length > 0) {
    console.log(`⏭️  Skipping ${pluginsSkipped.length} unchanged plugin(s):`);
    pluginsSkipped.forEach(p => console.log(`   • ${p}`));
  }

  if (pluginsToBuild.length === 0) {
    if (specificPlugin) {
      const exists = plugins.includes(specificPlugin);
      if (!exists) {
        console.log(`\n⚠️  Plugin "${specificPlugin}" not found`);
        process.exit(1);
      }
      console.log(`\n✅ Plugin "${specificPlugin}" is up to date`);
    } else {
      console.log('\n✅ All plugins are up to date');
    }
    process.exit(0);
  }

  console.log(`\n🔄 Building ${pluginsToBuild.length} plugin(s):`);
  pluginsToBuild.forEach(p => console.log(`   • ${p.name} (${p.reason})`));

  let successCount = 0;
  let failCount = 0;

  for (const { name, buildDir, reason } of pluginsToBuild) {
    if (buildPlugin(name, buildDir, reason)) {
      successCount++;
    } else {
      failCount++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`✅ ${successCount} built, ⏭️  ${pluginsSkipped.length} skipped, ❌ ${failCount} failed`);
  console.log('='.repeat(50) + '\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

main();
