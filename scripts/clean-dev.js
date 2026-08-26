#!/usr/bin/env node
/**
 * List or kill orphaned Electron and Vite dev processes for this checkout.
 *
 * Usage:
 *   node scripts/clean-dev.js            # Kill orphaned dev processes
 *   node scripts/clean-dev.js --status   # List them without killing
 *
 * This was scripts/clean-dev.sh, and it moved to Node because the shell
 * version had no way to work on Windows: it drove `pgrep` (which MSYS does not
 * ship) and `ps -o ppid= -p` (which MSYS `ps` rejects outright). The
 * `dev:status` one-liner was worse than broken — MSYS `ps` only ever reports
 * MSYS processes, so it could not see electron.exe at all and cheerfully
 * printed "No dev processes running" over a running app.
 */

const path = require('path');
const { devProcessesForRepo } = require('./lib/dev-processes');

const ROOT = path.resolve(__dirname, '..');
const statusOnly = process.argv.slice(2).includes('--status');

const matches = devProcessesForRepo(ROOT);

if (statusOnly) {
  if (matches.length === 0) {
    console.log('No dev processes running.');
  } else {
    for (const p of matches) console.log(`PID ${p.pid}: ${p.cmd}`);
  }
  process.exit(0);
}

let killed = 0;
for (const p of matches) {
  try {
    process.kill(p.pid);
    console.log(`Killed PID ${p.pid}: ${p.cmd}`);
    killed++;
  } catch {
    // Already gone, or not ours to kill — either way there is nothing to clean.
  }
}

if (killed === 0) {
  console.log('No orphaned dev processes found.');
}
