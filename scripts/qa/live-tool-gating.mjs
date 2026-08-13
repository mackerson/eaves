#!/usr/bin/env node
/**
 * Live suite: does tool deferral cost behaviour?
 *
 * Deferred tools (the workflow/routine authoring surface) are kept off the wire
 * until something enables them — worth ~32% of the tool-schema bill, but only
 * if agents can still reach them via list_tools → enable_tool → use. No token
 * count answers that; this does, by asking two agents to build the same
 * workflow:
 *
 *   gated    — default config. Must discover the authoring tools.
 *   ungated  — the same agent with the deferred tools in defaultTools, so they
 *              are seeded enabled and ride along from turn 1. This is the
 *              pre-deferral control.
 *
 * The pass condition is behavioural, not economic: the gated agent must still
 * produce a valid workflow. Token and turn deltas are reported for comparison
 * but never fail the run — paying a discovery step is the known, accepted cost.
 *
 *   node scripts/qa/live-tool-gating.mjs
 *
 * Skips (exit 0) when no ENCLAVE_QA_*_KEY is set. Costs real tokens: two
 * multi-step tool-using turns against whichever model is configured.
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

// Kept in sync with the deferTool() calls in builtinTools.ts. Seeding these as
// defaultTools is what reproduces pre-deferral behaviour.
const DEFERRED = [
  'get_workflow', 'create_workflow', 'update_workflow', 'delete_workflow',
  'create_routine', 'update_routine', 'toggle_routine', 'delete_routine', 'execute_routine',
];

const TASK = 'Create a workflow named "Morning Digest" that fetches https://example.com/report.json '
  + 'and then runs a small javascript step to summarise it. Two working nodes, wired start to end. '
  + 'Build it with the tools available to you.';

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`); if (!ok) failures++; };

/** Everything the run produced, scoped to one agent's messages. */
function stats(agentId) {
  const num = (sql) => Number(q(sql) || 0);
  return {
    turns: num(`SELECT COUNT(*) FROM messages WHERE sender_id='${agentId}' AND sender_type='agent';`),
    inputTokens: num(`SELECT COALESCE(SUM(json_extract(metrics,'$.inputTokens')),0) FROM messages WHERE sender_id='${agentId}';`),
    // requestInfo is written by the main-process turn path, so it is present
    // here even though the renderer IPC schema would strip it.
    firstToolCount: num(`SELECT json_extract(metrics,'$.requestInfo.toolCount') FROM messages WHERE sender_id='${agentId}' AND json_extract(metrics,'$.requestInfo.toolCount') IS NOT NULL ORDER BY timestamp ASC LIMIT 1;`),
  };
}

/** Workflows created since `sinceCount`, with a crude validity read. */
function newWorkflows(sinceCount) {
  const rows = q(`SELECT dag_definition FROM workflows WHERE created_by='agent' ORDER BY created_at ASC LIMIT -1 OFFSET ${sinceCount};`);
  if (!rows) return [];
  return rows.split('\n').filter(Boolean).map(raw => {
    try {
      const dag = JSON.parse(raw);
      const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
      // create_workflow rejects nodes missing their required data, so anything
      // stored is already structurally valid; this just confirms it is not an
      // empty shell.
      const working = nodes.filter(n => n.type !== 'start' && n.type !== 'end');
      return { nodes: nodes.length, working: working.length, types: working.map(n => n.type) };
    } catch { return { nodes: 0, working: 0, types: [], unparseable: true }; }
  });
}

async function runAgent(label, extra) {
  const cdp = await connect(9222);
  const r = await cdp.evaljs(`(async()=>{
    const a = await window.electron.createAgent(Object.assign(
      {name:${JSON.stringify(label)}, provider:${JSON.stringify(provider)}, model:${JSON.stringify(model)}},
      ${JSON.stringify(extra)}));
    const agent = (a&&a.data&&a.data.id)?a.data:a;
    const send = await window.electron.sendMessage({channelId:'general-1', agentId: agent.id,
      content:${JSON.stringify(TASK)}});
    return { id: agent.id, sent: !!(send&&send.success) };
  })()`);
  cdp.close();
  return r;
}

/** Wait until the agent stops producing new messages, or we give up. */
async function settle(agentId, maxSeconds = 180) {
  let last = -1, stableFor = 0;
  for (let i = 0; i < maxSeconds; i++) {
    await sleep(1000);
    const n = stats(agentId).turns;
    if (n === last && n > 0) { if (++stableFor >= 8) return true; } else { stableFor = 0; last = n; }
  }
  return false;
}

console.log(`live-tool-gating: provider=${provider} model=${model}`);
console.log(`  deferred set (${DEFERRED.length}): ${DEFERRED.join(', ')}\n`);
try { sh('stop'); } catch {}
sh('launch', '--fresh');

const results = {};
try {
  for (const [label, extra] of [['Gated', {}], ['Ungated', { defaultTools: DEFERRED }]]) {
    const before = Number(q(`SELECT COUNT(*) FROM workflows WHERE created_by='agent';`) || 0);
    console.log(`\n── ${label} ──`);
    const r = await runAgent(label, extra);
    check(`${label}: agent created and task sent`, !!(r && r.sent));
    if (!r || !r.sent) continue;

    const finished = await settle(r.id);
    if (!finished) console.log(`  ! ${label} did not settle within the timeout — numbers below may be partial`);

    const s = stats(r.id);
    const built = newWorkflows(before);
    results[label] = { ...s, built };
    console.log(`  turns=${s.turns}  inputTokens=${s.inputTokens}  toolsOnFirstRequest=${s.firstToolCount || 'n/a'}`);
    console.log(`  workflows created: ${built.length}${built.length ? ` → ${built.map(b => `${b.working} working node(s) [${b.types.join(', ')}]`).join('; ')}` : ''}`);
  }

  // The behavioural claim under test: gating must not cost the capability.
  const gated = results.Gated;
  check('gated agent still produced a workflow', !!(gated && gated.built.length > 0));
  check('gated workflow has real working nodes, not an empty shell',
    !!(gated && gated.built.some(b => b.working > 0)));

  const ungated = results.Ungated;
  if (gated && ungated) {
    const dTok = ungated.inputTokens - gated.inputTokens;
    const dTurns = gated.turns - ungated.turns;
    console.log('\n── comparison ──');
    console.log(`  input tokens : gated=${gated.inputTokens}  ungated=${ungated.inputTokens}  saved=${dTok}` +
      (ungated.inputTokens ? ` (${(100 * dTok / ungated.inputTokens).toFixed(1)}%)` : ''));
    console.log(`  turns        : gated=${gated.turns}  ungated=${ungated.turns}  discovery cost=${dTurns > 0 ? `+${dTurns}` : dTurns}`);
    if (gated.firstToolCount && ungated.firstToolCount) {
      console.log(`  tools sent   : gated=${gated.firstToolCount}  ungated=${ungated.firstToolCount}`);
      check('gated agent was sent fewer tools than ungated', gated.firstToolCount < ungated.firstToolCount);
    }
    // Reported, never asserted — one extra step is the accepted price.
    if (dTok < 0) console.log('  ! gating cost MORE input tokens here — discovery outweighed the schema saving');
  }
} finally {
  sh('stop');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nlive-tool-gating passed ✓');
process.exit(failures ? 1 : 0);
