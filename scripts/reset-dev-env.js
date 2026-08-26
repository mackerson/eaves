#!/usr/bin/env node
/**
 * Reset the Eaves development environment to defaults.
 *
 * Deletes the local database, user plugins and logs for the *current
 * platform's* profile. Destructive; prompts unless given --force.
 *
 * Usage:
 *   node scripts/reset-dev-env.js
 *   node scripts/reset-dev-env.js --force
 *
 * Ported from reset-dev-env.sh. The shell version reached for `pkill` and
 * `pgrep` to stop the app before deleting its data — neither of which exists
 * in Git Bash. Both calls failed silently, the "is it still running?" guard
 * could only ever answer no, and the script went straight on to delete the
 * SQLite file out from under a live app. That guard is the whole reason the
 * kill step is there, so this had to stop being a shell script.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { devProcessesForRepo } = require('./lib/dev-processes');

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

const ROOT = path.resolve(__dirname, '..');
const force = process.argv.slice(2).includes('--force');

/**
 * Electron's own userData rules, per platform. Linux honours XDG_CONFIG_HOME
 * because Electron does — hardcoding ~/.config/eaves meant this script could
 * not clean an isolated profile (the QA harness runs the app under its own
 * XDG_CONFIG_HOME) and would instead reach for the developer's real data.
 */
function userDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'eaves');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'eaves');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'eaves');
}

const USER_DATA_DIR = userDataDir();
const targets = [
  ['Database', path.join(USER_DATA_DIR, 'eaves-data')],
  ['User plugins', path.join(USER_DATA_DIR, 'plugins')],
  ['Logs', path.join(USER_DATA_DIR, 'logs')],
];

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log(`${YELLOW}Eaves Development Environment Reset${NC}`);
  console.log('');
  console.log('This will delete:');
  for (const [label, dir] of targets) console.log(`  - ${label}: ${dir}`);
  console.log('');
  console.log(`${RED}WARNING: This action cannot be undone!${NC}`);
  console.log('');

  if (!force && !(await confirm('Are you sure you want to continue? (yes/no): '))) {
    console.log('Reset cancelled.');
    return;
  }
  console.log('');

  console.log(`${YELLOW}→ Stopping Eaves processes...${NC}`);
  for (const proc of devProcessesForRepo(ROOT)) {
    try {
      process.kill(proc.pid);
      console.log(`  Stopped PID ${proc.pid}`);
    } catch {
      /* already gone */
    }
  }
  await sleep(1000);

  // Refuse to delete data belonging to an app we could not stop: the whole
  // point of the kill above is that nothing holds the SQLite file open.
  if (devProcessesForRepo(ROOT).length > 0) {
    console.error(`${RED}Eaves is still running — refusing to delete its data.${NC}`);
    console.error('  Quit the app and re-run, or kill it manually.');
    process.exit(1);
  }

  for (const [label, dir] of targets) {
    if (fs.existsSync(dir)) {
      console.log(`${YELLOW}→ Deleting ${label.toLowerCase()}...${NC}`);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`${GREEN}✓ ${label} deleted${NC}`);
    } else {
      console.log(`  ${label} directory not found (already clean)`);
    }
  }

  console.log('');
  console.log(`${GREEN}✓ Development environment reset complete!${NC}`);
  console.log('');
  console.log('Next steps:');
  console.log("  1. Run 'yarn dev' to start with fresh defaults");
  console.log('  2. Default agent, project, and channel will be created');
  console.log('  3. Check .env for user name and API keys');
  console.log('');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
