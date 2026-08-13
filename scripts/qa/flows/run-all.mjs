#!/usr/bin/env node
/**
 * Run every characterization flow against a fresh isolated harness profile.
 * Green here is the gate for changes to the chat/channel send paths.
 *
 * Prereqs (the harness fatals if stale/missing, it never rebuilds):
 *   yarn build:main
 *   yarn build:renderer   # unless a Vite dev server is on :5173
 *   yarn rebuild-sqlite3  # if `yarn test` ran since the last dev/build
 *
 * Exit code: 0 only if every flow passed (skips allowed), 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const flowsDir = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(flowsDir, '..', 'harness.mjs');

const FLOWS = [
  'flow1-chat-send.mjs',
  'flow2-channel-selected-agent.mjs',
  'flow3-mention-dispatch.mjs',
  'flow4-respond-all-dispatch.mjs',
  'flow5-approval-suspend-resume.mjs',
  // Channel-surface feature parity (tags/archive + channel attachments).
  'flow6-channel-features.mjs',
];

const node = process.execPath;
const run = (args) => spawnSync(node, args, { stdio: 'inherit' });

// Clean slate: stop any leftover instance, then launch on a fresh profile.
run([harness, 'stop']);
const launch = run([harness, 'launch', '--fresh']);
if (launch.status !== 0) {
  console.error('FATAL: harness launch failed');
  process.exit(1);
}

const results = [];
for (const flow of FLOWS) {
  console.log(`\n━━━ ${flow} ━━━`);
  const res = run([path.join(flowsDir, flow)]);
  results.push({ flow, status: res.status });
}

run([harness, 'stop']);

console.log('\n━━━ summary ━━━');
for (const { flow, status } of results) {
  console.log(`${status === 0 ? 'PASS' : 'FAIL'} ${flow}`);
}
process.exit(results.some(r => r.status !== 0) ? 1 : 0);
