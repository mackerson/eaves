#!/usr/bin/env node
/**
 * Headless E2E QA harness: launches an isolated Eaves instance (fresh
 * XDG config dir → fresh DB, never the real profile) with Chrome DevTools
 * Protocol enabled, and drives it via Runtime.evaluate against the real
 * renderer + real IPC.
 *
 * Zero dependencies (Node 22+: global fetch/WebSocket). Electron runs the
 * COMPILED main process — run `yarn build:main` (and `yarn build:renderer`
 * if no Vite dev server is up) before launching, or you're testing stale
 * code. The harness warns on staleness but does not rebuild for you.
 *
 * Usage:
 *   node scripts/qa/harness.mjs launch [--fresh] [--port 9222] [--headed]
 *   node scripts/qa/harness.mjs eval '<js expression>'   # awaited, JSON out
 *   node scripts/qa/harness.mjs screenshot [out.png]
 *   node scripts/qa/harness.mjs stop
 *
 * The CDP port is an unauthenticated localhost debug socket — local runs
 * only, never expose it beyond 127.0.0.1.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratchDir = process.env.EAVES_QA_DIR || path.join(os.tmpdir(), 'eaves-qa');
const stateFile = path.join(scratchDir, 'state.json');
// Tracked separately from state.json: the static server can outlive a run, and
// a leaked one silently serves a stale bundle to every launch that follows.
const serverFile = path.join(scratchDir, 'renderer-server.json');

// Load EAVES_QA_* vars from the gitignored .env.local so keyed/live runs can
// seed provider keys without the value ever touching a command line. Minimal
// parser — keeps the harness dependency-free. Existing env wins.
function loadEnvLocal() {
  const p = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, k, rawV] = m;
    if (process.env[k] === undefined) process.env[k] = rawV.replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

// Provider → env var holding its API key for keyed/live harness runs.
const QA_KEY_ENV = {
  openrouter: 'EAVES_QA_OPENROUTER_KEY',
  anthropic: 'EAVES_QA_ANTHROPIC_KEY',
  openai: 'EAVES_QA_OPENAI_KEY',
  google: 'EAVES_QA_GOOGLE_KEY',
};

/**
 * Inject provider API keys from the environment into the fresh profile's
 * settings over CDP, so keyed/live runs can make real model calls. The key
 * VALUE is read from process.env (from gitignored .env.local) and is never
 * printed — only provider names are logged.
 */
export async function seedProviderKeys(cdp) {
  const apiKeys = {};
  for (const [provider, envVar] of Object.entries(QA_KEY_ENV)) {
    if (process.env[envVar]) apiKeys[provider] = process.env[envVar];
  }
  if (Object.keys(apiKeys).length === 0) return [];
  await cdp.evaljs(`(async () => { await window.electron.updateSettings({ apiKeys: ${JSON.stringify(apiKeys)} }); return true; })()`);
  const names = Object.keys(apiKeys);
  console.log(`seeded provider key(s): ${names.join(', ')}`);
  return names;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

export async function connect(port = 9222) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error(`no app page target on :${port} (targets: ${targets.map(t => t.url).join(', ')})`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };

  const send = (method, params = {}) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(r => pending.set(id, r));
  };

  const evaljs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
      throw new Error(`page threw: ${res.result.exceptionDetails.exception?.description || JSON.stringify(res.result.exceptionDetails)}`);
    }
    return res.result?.result?.value;
  };

  const screenshot = async (outPath) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'));
    return outPath;
  };

  const waitFor = async (expression, { timeout = 10000, interval = 250 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaljs(expression)) return true;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`waitFor timed out after ${timeout}ms: ${expression}`);
  };

  return { evaljs, send, screenshot, waitFor, close: () => ws.close() };
}

// ---------------------------------------------------------------------------
// Launch pieces
// ---------------------------------------------------------------------------

/**
 * Probe through `localhost`, not 127.0.0.1, because that is what the app does
 * (main.ts loads `http://localhost:<port>`) and the two do not always agree:
 * Vite binds [::1] while this harness's static server binds 127.0.0.1, so on a
 * dual-stack box each can hold "port 5173" independently. Resolving the same
 * way the app does is what keeps the harness's report — which server is
 * serving the renderer — true of the renderer actually under test.
 */
async function portUp(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** The ports main.ts probes, in the order it probes them. */
const RENDERER_PORTS = [5173, 5174, 5175, 5176, 5177, 5178, 5179];

/**
 * True when `port` serves *this* app's renderer.
 *
 * "Something is listening on 5173" is not the same question. Any other project's
 * dev server can hold it — and one did, which is how a launch reported "using
 * existing Vite dev server" while Electron loaded a stranger's 404 page and
 * every assertion failed for reasons that had nothing to do with the code under
 * test. main.ts takes the first port answering 200, so match on the title it
 * would then be rendering.
 */
async function servesRenderer(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    return (await res.text()).includes('<title>Eaves</title>');
  } catch {
    return false;
  }
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const t = fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

function warnIfStale() {
  // package.json "main" → dist/main/main/main.js (tsc outDir dist/main, rootDir src)
  const compiledMain = path.join(repoRoot, 'dist', 'main', 'main', 'main.js');
  if (!fs.existsSync(compiledMain)) {
    console.error('FATAL: dist/main/main.js missing — run `yarn build:main` first.');
    process.exit(1);
  }
  if (newestMtime(path.join(repoRoot, 'src', 'main')) > fs.statSync(compiledMain).mtimeMs) {
    console.warn('WARNING: src/main is newer than dist/main — run `yarn build:main` or you are testing stale main-process code.');
  }
}

/**
 * True when dist/renderer predates the renderer sources it was built from.
 *
 * Only meaningful when the harness is serving that bundle — a Vite dev server
 * transforms from source and is never stale. Silent staleness here is worse
 * than the main-process kind: the app boots, the UI renders, every assertion
 * runs against code you did not write, and a fix under test reads as a bug.
 */
function rendererIsStale() {
  const rendererDist = path.join(repoRoot, 'dist', 'renderer');
  const built = path.join(rendererDist, 'index.html');
  if (!fs.existsSync(built)) return false;
  const builtAt = fs.statSync(built).mtimeMs;
  return ['renderer', 'shared'].some(
    dir => newestMtime(path.join(repoRoot, 'src', dir)) > builtAt,
  );
}

/**
 * Ask whoever holds :5173 whether it is one of our static servers.
 *
 * A leaked server from an earlier run answers here; a Vite dev server does
 * not. Worth distinguishing, because reusing a leaked one silently serves
 * whatever `dist/renderer` held when it started.
 */
async function identifyRendererServer(port = 5173) {
  try {
    const res = await fetch(`http://localhost:${port}/__harness`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { kind: 'other' };
    const body = await res.json();
    return body?.harness ? { kind: 'harness-static', ...body } : { kind: 'other' };
  } catch {
    return { kind: 'other' };
  }
}

async function skipOobe(cdp) {
  await cdp.waitFor(`!!document.querySelector('#oobe-username') || document.body.innerText.includes('CONVERSATIONS')`, { timeout: 20000 });
  const hasOobe = await cdp.evaljs(`!!document.querySelector('#oobe-username')`);
  if (!hasOobe) return;
  await cdp.evaljs(`(() => {
    const input = document.querySelector('#oobe-username');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'QA');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find(b => /skip setup/i.test(b.innerText));
    if (btn) btn.click();
    return true;
  })()`);
  await cdp.waitFor(`document.body.innerText.includes('CONVERSATIONS')`, { timeout: 15000 });
}

async function launch() {
  warnIfStale();
  const port = Number(arg('--port', 9222));
  const fresh = process.argv.includes('--fresh');
  const headed = process.argv.includes('--headed');

  if (readState()) {
    console.error(`FATAL: state file exists (${stateFile}) — a harness instance may be running. Run \`stop\` first.`);
    process.exit(1);
  }

  const xdg = path.join(scratchDir, 'xdg');
  if (fresh) fs.rmSync(xdg, { recursive: true, force: true });
  fs.mkdirSync(xdg, { recursive: true });

  // The app's renderer loader tries ports 5173-5179 and takes the first that
  // answers 200. Find one already serving *our* renderer; failing that, serve
  // the built bundle ourselves on the first port nothing is holding.
  let serverPid = null;
  let servingPort = null;
  for (const p of RENDERER_PORTS) {
    if (await servesRenderer(p)) { servingPort = p; break; }
  }

  if (servingPort !== null) {
    // Something already serves the renderer. A Vite dev server is fine — it
    // builds from source. One of our own static servers, left over from an
    // earlier run, is not: it serves the bundle as it was when that run
    // started, so renderer changes since then are invisible and every UI
    // assertion is quietly measuring old code.
    const existing = await identifyRendererServer(servingPort);
    if (existing.kind === 'harness-static') {
      const startedAt = existing.startedAt ? new Date(existing.startedAt).toLocaleTimeString() : 'unknown time';
      console.warn(`WARNING: reusing a leftover harness static server on :${servingPort} (pid ${existing.pid}, started ${startedAt}).`);
      console.warn('         It serves dist/renderer as of its own start — `stop` then `launch` to pick up a newer build.');
      if (rendererIsStale()) {
        console.warn('         dist/renderer is ALSO older than src/renderer — run `yarn build:renderer` first.');
      }
      // Adopt it so `stop` cleans it up even though this run didn't spawn it.
      serverPid = existing.pid ?? null;
    } else {
      console.log(`renderer: using existing server on :${servingPort} (Vite dev server — builds from source)`);
    }
  } else {
    const rendererDist = path.join(repoRoot, 'dist', 'renderer');
    if (!fs.existsSync(path.join(rendererDist, 'index.html'))) {
      console.error('FATAL: no Vite dev server serving the renderer and dist/renderer missing — run `yarn build:renderer` or `yarn dev`.');
      process.exit(1);
    }
    if (rendererIsStale()) {
      console.warn('WARNING: src/renderer is newer than dist/renderer — run `yarn build:renderer` or you are testing stale renderer code.');
    }
    let freePort = null;
    for (const p of RENDERER_PORTS) {
      if (!(await portUp(p))) { freePort = p; break; }
    }
    if (freePort === null) {
      console.error(`FATAL: ports ${RENDERER_PORTS[0]}-${RENDERER_PORTS.at(-1)} are all occupied by servers that are not the Eaves renderer.`);
      process.exit(1);
    }
    if (freePort !== RENDERER_PORTS[0]) {
      console.warn(`NOTE: :${RENDERER_PORTS[0]} is held by a server that is not the Eaves renderer — using :${freePort}.`);
    }
    const server = spawn(process.execPath, [fileURLToPath(import.meta.url), '_serve', rendererDist, String(freePort)], {
      detached: true,
      stdio: 'ignore',
    });
    server.unref();
    serverPid = server.pid;
    servingPort = freePort;
    writeServerFile(serverPid, rendererDist, freePort);
    console.log(`static renderer server: pid ${serverPid} serving dist/renderer on :${freePort}`);
  }

  const electronArgs = ['.', `--remote-debugging-port=${port}`];
  if (!headed) electronArgs.push('--headless=new', '--disable-gpu');
  const logPath = path.join(scratchDir, 'electron.log');
  const log = fs.openSync(logPath, 'w');
  const electron = spawn(path.join(repoRoot, 'node_modules', '.bin', 'electron'), electronArgs, {
    cwd: repoRoot,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
    detached: true,
    stdio: ['ignore', log, log],
  });
  electron.unref();

  fs.writeFileSync(stateFile, JSON.stringify({ electronPid: electron.pid, serverPid, port, xdg, logPath }, null, 2));

  // Wait for CDP, then the renderer, then get OOBE out of the way.
  const deadline = Date.now() + 30000;
  let cdp = null;
  while (Date.now() < deadline && !cdp) {
    try {
      cdp = await connect(port);
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  if (!cdp) {
    console.error(`FATAL: CDP never came up on :${port} — check ${logPath}`);
    process.exit(1);
  }
  await skipOobe(cdp);
  await seedProviderKeys(cdp);
  cdp.close();

  console.log(`ready: electron pid ${electron.pid}, CDP on :${port}, profile ${xdg}`);
  console.log(`state: ${stateFile}`);
}

/** The scratch profile every QA electron is launched against. */
function xdgProfileDir() {
  return path.join(scratchDir, 'xdg');
}

/**
 * PIDs of processes running against our scratch profile.
 *
 * Deliberately matched on the profile path rather than the electron binary:
 * the developer's own `yarn dev` runs the same binary from the same
 * node_modules, and killing that would be far worse than a leaked child.
 */
function orphanPidsForProfile(profileDir) {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return out.split('\n')
      .filter(line => line.includes(profileDir))
      .map(line => Number(line.trim().split(/\s+/)[0]))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

async function stop() {
  const state = readState();
  // The static server outlives the state file when a run dies badly, and a
  // leaked one is invisible: the next launch finds :5173 occupied, reuses it,
  // and serves a bundle from whenever that server started. So clean it up
  // from its own pidfile too, not only from this run's state.
  const leaked = readServerFile();
  if (!state && !leaked) {
    console.log('nothing to stop (no state file)');
    return;
  }

  const pids = new Set();
  if (state?.electronPid) pids.add(state.electronPid);
  if (state?.serverPid) pids.add(state.serverPid);
  if (leaked?.pid) pids.add(leaked.pid);
  // Electron's children outlive a main process that died badly (a SIGSEGV
  // leaves the gpu/renderer/utility procs holding :9222), and the next launch
  // then fails with "Cannot start http server for devtools" — which reads like
  // a code problem rather than a stale process. Match on the scratch profile
  // path so this can only ever reach QA instances, never a real app.
  for (const pid of orphanPidsForProfile(xdgProfileDir())) pids.add(pid);

  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch { /* already gone */ }
  }

  fs.rmSync(stateFile, { force: true });
  fs.rmSync(serverFile, { force: true });

  // Report honestly rather than assuming the kills landed — a still-occupied
  // port is exactly the condition that produced stale-bundle runs.
  for (const p of RENDERER_PORTS) {
    if (!(await portUp(p))) continue;
    const still = await identifyRendererServer(p);
    if (still.kind === 'harness-static') {
      console.warn(`WARNING: a harness static server is still on :${p} (pid ${still.pid}) — kill it before the next launch.`);
    }
  }
  console.log('stopped');
}

function writeServerFile(pid, dir, port) {
  fs.writeFileSync(serverFile, JSON.stringify({ pid, dir, port, startedAt: Date.now() }, null, 2));
}

function readServerFile() {
  try {
    return JSON.parse(fs.readFileSync(serverFile, 'utf8'));
  } catch {
    return null;
  }
}

// Minimal static file server for dist/renderer (hidden subcommand, runs
// detached so `launch` can exit).
function serve(dir, port) {
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  };
  const startedAt = Date.now();
  http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // Identity probe — lets `launch` tell one of ours apart from a Vite dev
    // server, and tell you how old the bundle it is serving is.
    if (urlPath === '/__harness') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ harness: true, pid: process.pid, dir, startedAt }));
      return;
    }
    let file = path.normalize(path.join(dir, urlPath));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dir, 'index.html'); // SPA fallback
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Only run the CLI when executed directly — the module is also importable
// (`import { connect } from '.../harness.mjs'`) for scripted flows.
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const command = process.argv[2];
  switch (command) {
    case 'launch':
      await launch();
      break;
    case 'stop':
      await stop();
      break;
    case 'eval': {
      const state = readState();
      if (!state) { console.error('not running — `launch` first'); process.exit(1); }
      const cdp = await connect(state.port);
      console.log(JSON.stringify(await cdp.evaljs(process.argv[3]), null, 1));
      cdp.close();
      break;
    }
    case 'screenshot': {
      const state = readState();
      if (!state) { console.error('not running — `launch` first'); process.exit(1); }
      const out = process.argv[3] || path.join(scratchDir, 'screenshot.png');
      const cdp = await connect(state.port);
      console.log(await cdp.screenshot(out));
      cdp.close();
      break;
    }
    case '_serve':
      serve(process.argv[3], Number(process.argv[4]));
      break;
    default:
      console.log('usage: harness.mjs launch [--fresh] [--port N] [--headed] | eval <js> | screenshot [path] | stop');
      process.exit(command ? 1 : 0);
  }
}
