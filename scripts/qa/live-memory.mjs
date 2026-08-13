#!/usr/bin/env node
/**
 * Live suite: memory tool-calling. Verifies a real agent turn actually invokes
 * the core memory tools — the agent is asked to remember a fact, and we assert
 * it lands in the store (via store_memory) or core memory (via core_memory_*).
 *
 *   node scripts/qa/live-memory.mjs
 *
 * Skips (exit 0) when no ENCLAVE_QA_*_KEY is set.
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
const sh = (...a) => execFileSync('node', [harness, ...a], { stdio: 'inherit' });
const q = (sql) => execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`); if (!ok) failures++; };

console.log(`live-memory: provider=${provider} model=${model}`);
try { sh('stop'); } catch {}
sh('launch', '--fresh');
try {
  const cdp = await connect(9222);
  const r = await cdp.evaljs(`(async()=>{
    const a = await window.electron.createAgent({name:'Mnemo', provider:${JSON.stringify(provider)}, model:${JSON.stringify(model)},
      systemPrompt:'You have persistent memory tools (store_memory, core_memory_append). When asked to remember something, you MUST call the appropriate tool to actually save it.'});
    const agent = (a&&a.data&&a.data.id)?a.data:a;
    const send = await window.electron.sendMessage({channelId:'general-1', agentId: agent.id,
      content:'Use your memory tools to permanently remember this fact: my dog is named Biscuit. Actually call the tool, then reply "saved".'});
    return { sent: !!(send&&send.success) };
  })()`);
  check('agent created + request sent', !!(r && r.sent));
  cdp.close();

  // Poll for the fact landing in either archival (store_memory) or a core block (core_memory_*).
  let found = false;
  for (let i = 0; i < 90 && !found; i++) {
    try {
      const inArchival = Number(q(`SELECT COUNT(*) FROM memory_entries WHERE value LIKE '%Biscuit%';`)) > 0;
      const inCore = Number(q(`SELECT COUNT(*) FROM memory_blocks WHERE value LIKE '%Biscuit%';`)) > 0;
      found = inArchival || inCore;
      if (found) console.log(`  → stored in ${inArchival ? 'archival (store_memory)' : 'core memory (core_memory_*)'}`);
    } catch {}
    if (!found) await sleep(1000);
  }
  check('agent persisted the fact via a memory tool', found);
} finally {
  sh('stop');
}
console.log(failures ? `\n${failures} check(s) failed` : '\nlive-memory passed ✓');
process.exit(failures ? 1 : 0);
