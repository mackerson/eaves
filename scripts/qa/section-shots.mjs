#!/usr/bin/env node
// Screenshot each application section (dark theme) against seeded content,
// for documentation.
//
// Usage:
//   node scripts/qa/harness.mjs launch --fresh   # start the headless app first
//   node scripts/qa/section-shots.mjs            # -> docs/qa/section-shots/*.png
//   node scripts/qa/harness.mjs stop
//
// Output dir defaults to docs/qa/section-shots; override with SHOT_DIR=/path.
//
// Seeds representative content through real IPC (no LLM): agents, a chat with a
// canned exchange, a project, tasks, notes, workflows, routines, project files,
// and a multi-agent #general conversation (humans via sendMessage with no
// @mention => no dispatch; agents via addAgentMessage, a direct insert). Then
// navigates via the actual sidebar/menu UI and screenshots each section.
import { connect } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.SHOT_DIR || path.join(repoRoot, 'docs/qa/section-shots');
fs.mkdirSync(OUT, { recursive: true });
const j = (v) => JSON.stringify(v);

// Seed the Files view from a neutral temp dir rather than the live repo, so the
// captured absolute paths never leak the operator's home dir (e.g. /home/<user>)
// into committed screenshots. Files must exist on disk — files:add stats them.
const DEMO_FILES = {
  'README.md': `# Edge Inference

On-device model runtime for ESP32 and Raspberry Pi targets.

## Overview
Quantized transformer inference tuned for sub-watt power envelopes.
Loads int8 checkpoints and streams tokens over the local bus.

## Targets
- Raspberry Pi 5 (primary)
- ESP32-S3 (experimental)

See \`benchmarks.md\` for throughput and \`model-config.json\` for the
quantization profile.
`,
  'benchmarks.md': `# Benchmarks

Sustained throughput, greedy decode, batch size 1, Pi 5 (8 GB) @ 25C.

| Runtime      | Cold start | Tokens/sec |
|--------------|-----------:|-----------:|
| Edge (ours)  |     380 ms |       42.1 |
| TFLite       |     210 ms |       31.8 |
| ONNX Runtime |     540 ms |       28.4 |

TFLite wins cold-start; we win on sustained throughput.
`,
  'model-config.json': `{
  "model": "edge-tiny-1b",
  "quantization": "int8",
  "context": 4096,
  "targets": ["rpi5", "esp32s3"],
  "runtime": { "threads": 4, "batchSize": 1, "kvCache": true }
}
`,
};
const DEMO_DIR = path.join(os.tmpdir(), 'edge-inference');
fs.mkdirSync(DEMO_DIR, { recursive: true });
const DEMO_PATHS = Object.entries(DEMO_FILES).map(([name, content]) => {
  const p = path.join(DEMO_DIR, name);
  fs.writeFileSync(p, content);
  return p;
});

// Each section: id, and an ordered list of click steps. Step kinds:
//   { section }  -> sidebar '.section-title' (case-insensitive; titles are
//                   CSS-uppercased and Chrome reflects that in innerText)
//   { menu }     -> top-bar '.menu-button' (opens a dropdown)
//   { menuitem } -> a '.menu-item-label' inside the open dropdown
//   { tab }      -> a filter tab button (All/Channels/Chats)
//   { row }      -> a clickable list row (cursor-pointer wrapper) by exact text
//   { open }     -> tightest element containing text, click nearest clickable
const SECTIONS = [
  { id: 'chats',     steps: [{ section: 'Conversations' }, { open: 'Fibonacci walkthrough' }] },
  { id: 'channels',  steps: [{ section: 'Conversations' }, { tab: 'Channels' }, { row: 'general' }] },
  { id: 'agents',    steps: [{ menu: 'Agents' }, { menuitem: 'View All Agents' }] },
  { id: 'projects',  steps: [{ menu: 'Projects' }, { menuitem: 'View All Projects' }] },
  { id: 'tasks',     steps: [{ section: 'Tasks' }] },
  { id: 'notes',     steps: [{ section: 'Notes' }] },
  { id: 'files',     steps: [{ section: 'Files & Folders' }] },
  { id: 'workflows', steps: [{ section: 'Workflows' }] },
  { id: 'routines',  steps: [{ section: 'Routines' }] },
  { id: 'calendar',  steps: [{ section: 'Calendar' }] },
  { id: 'activity',  steps: [{ section: 'Activity' }] },
  { id: 'plugins',   steps: [{ section: 'Plugins' }] },
  { id: 'settings',  steps: [{ menu: 'Options' }, { menuitem: 'Settings' }] },
];

async function main() {
  const cdp = await connect(9222);
  const { evaljs, waitFor, screenshot, close, send } = cdp;

  const setViewport = () => send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await setViewport();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // --- 1. Force dark theme + seed representative content via real IPC ---
  console.log('seeding...');
  const seeded = await evaljs(`(async () => {
    await window.electron.updateSettings({ theme: 'dark' });

    const ada = await window.electron.createAgent({ name: 'Ada', description: 'Pair-programming assistant', provider: 'anthropic', model: 'claude-opus-4-8', color: '#7c8ef0' });
    const scout = await window.electron.createAgent({ name: 'Scout', description: 'Research & web synthesis', provider: 'anthropic', model: 'claude-sonnet-5', color: '#10b981' });
    const archivist = await window.electron.createAgent({ name: 'Archivist', description: 'Long-term memory & notes', provider: 'openai', model: 'gpt-4o', color: '#f59e0b' });

    const chat = await window.electron.createChat({ name: 'Fibonacci walkthrough', agentId: ada.id });
    const chatId = chat.chat.id;
    await window.electron.sendChatMessage({ chatId, content: 'Can you show me a small Fibonacci function in JS and explain how it works?' });
    await window.electron.addChatAgentMessage({ chatId, agentId: ada.id, content: [
      "Sure! Here's a compact iterative version:", "",
      "\\\`\\\`\\\`js", "function fib(n) {", "  let [a, b] = [0, 1];",
      "  for (let i = 0; i < n; i++) [a, b] = [b, a + b];", "  return a;", "}", "\\\`\\\`\\\`", "",
      "A few things worth noting:", "",
      "- **O(n) time, O(1) space** — no recursion stack, no memo table.",
      "- The destructuring swap \\\`[a, b] = [b, a + b]\\\` updates both values *simultaneously*.",
      "- \\\`fib(0)\\\` returns \\\`0\\\` and \\\`fib(10)\\\` returns \\\`55\\\`.", "",
      "Want the memoized recursive form for comparison?",
    ].join('\\n') });
    await window.electron.sendChatMessage({ chatId, content: 'That\\'s perfect, thanks. The simultaneous swap is a nice touch.' });
    await window.electron.addChatAgentMessage({ chatId, agentId: ada.id, content: 'Glad it helped! Happy to dig into the memoized version or Binet\\'s closed-form next.' });

    const project = await window.electron.createProject({ name: 'Edge Inference', description: 'On-device model runtime for ESP32 / Raspberry Pi targets.' });
    const projectId = project.id;

    await window.electron.addTask({ content: 'Wire up quantized model loader', priority: 'high' });
    await window.electron.addTask({ content: 'Benchmark tokens/sec on Pi 5', priority: 'medium' });
    await window.electron.addTask({ content: 'Write teardown docs for the demo rig', priority: 'low' });

    await window.electron.addNote({ title: 'Release checklist', content: 'Sign the build, bump the changelog, tag, and smoke-test the packaged app on a clean profile.' });
    await window.electron.addNote({ title: 'Model notes', content: 'Opus 4.8 handles the long-context planning; Sonnet 5 for the tight research loops.' });

    // Workflows (empty DAG is a valid definition; the list renders by name).
    const emptyDag = { nodes: [], edges: [] };
    await window.electron.createWorkflow({ projectId, name: 'Nightly benchmark sweep', description: 'Run the tokens/sec harness across all target boards and post results.', dagDefinition: emptyDag, enabled: true });
    await window.electron.createWorkflow({ projectId, name: 'Model import + quantize', description: 'Fetch a checkpoint, quantize to int8, and register it with the runtime.', dagDefinition: emptyDag, enabled: false });

    // Routines (cron-scheduled).
    await window.electron.createRoutine({ projectId, name: 'Daily standup digest', description: 'Summarize channel activity each morning.', cronSchedule: '0 9 * * *', enabled: true });
    await window.electron.createRoutine({ projectId, name: 'Weekly benchmark report', description: 'Compile the benchmark sweep into a report.', cronSchedule: '0 8 * * 1', enabled: true });

    // Files — seed neutral demo files (written under the OS temp dir) so the
    // Files view is populated without baking the operator's home path into the
    // screenshot.
    for (const f of ${j(DEMO_PATHS)}) {
      try { await window.electron.addFile(projectId, f); } catch (e) {}
    }

    // Populate #general with a real multi-agent exchange — humans via sendMessage
    // (no @mention => no dispatch), agents via addAgentMessage (direct insert, no LLM).
    const chans = await window.electron.getChannels();
    const general = (chans.channels || []).find(c => c.name === 'general');
    if (general) {
      const gid = general.id;
      await window.electron.sendMessage({ channelId: gid, content: 'Morning all — where are we on the edge-inference demo for Friday?' });
      await window.electron.addAgentMessage({ channelId: gid, agentId: ada.id, content: 'Loader is done — quantized weights load in ~380ms on the Pi 5. Cleaning up the error paths now.' });
      await window.electron.addAgentMessage({ channelId: gid, agentId: scout.id, content: 'Pulled three comparable runtimes for the writeup. TFLite is fastest cold-start; ours wins on sustained throughput.' });
      await window.electron.sendMessage({ channelId: gid, content: 'Nice. Let us lock the numbers before standup.' });
      await window.electron.addAgentMessage({ channelId: gid, agentId: archivist.id, content: 'Logged the decisions and the benchmark table to the project notes for reference.' });
    }

    return { adaId: ada.id, chatId, chatName: 'Fibonacci walkthrough', projectId, generalId: general && general.id };
  })()`);
  console.log('seeded:', j(seeded));

  // --- 2. Reload so the renderer picks up seeded data ---
  await evaljs('location.reload()');
  await setViewport();
  await waitFor(`!!document.body && document.body.innerText.includes('CONVERSATIONS')`, { timeout: 20000 });

  // --- 3. Install click helpers ---
  await evaljs(`(() => {
    window.__click = (sel, text) => {
      // Case-insensitive: section titles render uppercased via CSS text-transform,
      // which Chrome reflects in innerText.
      const want = text.trim().toUpperCase();
      const el = [...document.querySelectorAll(sel)].find(e => (e.innerText || '').trim().toUpperCase() === want);
      if (el) { el.click(); return true; }
      return false;
    };
    // Click a clickable list row (channel/chat rows put onClick on a
    // cursor-pointer wrapper) by exact trimmed text.
    window.__row = (text) => {
      const want = text.trim();
      const el = [...document.querySelectorAll('.cursor-pointer, [role="button"], button, a')]
        .find(e => (e.innerText || '').trim() === want);
      if (el) { el.click(); return true; }
      return false;
    };
    window.__menuItem = (text) => {
      const lbl = [...document.querySelectorAll('.menu-item-label')].find(e => (e.innerText || '').trim() === text);
      if (lbl) { (lbl.closest('button') || lbl).click(); return true; }
      return false;
    };
    window.__open = (text) => {
      const cands = [...document.querySelectorAll('button, [role="button"], .section-item, li, a, div, span')]
        .filter(n => n.innerText && n.innerText.includes(text))
        .sort((a, b) => a.innerText.length - b.innerText.length);
      if (!cands.length) return false;
      // Click the nearest clickable ancestor — list rows (e.g. channels) put the
      // onClick on a wrapper div, not the innermost text node.
      const leaf = cands[0];
      const target = leaf.closest('.cursor-pointer, button, [role="button"], a, .section-item') || leaf;
      target.click();
      return true;
    };
    return true;
  })()`);

  // --- 4. Navigate + screenshot each section ---
  let i = 0;
  for (const sec of SECTIONS) {
    i++;
    for (const step of sec.steps) {
      let expr, ok;
      if (step.section)      expr = `window.__click('.section-title', ${j(step.section)})`;
      else if (step.menu)    expr = `window.__click('.menu-button', ${j(step.menu)})`;
      else if (step.menuitem) expr = `window.__menuItem(${j(step.menuitem)})`;
      else if (step.tab)     expr = `window.__click('button', ${j(step.tab)})`;
      else if (step.row)     expr = `window.__row(${j(step.row)})`;
      else if (step.open)    expr = `window.__open(${j(step.open)})`;
      try {
        ok = await waitFor(expr, { timeout: 6000, interval: 200 });
      } catch (e) {
        ok = false;
      }
      if (!ok) console.log('  ! step failed:', sec.id, j(step));
      await sleep(step.menu ? 300 : 700); // menu open needs the dropdown to mount
    }
    await sleep(1200); // let the view render/settle
    const file = path.join(OUT, String(i).padStart(2, '0') + '-' + sec.id + '.png');
    await screenshot(file);
    console.log('shot', i + '/' + SECTIONS.length, sec.id);
  }

  console.log('\nDone. ' + SECTIONS.length + ' section screenshots in ' + OUT);
  close();
}

main().catch(e => { console.error(e); process.exit(1); });
