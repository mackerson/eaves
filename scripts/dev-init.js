#!/usr/bin/env node
/**
 * Smart Dev Initialization
 * Only builds what's needed before starting the dev server
 *
 * Checks:
 * - Plugins (via build-plugins.js incremental)
 * - MCP servers (skips if unchanged)
 * - Main process (always runs with incremental tsc)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function getNewestMtime(dir, extensions = ['.ts', '.js', '.json']) {
  let newest = 0;

  if (!fs.existsSync(dir)) return 0;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

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

function needsMcpBuild() {
  const srcDir = path.join(rootDir, 'src/main/mcp-servers');
  const outDir = path.join(rootDir, 'dist/main/mcp-servers');

  // Check if any output exists
  if (!fs.existsSync(outDir)) {
    return { needed: true, reason: 'no output directory' };
  }

  // Check for any .js files in output
  const hasOutput = fs.readdirSync(outDir).some(f => f.endsWith('.js'));
  if (!hasOutput) {
    return { needed: true, reason: 'no compiled files' };
  }

  // Compare source vs output mtimes
  const srcMtime = getNewestMtime(srcDir);
  const outMtime = getNewestMtime(outDir, ['.js']);

  if (srcMtime > outMtime) {
    return { needed: true, reason: 'source files changed' };
  }

  return { needed: false };
}

function main() {
  console.log('🚀 Eaves Dev Initialization\n');
  const startTime = Date.now();

  // 1. Build plugins (incremental - handled by build-plugins.js)
  console.log('📦 Checking plugins...');
  run('node', ['scripts/build-plugins.js']);

  // 2. Build MCP servers (only if needed)
  console.log('\n🔌 Checking MCP servers...');
  const mcpCheck = needsMcpBuild();
  if (mcpCheck.needed) {
    console.log(`   Building MCP servers (${mcpCheck.reason})...`);
    run('npm', ['run', 'build:mcp']);
  } else {
    console.log('   ⏭️  MCP servers up to date');
  }

  // 3. Copy assets
  console.log('\n📁 Copying assets...');
  run('npm', ['run', 'copy-assets']);

  // 4. Copy plugins
  console.log('\n📁 Copying plugins...');
  run('npm', ['run', 'copy-plugins']);

  // 5. Build main process (incremental tsc handles caching)
  console.log('\n⚙️  Building main process (incremental)...');
  run('npm', ['run', 'build:main']);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Dev initialization complete in ${elapsed}s`);
}

main();
