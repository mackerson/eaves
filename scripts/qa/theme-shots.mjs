#!/usr/bin/env node
// Screenshot every bundled theme against a seeded mock chat.
//
// Usage:
//   node scripts/qa/harness.mjs launch --fresh   # start the headless app first
//   node scripts/qa/theme-shots.mjs              # -> docs/qa/theme-shots/*.png
//   node scripts/qa/harness.mjs stop
//
// Output dir defaults to docs/qa/theme-shots; override with SHOT_DIR=/path.
//
// How it works: seeds a chat with a canned exchange via real IPC (no LLM),
// then switches themes in-page (every bundled theme is a static [data-theme]
// block) and recomputes the shadcn tokens exactly as applyShadcnTokens does,
// reading each palette back from the computed CSS vars. One screenshot each.
import { connect } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.SHOT_DIR || path.join(repoRoot, 'docs/qa/theme-shots');
fs.mkdirSync(OUT, { recursive: true });

// (id, isDark) pairs in themes.ts order.
const THEMES = [
  ['dark', 1], ['light', 0], ['oled', 1], ['high-contrast', 1],
  ['dracula', 1], ['nord', 1], ['solarized-dark', 1], ['solarized-light', 0], ['monokai', 1], ['one-dark', 1],
  ['ocean', 1], ['forest', 1], ['desert', 0], ['sunset', 1], ['arctic', 0], ['midnight', 1],
  ['rose', 0], ['lavender', 0], ['mint', 0], ['peach', 0],
  ['neon', 1], ['cyberpunk', 1], ['synthwave', 1], ['bubblegum', 0],
  ['corporate', 0], ['minimal', 0], ['paper', 0], ['slate', 1],
  ['terminal', 1], ['sepia', 0], ['coffee', 1], ['berry', 1],
];

const j = (v) => JSON.stringify(v);

async function main() {
  const cdp = await connect(9222);
  const { evaljs, waitFor, screenshot, close, send } = cdp;

  // Widen the viewport so the 3-column layout (sidebar + conversation list +
  // chat pane) fits and the seeded messages are actually on-screen.
  const setViewport = () => send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await setViewport();

  // --- 1. Seed a mock conversation entirely through real IPC (no LLM) ---
  console.log('seeding mock chat...');
  const seeded = await evaljs(`(async () => {
    const agent = await window.electron.createAgent({
      name: 'Ada', description: 'Pair-programming assistant',
      provider: 'anthropic', model: 'claude-opus-4-8', color: '#7c8ef0',
    });
    const chat = await window.electron.createChat({ name: 'Theme Preview', agentId: agent.id });
    const chatId = chat.chat.id;
    await window.electron.sendChatMessage({ chatId, content: 'Can you show me a small Fibonacci function in JS and explain how it works?' });
    await window.electron.addChatAgentMessage({ chatId, agentId: agent.id, content: [
      "Sure! Here's a compact iterative version:",
      "",
      "\\\`\\\`\\\`js",
      "function fib(n) {",
      "  let [a, b] = [0, 1];",
      "  for (let i = 0; i < n; i++) [a, b] = [b, a + b];",
      "  return a;",
      "}",
      "\\\`\\\`\\\`",
      "",
      "A few things worth noting:",
      "",
      "- **O(n) time, O(1) space** — no recursion stack, no memo table.",
      "- The destructuring swap \\\`[a, b] = [b, a + b]\\\` updates both values *simultaneously*, so there's no temp variable.",
      "- \\\`fib(0)\\\` returns \\\`0\\\` and \\\`fib(10)\\\` returns \\\`55\\\`.",
      "",
      "Want the memoized recursive form for comparison?",
    ].join('\\n') });
    await window.electron.sendChatMessage({ chatId, content: 'That\\'s perfect, thanks. The simultaneous swap is a nice touch.' });
    await window.electron.addChatAgentMessage({ chatId, agentId: agent.id, content: 'Glad it helped! Happy to dig into the memoized version or Binet\\'s closed-form next.' });
    return { agentId: agent.id, chatId, name: 'Theme Preview' };
  })()`);
  console.log('seeded:', j(seeded));

  // --- 2. Reload so the renderer picks up the seeded chat, then select it ---
  await evaljs('location.reload()');
  await setViewport(); // reassert after navigation
  await waitFor(`!!document.body && document.body.innerText.includes('CONVERSATIONS')`, { timeout: 20000 });

  // Click the seeded chat by its label text (sidebar or conversation list).
  const clicked = await waitFor(`(() => {
    if (!document.body) return false;
    const target = ${j(seeded.name)};
    // Tightest element whose text contains the chat name — the row/name node.
    // Click bubbles to the list row's onSwitch handler.
    const cands = [...document.querySelectorAll('button, [role="button"], .section-item, li, a, div, span')]
      .filter(n => n.innerText && n.innerText.includes(target))
      .sort((a, b) => a.innerText.length - b.innerText.length);
    if (cands.length) { cands[0].click(); return true; }
    return false;
  })()`, { timeout: 15000 });
  console.log('chat selected:', clicked);

  // Wait for the assistant reply text to actually render in the pane.
  await waitFor(`!!document.body && document.body.innerText.includes('iterative version')`, { timeout: 15000 });

  // --- 3. Install an in-page theme applier mirroring ThemeContext + applyShadcnTokens ---
  await evaljs(`(() => {
    function hexToHslTriplet(color) {
      if (!color) return null;
      const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
      if (!m) return null;
      let r, g, b;
      if (m[1].length === 3) { r=parseInt(m[1][0]+m[1][0],16); g=parseInt(m[1][1]+m[1][1],16); b=parseInt(m[1][2]+m[1][2],16); }
      else { r=parseInt(m[1].slice(0,2),16); g=parseInt(m[1].slice(2,4),16); b=parseInt(m[1].slice(4,6),16); }
      r/=255; g/=255; b/=255;
      const max=Math.max(r,g,b), min=Math.min(r,g,b), l=(max+min)/2;
      let h=0,s=0;
      if (max!==min){ const d=max-min; s=l>0.5?d/(2-max-min):d/(max+min);
        switch(max){ case r: h=((g-b)/d+(g<b?6:0))/6; break; case g: h=((b-r)/d+2)/6; break; default: h=((r-g)/d+4)/6; } }
      const round=n=>Math.round(n*10)/10;
      return round(h*360)+' '+round(s*100)+'% '+round(l*100)+'%';
    }
    function contrastForeground(bgHex){
      if(!bgHex) return null;
      const m=/^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(bgHex.trim()); if(!m) return null;
      const hex=m[1].length===3?m[1].split('').map(c=>c+c).join(''):m[1];
      const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
      return ((r*299+g*587+b*114)/1000)>=150?'240 6% 10%':'0 0% 98%';
    }
    const SHADCN=['--background','--foreground','--card','--card-foreground','--popover','--popover-foreground','--primary','--primary-foreground','--secondary','--secondary-foreground','--muted','--muted-foreground','--accent','--accent-foreground','--destructive','--destructive-foreground','--border','--input','--ring'];
    window.__applyTheme = (id, isDark) => {
      const root = document.documentElement;
      root.setAttribute('data-theme', id);
      [...root.classList].forEach(c => { if (c.startsWith('theme-')) root.classList.remove(c); });
      root.classList.remove('light','dark');
      root.classList.add('theme-'+id, isDark ? 'dark' : 'light');
      const cs = getComputedStyle(root);
      const v = n => cs.getPropertyValue(n).trim();
      const err = v('--status-error') || '#ef4444';
      const vals = {
        '--background': hexToHslTriplet(v('--bg-primary')),
        '--foreground': hexToHslTriplet(v('--text-primary')),
        '--card': hexToHslTriplet(v('--bg-secondary')),
        '--card-foreground': hexToHslTriplet(v('--text-primary')),
        '--popover': hexToHslTriplet(v('--bg-modal')),
        '--popover-foreground': hexToHslTriplet(v('--text-primary')),
        '--primary': hexToHslTriplet(v('--accent-primary')),
        '--primary-foreground': contrastForeground(v('--accent-primary')),
        '--secondary': hexToHslTriplet(v('--bg-tertiary')),
        '--secondary-foreground': hexToHslTriplet(v('--text-primary')),
        '--muted': hexToHslTriplet(v('--bg-tertiary')),
        '--muted-foreground': hexToHslTriplet(v('--text-secondary')),
        '--accent': hexToHslTriplet(v('--bg-hover')),
        '--accent-foreground': hexToHslTriplet(v('--text-primary')),
        '--destructive': hexToHslTriplet(err),
        '--destructive-foreground': contrastForeground(err),
        '--border': hexToHslTriplet(v('--border-primary')),
        '--input': hexToHslTriplet(v('--border-primary')),
        '--ring': hexToHslTriplet(v('--accent-primary')),
      };
      for (const t of SHADCN) { const val = vals[t]; if (val) root.style.setProperty(t, val); else root.style.removeProperty(t); }
      return id;
    };
    return true;
  })()`);

  // --- 4. Loop themes: apply, settle, screenshot ---
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let i = 0;
  for (const [id, isDark] of THEMES) {
    i++;
    await evaljs(`window.__applyTheme(${j(id)}, ${isDark ? 'true' : 'false'})`);
    await sleep(450); // let CSS color transitions settle
    const file = path.join(OUT, String(i).padStart(2, '0') + '-' + id + '.png');
    await screenshot(file);
    console.log('shot', i + '/' + THEMES.length, id);
  }

  console.log('\nDone. ' + THEMES.length + ' screenshots in ' + OUT);
  close();
}

main().catch(e => { console.error(e); process.exit(1); });
