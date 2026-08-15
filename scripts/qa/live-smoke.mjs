#!/usr/bin/env node
/**
 * Live smoke test — the first "keyed" suite. Unlike the headless harness (which
 * runs keyless), this makes a REAL model call: it launches a fresh isolated
 * instance with a provider key seeded from .env.local, drives a real agent turn,
 * and asserts the agent actually replied.
 *
 *   node scripts/qa/live-smoke.mjs
 *
 * Skips cleanly (exit 0) when no EAVES_QA_*_KEY is set, so it's safe to wire
 * into a broader run. Requires `yarn build:main` + `yarn build:renderer` first
 * (same as the harness), and sqlite for the Electron ABI (`yarn rebuild-sqlite3`).
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { connect } from './harness.mjs'; // side effect: loads .env.local (isCli-guarded, no main())

const QA_KEYS = ['EAVES_QA_OPENROUTER_KEY', 'EAVES_QA_ANTHROPIC_KEY', 'EAVES_QA_OPENAI_KEY', 'EAVES_QA_GOOGLE_KEY'];
if (!QA_KEYS.some(k => process.env[k])) {
  console.log('SKIP: no EAVES_QA_*_KEY in .env.local — live smoke skipped (expected until a key is added).');
  process.exit(0);
}

const provider = process.env.EAVES_QA_PROVIDER || 'openrouter';
const model = process.env.EAVES_QA_MODEL || 'z-ai/glm-4.6';
const harness = path.join(path.dirname(new URL(import.meta.url).pathname), 'harness.mjs');
const scratchDir = process.env.EAVES_QA_DIR || path.join(os.tmpdir(), 'eaves-qa');
const dbPath = path.join(scratchDir, 'xdg', 'eaves', 'eaves-data', 'eaves.db');

const sh = (...a) => execFileSync('node', [harness, ...a], { stdio: 'inherit' });
const dbCount = (sql) => Number(execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim() || '0');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`); if (!ok) failures++; };

console.log(`live-smoke: provider=${provider} model=${model}`);
try { sh('stop'); } catch { /* nothing running */ }
sh('launch', '--fresh');

try {
  const cdp = await connect(9222);

  // Key present? Boolean only — never read the value back.
  const keyed = await cdp.evaljs(
    `(async()=>{const s=await window.electron.getMemory();return !!(s&&s.settings&&s.settings.apiKeys&&s.settings.apiKeys[${JSON.stringify(provider)}]);})()`,
  );
  check('provider key seeded into settings', keyed === true);

  const r = await cdp.evaljs(`(async()=>{
    const a = await window.electron.createAgent({name:'Live', provider:${JSON.stringify(provider)}, model:${JSON.stringify(model)}});
    const agent = (a&&a.data&&a.data.id)?a.data:a;
    const send = await window.electron.sendMessage({channelId:'general-1', content:'Reply with exactly one word: pong', agentId: agent.id});
    return { agentId: agent.id, sent: !!(send&&send.success) };
  })()`);
  check('agent created + message sent', !!(r && r.sent));
  cdp.close();

  // Poll the profile DB for a non-empty agent reply (real model latency).
  let replied = false;
  for (let i = 0; i < 60 && !replied; i++) {
    try { replied = dbCount(`SELECT COUNT(*) FROM messages WHERE channel_id='general-1' AND sender_type='agent' AND COALESCE(content,'') != '';`) > 0; } catch { /* db may be momentarily locked */ }
    if (!replied) await sleep(1000);
  }
  check('agent produced a real reply', replied);
} finally {
  sh('stop');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nlive-smoke passed ✓');
process.exit(failures ? 1 : 0);
