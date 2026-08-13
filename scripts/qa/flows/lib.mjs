/**
 * Shared helpers for the characterization flows. Each flow drives a running
 * harness instance (scripts/qa/harness.mjs) over CDP and asserts the
 * persistence / event contract of one interactive AI path.
 *
 * Flows exit 0 on pass (skips allowed and reported), 1 on any contract
 * violation. They assume a launched harness — `run-all.mjs` owns the
 * launch --fresh / stop lifecycle.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../harness.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const scratchDir = process.env.ENCLAVE_QA_DIR || path.join(os.tmpdir(), 'enclave-qa');

// Fallback model name used when no local ollama is reachable — the flows then
// characterize the unreachable-provider error contract instead of live turns.
export const FALLBACK_MODEL = 'qwen2.5:0.5b';

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(scratchDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function openHarness() {
  const state = readState();
  if (!state) {
    console.error('FATAL: harness not running — `node scripts/qa/harness.mjs launch --fresh` first (or use flows/run-all.mjs).');
    process.exit(2);
  }
  const cdp = await connect(state.port);
  return { cdp, state };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 8);

/** Run a function in the page context with JSON-serializable args. */
export async function rpc(cdp, fn, args) {
  const expr = `(${fn.toString()})(${args === undefined ? '' : JSON.stringify(args)})`;
  return cdp.evaljs(expr);
}

/**
 * Poll `fetch()` until `pred(value)` holds or timeout. Returns
 * { ok, value } with the last fetched value either way.
 */
export async function pollUntil(fetchFn, pred, { timeout = 20000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let value;
  for (;;) {
    value = await fetchFn();
    if (pred(value)) return { ok: true, value };
    if (Date.now() > deadline) return { ok: false, value };
    await sleep(interval);
  }
}

/**
 * Detect a local ollama and pick the smallest available model (override with
 * ENCLAVE_QA_MODEL). Returns null when unreachable — flows then assert the
 * deterministic error-persistence contract and mark LLM assertions skipped.
 */
export async function detectOllama() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    const { models } = await res.json();
    if (!models?.length) return null;
    if (process.env.ENCLAVE_QA_MODEL) return process.env.ENCLAVE_QA_MODEL;
    return [...models].sort((a, b) => a.size - b.size)[0].name;
  } catch {
    return null;
  }
}

export function makeReport(flowName) {
  const rows = [];
  const log = (status, name, detail) => {
    rows.push({ status, name });
    console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  return {
    assert(name, cond, detail) {
      log(cond ? 'PASS' : 'FAIL', name, cond ? undefined : detail);
      return !!cond;
    },
    skip(name, why) {
      log('SKIP', name, why);
    },
    info(msg) {
      console.log(`     ${msg}`);
    },
    finish() {
      const count = (s) => rows.filter(r => r.status === s).length;
      const failed = count('FAIL');
      console.log(`\n${flowName}: ${failed ? 'FAIL' : 'PASS'} (${count('PASS')} passed, ${failed} failed, ${count('SKIP')} skipped)`);
      process.exit(failed ? 1 : 0);
    },
  };
}

// ── App setup helpers (all run in the page context via rpc) ────────────────

export async function ensureProject(cdp) {
  return rpc(cdp, async () => {
    const mem = await window.electron.getMemory();
    if (mem.currentProjectId) return mem.currentProjectId;
    const created = await window.electron.createProject({ name: 'QA Flows', description: 'Phase-0 characterization flows' });
    const project = created?.project ?? created;
    if (!project?.id) throw new Error('createProject failed: ' + JSON.stringify(created));
    await window.electron.switchProject(project.id);
    return project.id;
  });
}

export async function createAgent(cdp, { name, model, systemPrompt }) {
  return rpc(cdp, async (a) => {
    const agent = await window.electron.createAgent({
      name: a.name,
      description: 'QA characterization agent',
      provider: 'ollama',
      model: a.model,
      temperature: 0,
      ...(a.systemPrompt ? { systemPrompt: a.systemPrompt } : {}),
    });
    if (!agent?.id) throw new Error('createAgent failed: ' + JSON.stringify(agent));
    return { id: agent.id, name: agent.name };
  }, { name, model, systemPrompt });
}

export async function createChannel(cdp, name) {
  const res = await rpc(cdp, async (a) => window.electron.createChannel({ name: a.name, type: 'public' }), { name });
  if (!res?.success || !res.channel?.id) throw new Error('createChannel failed: ' + JSON.stringify(res));
  return res.channel;
}

export async function addParticipant(cdp, channelId, participantId) {
  return rpc(cdp, async (a) => window.electron.addChannelParticipant({ channelId: a.channelId, participantId: a.participantId }), { channelId, participantId });
}

/** Last ~100 messages of a channel (switches the app's current channel). */
export async function channelMessages(cdp, channelId) {
  return rpc(cdp, async (a) => {
    await window.electron.switchChannel(a.channelId);
    const mem = await window.electron.getMemory();
    const ch = (mem.channels || []).find(c => c.id === a.channelId);
    return (ch && ch.messages) || [];
  }, { channelId });
}

export async function chatMessages(cdp, chatId) {
  return rpc(cdp, async (a) => {
    const res = await window.electron.getChat(a.chatId);
    if (!res?.success || !res.chat) throw new Error('getChat failed: ' + JSON.stringify(res));
    return res.chat.messages || [];
  }, { chatId });
}

export const isDispatcherMsg = (m) => m?.metadata?.dispatchedBy === 'channel-dispatcher';

/**
 * Seed channelBehavior directly in the harness profile's SQLite DB.
 *
 * There is deliberately no renderer IPC that writes channel_behavior
 * (UpdateAgentIPCSchema strips it; only the agent self-tool
 * update_my_channel_behavior writes it, which is LLM-driven and
 * nondeterministic) — so respondTo:'all' characterization seeds the column
 * out-of-band via the sqlite3 CLI. WAL mode makes the cross-process write
 * safe; loadAppState/getById re-read the row on every call.
 */
export function seedChannelBehavior(agentId, behavior) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error(`unsafe agentId: ${agentId}`);
  const state = readState();
  if (!state?.xdg) throw new Error('harness state missing xdg dir');
  const db = path.join(state.xdg, 'enclave', 'enclave-data', 'enclave.db');
  const json = JSON.stringify(behavior).replace(/'/g, "''");
  execFileSync('sqlite3', ['-cmd', '.timeout 3000', db,
    `UPDATE agents SET channel_behavior = '${json}' WHERE id = '${agentId}'`]);
}
