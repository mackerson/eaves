#!/usr/bin/env node
/**
 * Copy assets/ into dist/assets/.
 *
 * Replaces `mkdir -p dist/assets && cp -r assets/* dist/assets/`, which cmd.exe
 * cannot run at all — so `yarn build` worked on Windows only for developers who
 * had pointed yarn's script-shell at Git Bash first.
 *
 * Symlinks are copied as symlinks, matching `cp -r` (not `cp -rL`).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = path.join(ROOT, 'assets');
const dest = path.join(ROOT, 'dist', 'assets');

if (!fs.existsSync(src)) {
  console.error(`copy-assets: nothing to copy, ${src} does not exist`);
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`copy-assets: assets -> dist/assets`);
