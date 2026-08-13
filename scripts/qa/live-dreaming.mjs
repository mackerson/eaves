#!/usr/bin/env node
/**
 * Live suite: dreaming (background consolidation via shadows). Creates a lead
 * agent + a lead-scoped shadow, drives a few real turns with memorable facts,
 * then waits for the shadow to flush and "dream" — asserting it wrote the
 * lead's current_focus core block and/or archival facts tagged shadow-dream.
 *
 *   node scripts/qa/live-dreaming.mjs
 *
 * Slow (~2-3 min): the shadow flushes on a 90s timer, then runs a real model
 * turn. Skips (exit 0) when no ENCLAVE_QA_*_KEY is set.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { connect } from './harness.mjs';

const QA_KEYS = ['ENCLAVE_QA_OPENROUTER_KEY', 'ENCLAVE_QA_ANTHROPIC_KEY', 'ENCLAVE_QA_OPENAI_KEY', 'ENCLAVE_QA_GOOGLE_KEY'];
if (!QA_KEYS.some(k => process.env[k])) { console.log('SKIP: no ENCLAVE_QA_*_KEY in .env.local.'); process.exit(0); }

const provider = process.env.ENCLAVE_QA_PROVIDER || 'openrouter';
const model = process.env.ENCLAVE_QA_MODEL || 'z-ai/glm-5.2';
const harness = path.join(path.dirname(new URL(import.meta.url).pathname), 'harness.mjs');
const scratchDir = process.env.ENCLAVE_QA_DIR || path.join(os.tmpdir(), 'enclave-qa');
const dbPath = path.join(scratchDir, 'xdg', 'enclave', 'enclave-data', 'enclave.db');
const logDir = path.join(scratchDir, 'xdg', 'enclave', 'logs');
const sh = (...a) => execFileSync('node', [harness, ...a], { stdio: 'inherit' });
const q = (sql) => execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`); if (!ok) failures++; };

const FACTS = [
  'My name is Robin and I run Northwind Instruments. Confirm you will remember that.',
  'My dog is named Biscuit. Also, I am building the Enclave memory system this week. Acknowledge both.',
  'The current priority is shipping the dreaming feature. Summarize what you know about me so far.',
];

console.log(`live-dreaming: provider=${provider} model=${model}`);
try { sh('stop'); } catch {}
sh('launch', '--fresh');
try {
  const cdp = await connect(9222);
  const ids = await cdp.evaljs(`(async()=>{
    const l = await window.electron.createAgent({name:'Number 1', provider:${JSON.stringify(provider)}, model:${JSON.stringify(model)}});
    const lead = (l&&l.data&&l.data.id)?l.data:l;
    const s = await window.electron.createAgent({name:'Dreamer', provider:${JSON.stringify(provider)}, model:${JSON.stringify(model)}, archetype:{type:'shadow', leadAgentId: lead.id}});
    const shadow = (s&&s.data&&s.data.id)?s.data:s;
    return { leadId: lead.id, shadowId: shadow.id };
  })()`);
  check('lead + shadow created', !!(ids && ids.leadId && ids.shadowId));

  // Drive real turns so the lead emits memorable events for the shadow.
  const replySql = `SELECT COUNT(*) FROM messages WHERE sender_id='${ids.leadId}' AND sender_type='agent' AND COALESCE(content,'')!='';`;
  for (let idx = 0; idx < FACTS.length; idx++) {
    await cdp.evaljs(`window.electron.sendMessage({channelId:'general-1', agentId:${JSON.stringify(ids.leadId)}, content:${JSON.stringify(FACTS[idx])}})`);
    // Wait for this turn's reply to land before sending the next.
    for (let i = 0; i < 40; i++) {
      let replies = 0;
      try { replies = Number(q(replySql)) || 0; } catch {}
      if (replies >= idx + 1) break;
      await sleep(1500);
    }
  }
  cdp.close();
  console.log('  … turns done; waiting for the shadow to flush + dream (up to ~150s)');

  // Poll for the dream: current_focus written on the lead, or shadow-dream facts.
  let dreamed = false;
  for (let i = 0; i < 150 && !dreamed; i++) {
    try {
      const focus = Number(q(`SELECT COUNT(*) FROM memory_blocks WHERE agent_id='${ids.leadId}' AND label='current_focus' AND COALESCE(value,'')!='';`)) > 0;
      const facts = Number(q(`SELECT COUNT(*) FROM memory_entries WHERE metadata LIKE '%shadow-dream%';`)) > 0;
      dreamed = focus || facts;
      if (dreamed) console.log(`  → dreamed: ${focus ? 'current_focus updated' : ''}${focus && facts ? ' + ' : ''}${facts ? 'archival facts (shadow-dream)' : ''}`);
    } catch {}
    if (!dreamed) await sleep(1000);
  }
  check('shadow dreamed into memory (current_focus and/or archival facts)', dreamed);

  if (!dreamed) {
    try {
      console.log('  --- recent [Shadow] log lines ---');
      console.log(execFileSync('bash', ['-c', `grep -ah '\\[Shadow\\]' ${logDir}/*.log 2>/dev/null | tail -6`], { encoding: 'utf8' }));
    } catch {}
  }
} finally {
  sh('stop');
}
console.log(failures ? `\n${failures} check(s) failed` : '\nlive-dreaming passed ✓');
process.exit(failures ? 1 : 0);
