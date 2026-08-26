#!/usr/bin/env node
/**
 * Ad-hoc codesign native addons and Electron.app — macOS only.
 *
 * A thin platform gate in front of sign-native-macos.sh. It exists so that
 * `postinstall`, `predev` and `prepare:native` — the three scripts every
 * developer runs before anything else works — do not shell out to bash at all
 * off macOS. On Windows `bash` resolves to WSL unless yarn's script-shell has
 * been repointed, which made "install the dependencies" the very first thing
 * to fail on a fresh clone.
 */

const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

const script = path.join(__dirname, 'sign-native-macos.sh');
const result = spawnSync('bash', [script], { stdio: 'inherit' });

if (result.error) {
  console.error(`sign-native: failed to run ${script}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
