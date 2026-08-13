#!/usr/bin/env node
/**
 * Live suite: semantic (vector) memory search. Enables embeddings on the seeded
 * provider, stores memories with NO keyword overlap with the query, and asserts
 * a by-meaning query still finds the right one via the vector signal — the exact
 * thing FTS can't do (and the thing the agent complained about).
 *
 *   node scripts/qa/live-semantic.mjs
 *
 * Skips (exit 0) when no ENCLAVE_QA_*_KEY is set.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { connect } from './harness.mjs';

if (!process.env.ENCLAVE_QA_OPENROUTER_KEY) { console.log('SKIP: needs ENCLAVE_QA_OPENROUTER_KEY (embeddings via OpenRouter).'); process.exit(0); }

const harness = path.join(path.dirname(new URL(import.meta.url).pathname), 'harness.mjs');
const scratchDir = process.env.ENCLAVE_QA_DIR || path.join(os.tmpdir(), 'enclave-qa');
const dbPath = path.join(scratchDir, 'xdg', 'enclave', 'enclave-data', 'enclave.db');
const sh = (...a) => execFileSync('node', [harness, ...a], { stdio: 'inherit' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
void dbPath; // (vec0 tables aren't readable by the bare sqlite3 CLI — we assert via the app instead)

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`); if (!ok) failures++; };

console.log('live-semantic: openrouter / openai/text-embedding-3-small');
try { sh('stop'); } catch {}
sh('launch', '--fresh');
try {
  const cdp = await connect(9222);

  // Enable embeddings, then store two semantically-distinct memories with no
  // token overlap with the query below.
  await cdp.evaljs(`(async()=>{
    await window.electron.updateSettings({ memoryEmbedding: { enabled: true, provider: 'openrouter', model: 'openai/text-embedding-3-small' } });
    await window.electron.memoryStore({ key: 'field-notes', value: 'Studies the deep diving behavior of beaked whales off the Atlantic coast.' });
    await window.electron.memoryStore({ key: 'kitchen', value: 'A sourdough bread recipe with a long overnight fermentation.' });
    return true;
  })()`);

  // Query by MEANING — shares no tokens with "beaked whales diving atlantic",
  // so FTS alone returns nothing; only the vector signal can find it. Poll the
  // search until the async embed-on-store has populated the vector index.
  const searchByMeaning = async () => cdp.evaljs(`(async()=>{
    const r = await window.electron.memorySearch({ query: 'research about ocean mammals', limit: 3 });
    return r.success ? r.results.map(x=>({key:x.key, matchedOn:x.matchedOn})) : null;
  })()`);
  let res = null;
  for (let i = 0; i < 40; i++) {
    res = await searchByMeaning();
    if (Array.isArray(res) && res.some(x => x.matchedOn === 'vector' || x.matchedOn === 'hybrid')) break;
    await sleep(1000);
  }
  check('memories embedded — a by-meaning query returns vector hits', Array.isArray(res) && res.some(x => x.matchedOn === 'vector' || x.matchedOn === 'hybrid'));
  console.log('  → results:', JSON.stringify(res));
  const top = Array.isArray(res) && res[0];
  check('semantic query surfaced the whale note (not the recipe)', !!top && top.key === 'field-notes');
  check('matched via the vector signal (vector/hybrid)', !!top && (top.matchedOn === 'vector' || top.matchedOn === 'hybrid'));
  cdp.close();
} finally {
  sh('stop');
}
console.log(failures ? `\n${failures} check(s) failed` : '\nlive-semantic passed ✓');
process.exit(failures ? 1 : 0);
