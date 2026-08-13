#!/usr/bin/env node
/**
 * Run every live-*.mjs suite in sequence and summarize. Each suite launches its
 * own fresh instance and skips cleanly (exit 0) when no ENCLAVE_QA_*_KEY is set,
 * so this is safe to run anywhere — it just skips when unkeyed.
 *
 *   node scripts/qa/live-run.mjs
 *
 * Slow when keyed (each suite makes real model calls; dreaming alone is ~2-3 min).
 * Requires a current build (yarn build:main && yarn build:renderer) + sqlite for
 * the Electron ABI (yarn rebuild-sqlite3).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const suites = fs.readdirSync(dir)
  .filter(f => /^live-.*\.mjs$/.test(f) && f !== 'live-run.mjs')
  .sort();

let failed = 0;
for (const s of suites) {
  console.log(`\n========== ${s} ==========`);
  try {
    execFileSync('node', [path.join(dir, s)], { stdio: 'inherit' });
  } catch {
    failed++;
    console.log(`  ✗ ${s} exited non-zero`);
  }
}
console.log(`\n${suites.length} live suite(s) run — ${failed ? `${failed} failed` : 'all passed / skipped'}.`);
process.exit(failed ? 1 : 0);
