#!/usr/bin/env node
/**
 * Cold-start + idle-memory benchmark for the beta perf gate.
 *
 *   node scripts/qa/benchmark.mjs [--runs 3] [--headless] [--mem-idle 60]
 *
 * Cold start = wall-clock from electron spawn to the main process logging
 * `[Main] did-finish-load` (renderer mounted). Each run gets a FRESH profile —
 * the honest clean-box first-run number, not a warm-cache best case.
 *
 * Idle memory = summed RSS of the whole electron process tree after the app
 * sits idle for --mem-idle seconds post-mount.
 *
 * DEFAULT is headed (a real window + GPU process) because --headless --disable-gpu
 * undercounts memory and skews paint timing — pass --headless for a CI lower bound.
 * Targets: cold start < 3.0s avg, idle memory < 200 MB.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const scratch = process.env.EAVES_QA_DIR || path.join(process.env.TMPDIR || '/tmp', 'eaves-qa-bench');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const RUNS = Number(arg('--runs', 3));
const HEADLESS = process.argv.includes('--headless');
const MEM_IDLE = Number(arg('--mem-idle', 60));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function portUp(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
}

/**
 * Memory of the whole electron process tree rooted at `root`.
 * Reports PSS (proportional set size — shared pages counted once, the honest
 * cross-process footprint) as primary, with naive RSS-sum for reference. Summing
 * RSS across Chromium processes double-counts the shared framework and can 5×
 * the real number, so PSS is what the < 200 MB gate should judge.
 */
function treeMemory(root) {
  const out = execSync('ps -e -o pid=,ppid=').toString().trim().split('\n');
  const kids = new Map();
  for (const line of out) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const pids = []; const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    pids.push(p);
    for (const c of (kids.get(p) || [])) stack.push(c);
  }
  let pssKb = 0, rssKb = 0, counted = 0;
  for (const pid of pids) {
    try {
      const roll = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = /^Pss:\s+(\d+)/m.exec(roll);
      const rss = /^Rss:\s+(\d+)/m.exec(roll);
      if (pss) pssKb += Number(pss[1]);
      if (rss) rssKb += Number(rss[1]);
      counted++;
    } catch { /* process exited between snapshot and read */ }
  }
  return { pids, counted, pssKb, rssKb };
}

function killTree(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group may be gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
}

async function ensureRenderer() {
  if (await portUp(5173)) return null;
  const dist = path.join(repoRoot, 'dist', 'renderer');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error('FATAL: no server on :5173 and dist/renderer missing — run `yarn build:renderer`.');
    process.exit(1);
  }
  const harness = path.join(repoRoot, 'scripts', 'qa', 'harness.mjs');
  const s = spawn(process.execPath, [harness, '_serve', dist, '5173'], { detached: true, stdio: 'ignore' });
  s.unref();
  for (let i = 0; i < 20 && !(await portUp(5173)); i++) await sleep(200);
  console.log(`renderer: spawned static server on :5173 (pid ${s.pid})`);
  return s.pid;
}

/** One cold start against a fresh profile. Returns { coldMs, pid, logPath, xdg }. */
async function coldStart(runIdx) {
  const xdg = path.join(scratch, `run-${runIdx}`);
  fs.rmSync(xdg, { recursive: true, force: true });
  fs.mkdirSync(xdg, { recursive: true });
  const logPath = path.join(xdg, 'electron.out');
  const logFd = fs.openSync(logPath, 'w');

  const electronArgs = ['.', '--remote-debugging-port=0'];
  if (HEADLESS) electronArgs.push('--headless=new', '--disable-gpu');
  const bin = path.join(repoRoot, 'node_modules', '.bin', 'electron');

  const t0 = Date.now();
  const child = spawn(bin, electronArgs, {
    cwd: repoRoot,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
    detached: true,               // own process group so we can kill the whole tree
    stdio: ['ignore', logFd, logFd],
  });

  // Watch the app's own log for the did-finish-load marker.
  const appLog = path.join(xdg, 'eaves', 'logs');
  const deadline = t0 + 30000;
  let coldMs = null;
  while (Date.now() < deadline && coldMs === null) {
    await sleep(50);
    try {
      for (const f of fs.readdirSync(appLog)) {
        if (fs.readFileSync(path.join(appLog, f), 'utf8').includes('[Main] did-finish-load')) {
          coldMs = Date.now() - t0;
          break;
        }
      }
    } catch { /* logs dir not created yet */ }
  }
  return { coldMs, pid: child.pid, logPath, xdg };
}

(async () => {
  console.log(`Eaves perf benchmark — ${RUNS} runs, ${HEADLESS ? 'HEADLESS (lower bound)' : 'HEADED (honest)'}\n`);
  const serverPid = await ensureRenderer();
  const cold = [];

  for (let i = 1; i <= RUNS; i++) {
    const r = await coldStart(i);
    if (r.coldMs === null) {
      console.log(`  run ${i}: ✗ never reached did-finish-load (see ${r.logPath})`);
      killTree(r.pid);
      continue;
    }
    cold.push(r.coldMs);
    let memLine = '';
    if (i === RUNS) {
      // Hold the last instance idle, then sample the whole tree.
      process.stdout.write(`  run ${i}: cold ${(r.coldMs / 1000).toFixed(2)}s — idling ${MEM_IDLE}s for memory…`);
      await sleep(MEM_IDLE * 1000);
      const { counted, pssKb, rssKb } = treeMemory(r.pid);
      var memMb = pssKb / 1024;
      console.log(`  PSS ${memMb.toFixed(0)} MB (RSS-sum ${(rssKb / 1024).toFixed(0)} MB) across ${counted} procs`);
    } else {
      console.log(`  run ${i}: cold ${(r.coldMs / 1000).toFixed(2)}s`);
    }
    killTree(r.pid);
    await sleep(10000); // checklist: 10s for the OS to release caches between cold starts
  }

  if (serverPid) killTree(serverPid);

  const avg = cold.reduce((a, b) => a + b, 0) / cold.length / 1000;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  cold start: ${cold.map(c => (c / 1000).toFixed(2)).join('s, ')}s`);
  console.log(`  cold avg:   ${avg.toFixed(2)}s   ${avg < 3 ? '✅ < 3.0s' : '❌ ≥ 3.0s'}`);
  if (typeof memMb === 'number')
    console.log(`  idle mem:   ${memMb.toFixed(0)} MB PSS  ${memMb < 200 ? '✅ < 200 MB' : '❌ ≥ 200 MB'}`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(0);
})();
