#!/usr/bin/env node
/**
 * Live suite: output-truncation surfacing. Creates an agent with
 * a tiny maxOutputTokens, asks for a long reply so the turn hits the limit, and
 * asserts the cut-off is surfaced — the "⚠️ …cut off at the output-token limit"
 * system note (finishReason='length' handling in AgentTurnService), NOT a reply
 * silently presented as complete.
 *
 *   node scripts/qa/live-truncation.mjs
 *
 * Skips (exit 0) when no EAVES_QA_*_KEY is set.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { connect } from './harness.mjs';

const QA_KEYS = ['EAVES_QA_OPENROUTER_KEY', 'EAVES_QA_ANTHROPIC_KEY', 'EAVES_QA_OPENAI_KEY', 'EAVES_QA_GOOGLE_KEY'];
if (!QA_KEYS.some(k => process.env[k])) { console.log('SKIP: no EAVES_QA_*_KEY in .env.local.'); process.exit(0); }

const provider = process.env.EAVES_QA_PROVIDER || 'openrouter';
const model = process.env.EAVES_QA_MODEL || 'z-ai/glm-5.2';
const harness = path.join(path.dirname(new URL(import.meta.url).pathname), 'harness.mjs');
const scratchDir = process.env.EAVES_QA_DIR || path.join(os.tmpdir(), 'eaves-qa');
const dbPath = path.join(scratchDir, 'xdg', 'eaves', 'eaves-data', 'eaves.db');
const sh = (...a) => execFileSync('node', [harness, ...a], { stdio: 'inherit' });
const q = (sql) => execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`); if (!ok) failures++; };

console.log(`live-truncation: provider=${provider} model=${model}`);
try { sh('stop'); } catch {}
sh('launch', '--fresh');
try {
  const cdp = await connect(9222);
  const r = await cdp.evaljs(`(async()=>{
    const a = await window.electron.createAgent({name:'Terse', provider:${JSON.stringify(provider)}, model:${JSON.stringify(model)}, maxOutputTokens: 32});
    const agent = (a&&a.data&&a.data.id)?a.data:a;
    const send = await window.electron.sendMessage({channelId:'general-1', agentId: agent.id,
      content:'Write a detailed 400-word essay about the ocean. No preamble — just the essay.'});
    return { sent: !!(send&&send.success) };
  })()`);
  check('agent (maxOutputTokens=32) created + long request sent', !!(r && r.sent));
  cdp.close();

  // Poll for the truncation surfacing: the system note in content_blocks, or
  // finishReason='length' in metrics.
  let surfaced = false, how = '';
  for (let i = 0; i < 60 && !surfaced; i++) {
    try {
      if (Number(q(`SELECT COUNT(*) FROM messages WHERE sender_type='agent' AND content_blocks LIKE '%cut off at the output-token limit%';`)) > 0) { surfaced = true; how = 'system note'; }
      else if (Number(q(`SELECT COUNT(*) FROM messages WHERE sender_type='agent' AND metrics LIKE '%"finishReason":"length"%';`)) > 0) { surfaced = true; how = "finishReason='length'"; }
    } catch {}
    if (!surfaced) await sleep(1000);
  }
  if (surfaced) console.log(`  → truncation surfaced via ${how}`);
  check('cut-off reply is surfaced, not silently presented as complete', surfaced);
} finally {
  sh('stop');
}
console.log(failures ? `\n${failures} check(s) failed` : '\nlive-truncation passed ✓');
process.exit(failures ? 1 : 0);
