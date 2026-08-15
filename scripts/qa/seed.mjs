#!/usr/bin/env node
// Load a seed dataset into a running headless Eaves, through real IPC.
//
// Usage:
//   yarn build:main && yarn build:renderer
//   node scripts/qa/harness.mjs launch --fresh
//   node scripts/qa/seed.mjs [--scenario=demo|minimal]
//   node scripts/qa/harness.mjs screenshot /tmp/shot.png
//   node scripts/qa/harness.mjs stop
//
// Why IPC rather than writing SQL into the file: every row here goes through
// the same handlers the app uses, so the result is a state the application can
// actually reach. A seed that writes directly can invent states the product
// never produces — and then screenshots show impossible UI and tests assert on
// fiction.
//
// The dataset lives in src/main/seed/dataset.ts and is read from dist/main,
// which is why build:main is a prerequisite. That indirection is deliberate:
// it keeps the data typechecked against the real domain types instead of
// drifting as plain JSON.
import { connect } from './harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

const scenario = (process.argv.find(a => a.startsWith('--scenario=')) || '--scenario=demo').split('=')[1];

let datasets;
try {
  ({ datasets } = require(path.join(repoRoot, 'dist/main/main/seed/dataset.js')));
} catch {
  try {
    ({ datasets } = require(path.join(repoRoot, 'dist/main/seed/dataset.js')));
  } catch (err) {
    console.error('Could not load the seed dataset from dist/. Run `yarn build:main` first.');
    console.error(err.message);
    process.exit(1);
  }
}

const data = datasets[scenario];
if (!data) {
  console.error(`Unknown scenario "${scenario}". Known: ${Object.keys(datasets).join(', ')}`);
  process.exit(1);
}

/**
 * The reference time every `at` offset is measured back from.
 *
 * Relative to now on purpose: the UI renders "2 hours ago", and a demo
 * database pinned to a fixed date would age into "7 months ago" and look
 * abandoned. Tests that need a frozen clock should use the in-process loader
 * instead of this one.
 */
const NOW = Date.now();
const minutesAgo = (m) => NOW - m * 60_000;

const j = (v) => JSON.stringify(v);

async function main() {
  const { evaljs, close } = await connect();

  // Anything returned by an IPC handler comes back through the CDP bridge as
  // JSON, so every call is awaited and unwrapped here rather than trusting a
  // fire-and-forget. A seed that half-succeeds is worse than one that fails.
  const call = async (expr, what) => {
    const result = await evaljs(`(async () => { const r = await ${expr}; return r; })()`);
    if (result && result.success === false) {
      throw new Error(`${what} failed: ${result.error ?? 'unknown error'}`);
    }
    return result;
  };

  console.log(`Seeding "${scenario}" …`);

  await call(`window.electron.updateSettings({ userName: ${j(data.userName)} })`, 'updateSettings');

  // ── agents ────────────────────────────────────────────────────────────────
  const agentIds = {};
  for (const a of data.agents) {
    const agent = await call(`window.electron.createAgent({
      name: ${j(a.name)}, description: ${j(a.description)}, provider: ${j(a.provider)},
      model: ${j(a.model)}, color: ${j(a.color)}, systemPrompt: ${j(a.systemPrompt)},
      temperature: 0.7${a.greeting ? `, greeting: ${j(a.greeting)}` : ''}
    })`, `createAgent(${a.name})`);
    agentIds[a.key] = agent.id;
    console.log(`  agent   ${a.name}`);
  }

  // ── projects, tasks, notes ────────────────────────────────────────────────
  const projectIds = {};
  for (const p of data.projects) {
    const project = await call(
      `window.electron.createProject({ name: ${j(p.name)}, description: ${j(p.description)} })`,
      `createProject(${p.name})`,
    );
    projectIds[p.key] = project.id;
    console.log(`  project ${p.name}`);

    for (const t of p.tasks) {
      const due = t.dueInDays !== undefined ? `, dueDate: ${NOW + t.dueInDays * 86_400_000}` : '';
      const task = await call(`window.electron.addTask({
        projectId: ${j(project.id)}, content: ${j(t.content)},
        priority: ${j(t.priority ?? 'medium')}${due}
      })`, 'addTask');
      if (t.completed) {
        await call(`window.electron.updateTask(${j(task.id)}, { completed: true })`, 'updateTask');
      }
    }

    for (const n of p.notes) {
      await call(
        `window.electron.addNote({ projectId: ${j(project.id)}, title: ${j(n.title)}, content: ${j(n.content)} })`,
        'addNote',
      );
    }
    console.log(`          ${p.tasks.length} tasks, ${p.notes.length} notes`);
  }

  // ── 1:1 chats ─────────────────────────────────────────────────────────────
  for (const c of data.chats) {
    const chat = await call(
      `window.electron.createChat({ name: ${j(c.name)}, agentId: ${j(agentIds[c.agent])} })`,
      `createChat(${c.name})`,
    );
    const chatId = chat.chat?.id ?? chat.id;

    for (const m of c.messages) {
      if (m.from === 'user') {
        // send-chat-message persists and returns; it never starts a turn, so
        // no model is called. The transcript is authored, not generated.
        await call(
          `window.electron.sendChatMessage({ chatId: ${j(chatId)}, content: ${j(m.content)} })`,
          'sendChatMessage',
        );
      } else {
        await call(`window.electron.addChatAgentMessage({
          chatId: ${j(chatId)}, agentId: ${j(agentIds[m.from])}, content: ${j(m.content)}
        })`, 'addChatAgentMessage');
      }
    }
    if (c.tags?.length) {
      // Chats store tags as a comma-separated string, unlike channels which
      // take an array. The dataset keeps them as an array either way — the
      // loader adapts, so the data does not have to know the storage shape.
      await call(`window.electron.updateChat(${j(chatId)}, { tags: ${j(c.tags.join(','))} })`, 'updateChat');
    }
    console.log(`  chat    ${c.name} (${c.messages.length} messages)`);
  }

  // ── channels ──────────────────────────────────────────────────────────────
  //
  // Messages are seeded BEFORE the agents join, and that ordering is load
  // bearing. `send-message` always calls requestDispatch, which resolves
  // @mentions against the channel's *current* agent participants — so seeding
  // a line containing "@Wren" while Wren is already in the room starts a real
  // turn against a real provider. The harness seeds live API keys, so that is
  // a billable call and a different transcript on every run.
  //
  // With no agent participants yet there is nothing for a mention to resolve
  // to, and nothing for a respondTo:'all' agent to answer. Adding them
  // afterwards produces exactly the state we want, and is something a user can
  // genuinely do: people get added to rooms that already have history.
  for (const ch of data.channels) {
    const existing = await call('window.electron.getChannels()', 'getChannels');
    const list = existing.channels ?? existing;
    let channelId = list.find(x => x.name === ch.name)?.id;

    if (!channelId) {
      const created = await call(
        `window.electron.createChannel({ name: ${j(ch.name)}, type: 'public' })`,
        `createChannel(${ch.name})`,
      );
      channelId = created.channel?.id ?? created.id;
    }

    // The precondition that makes dispatch impossible, asserted rather than
    // assumed. getChannels always hydrates participants (it does not hydrate
    // messages, which is why this checks the cause and not the symptom).
    const fresh = await call('window.electron.getChannels()', 'getChannels');
    const target = (fresh.channels ?? fresh).find(x => x.id === channelId);
    const agentsPresent = (target?.participants ?? []).filter(p => p.type === 'agent');
    if (agentsPresent.length > 0) {
      throw new Error(
        `#${ch.name} already has ${agentsPresent.length} agent participant(s) before seeding. ` +
        `A seeded @mention would resolve and start a real, billable turn. Relaunch with ` +
        `--fresh, or seed messages before anyone joins.`,
      );
    }

    for (const m of ch.messages) {
      if (m.from === 'user') {
        await call(
          `window.electron.sendMessage({ channelId: ${j(channelId)}, content: ${j(m.content)} })`,
          'sendMessage',
        );
      } else {
        // Direct insert. No turn, no provider, no cost.
        await call(`window.electron.addAgentMessage({
          channelId: ${j(channelId)}, agentId: ${j(agentIds[m.from])}, content: ${j(m.content)}
        })`, 'addAgentMessage');
      }
    }

    for (const key of ch.agents) {
      await call(
        `window.electron.addChannelParticipant({ channelId: ${j(channelId)}, participantId: ${j(agentIds[key])} })`,
        'addChannelParticipant',
      );
    }
    console.log(`  channel #${ch.name} (${ch.messages.length} messages, ${ch.agents.length} agents joined after)`);
  }

  // ── workflows and routines ────────────────────────────────────────────────
  const workflowIds = {};
  for (const w of data.workflows) {
    // `data` is required by WorkflowNodeSchema and is where the editor keeps a
    // node's label and per-type config. The seed gives each node a label and
    // nothing else — anything more would be inventing configuration the
    // dataset has no opinion about.
    const nodes = w.nodes.map((type, i) => ({
      id: `n${i}`, type, position: { x: 120 + i * 190, y: 160 }, data: { label: type },
    }));
    const edges = nodes.slice(0, -1).map((n, i) => ({ id: `e${i}`, source: n.id, target: nodes[i + 1].id }));
    const wf = await call(`window.electron.createWorkflow({
      projectId: ${j(projectIds[w.project])}, name: ${j(w.name)}, description: ${j(w.description)},
      dagDefinition: ${JSON.stringify({ nodes, edges })}
    })`, `createWorkflow(${w.name})`);
    workflowIds[w.key] = wf.workflow?.id ?? wf.id;
    console.log(`  workflow ${w.name}`);
  }

  for (const r of data.routines) {
    const wf = r.workflow ? `, workflowId: ${j(workflowIds[r.workflow])}` : '';
    await call(`window.electron.createRoutine({
      projectId: ${j(projectIds[r.project])}, name: ${j(r.name)},
      description: ${j(r.description)}, cronSchedule: ${j(r.cron)}${wf}
    })`, `createRoutine(${r.name})`);
    console.log(`  routine ${r.name}`);
  }

  // ── agent memory ──────────────────────────────────────────────────────────
  for (const m of data.memories) {
    await call(`window.electron.memoryBlockSet({
      agentId: ${j(agentIds[m.agent])}, label: ${j(m.label)}, value: ${j(m.value)}
    })`, 'memoryBlockSet');
    console.log(`  memory  ${m.agent}/${m.label}`);
  }

  // Most of what was just written arrives through handlers the renderer has no
  // live subscription to, so a window opened before seeding still shows an
  // empty workspace. Reload so the app is left displaying its own data — a
  // screenshot taken straight after seeding is otherwise of nothing.
  await evaljs('location.reload()');
  await new Promise(r => setTimeout(r, 3000));

  console.log(`\nSeeded "${scenario}". Reference time: ${new Date(NOW).toISOString()}`);
  console.log('The window has been reloaded and is showing the seeded workspace.');
  await close();
}

main().catch((err) => {
  console.error('\nSeeding failed:', err.message);
  console.error('The profile is left as-is so you can inspect it; re-launch with --fresh to start over.');
  process.exit(1);
});
