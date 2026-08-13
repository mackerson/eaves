#!/usr/bin/env node
/**
 * Live suite: cross-provider tool-calling. For each provider whose key is set,
 * spins up an agent on a cheap model, asks it to remember a provider-unique
 * fact via a memory tool, and asserts the fact persists — proving real agent
 * turns + memory-tool invocation work across OpenRouter / Anthropic / OpenAI.
 *
 *   node scripts/qa/live-providers.mjs
 *
 * Skips (exit 0) when no ENCLAVE_QA_*_KEY is set. Per-provider model defaults
 * are overridable via ENCLAVE_QA_<PROVIDER>_MODEL.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { connect } from './harness.mjs';

const PROVIDERS = [
  { id: 'openrouter', env: 'ENCLAVE_QA_OPENROUTER_KEY', model: process.env.ENCLAVE_QA_OPENROUTER_MODEL || process.env.ENCLAVE_QA_MODEL || 'z-ai/glm-5.2' },
  { id: 'anthropic', env: 'ENCLAVE_QA_ANTHROPIC_KEY', model: process.env.ENCLAVE_QA_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001' },
  { id: 'openai', env: 'ENCLAVE_QA_OPENAI_KEY', model: process.env.ENCLAVE_QA_OPENAI_MODEL || 'gpt-4o-mini' },
].filter(p => process.env[p.env]);

if (PROVIDERS.length === 0) { console.log('SKIP: no ENCLAVE_QA_*_KEY in .env.local.'); process.exit(0); }

const harness = path.join(path.dirname(new URL(import.meta.url).pathname), 'harness.mjs');
const scratchDir = process.env.ENCLAVE_QA_DIR || path.join(os.tmpdir(), 'enclave-qa');
const dbPath = path.join(scratchDir, 'xdg', 'enclave', 'enclave-data', 'enclave.db');
const sh = (...a) => execFileSync('node', [harness, ...a], { stdio: 'inherit' });
const q = (sql) => execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`); if (!ok) failures++; };

console.log(`live-providers: ${PROVIDERS.map(p => p.id).join(', ')}`);
try { sh('stop'); } catch {}
sh('launch', '--fresh');
try {
  const cdp = await connect(9222);
  for (const p of PROVIDERS) {
    const token = `Biscuit-${p.id}`;
    const r = await cdp.evaljs(`(async()=>{
      const a = await window.electron.createAgent({name:${JSON.stringify('T-' + p.id)}, provider:${JSON.stringify(p.id)}, model:${JSON.stringify(p.model)},
        systemPrompt:'You have a store_memory tool. When asked to remember something you MUST call it to save the fact, then reply "saved".'});
      const agent = (a&&a.data&&a.data.id)?a.data:a;
      const send = await window.electron.sendMessage({channelId:'general-1', agentId: agent.id,
        content:${JSON.stringify(`Use store_memory to permanently remember: my dog is named ${token}. Call the tool, then reply saved.`)}});
      return { sent: !!(send&&send.success) };
    })()`);
    if (!(r && r.sent)) { check(`${p.id} (${p.model}): turn sent`, false); continue; }

    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      try {
        found = Number(q(`SELECT COUNT(*) FROM memory_entries WHERE value LIKE '%${token}%';`)) > 0
             || Number(q(`SELECT COUNT(*) FROM memory_blocks WHERE value LIKE '%${token}%';`)) > 0;
      } catch {}
      if (!found) await sleep(1000);
    }
    check(`${p.id} (${p.model}): agent called a memory tool + fact persisted`, found);
  }
  cdp.close();
} finally {
  sh('stop');
}
console.log(failures ? `\n${failures} provider check(s) failed` : '\nlive-providers passed ✓');
process.exit(failures ? 1 : 0);
