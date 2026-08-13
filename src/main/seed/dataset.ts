/**
 * Seed data for demos, screenshots and tests.
 *
 * This is data, not code that writes data — the loaders in `./scenarios.ts`
 * and `scripts/qa/seed.mjs` decide how it reaches a database. Keeping the two
 * apart is what lets the same dataset serve a screenshot run (driven through
 * real IPC against a live app) and, later, an in-process test fixture.
 *
 * Three rules this file lives by:
 *
 * 1. **Everything is invented.** These conversations end up in screenshots on
 *    a public README. No real person, project, path, host or key appears here,
 *    and nothing is lifted from a real database. If you need realism, write
 *    something plausible rather than importing something true.
 *
 * 2. **Nothing is random.** Ids are fixed and timestamps are expressed as
 *    offsets, never `Date.now()`. A screenshot that differs between two runs
 *    of unchanged code cannot be reviewed — you stop being able to tell a real
 *    visual regression from noise.
 *
 * 3. **It is typed against the real domain types.** When a contract changes,
 *    this file fails `yarn typecheck` — at the same moment the app does, not
 *    the next time somebody runs a demo.
 */

import type { ProviderId } from '../../shared/providers';

/** Minutes before the scenario's reference time. Never an absolute date. */
export type MinutesAgo = number;

export interface SeedAgent {
  key: string;
  name: string;
  description: string;
  provider: ProviderId;
  model: string;
  color: string;
  systemPrompt: string;
  greeting?: string;
}

export interface SeedMessage {
  /** `user`, or an agent key from `agents`. */
  from: 'user' | string;
  content: string;
  at: MinutesAgo;
}

export interface SeedChat {
  key: string;
  name: string;
  agent: string;
  tags?: string[];
  messages: SeedMessage[];
}

export interface SeedChannel {
  key: string;
  name: string;
  project?: string;
  agents: string[];
  messages: SeedMessage[];
}

export interface SeedProject {
  key: string;
  name: string;
  description: string;
  tasks: Array<{ content: string; completed?: boolean; priority?: 'low' | 'medium' | 'high'; dueInDays?: number }>;
  notes: Array<{ title: string; content: string }>;
}

export interface SeedWorkflow {
  key: string;
  project: string;
  name: string;
  description: string;
  /** Node types only — the loader lays them out; exact geometry is not data. */
  nodes: string[];
}

export interface SeedRoutine {
  key: string;
  project: string;
  name: string;
  description: string;
  cron: string;
  workflow?: string;
}

export interface SeedMemory {
  agent: string;
  label: string;
  value: string;
}

export interface Dataset {
  userName: string;
  agents: SeedAgent[];
  projects: SeedProject[];
  chats: SeedChat[];
  channels: SeedChannel[];
  workflows: SeedWorkflow[];
  routines: SeedRoutine[];
  memories: SeedMemory[];
}

/**
 * The demo dataset: a fictional edge-inference project.
 *
 * The domain matches the one `section-shots.mjs` already used, so screenshots
 * taken before and after this file are recognisably the same product. It is
 * chosen to be legible to a stranger in a screenshot — hardware and model
 * names people recognise, no in-jokes, no jargon that needs a footnote.
 */
export const demoDataset: Dataset = {
  userName: 'Alex',

  agents: [
    {
      key: 'atlas',
      name: 'Atlas',
      description: 'Research and synthesis. Reads long things so you do not have to.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      color: '#6366f1',
      systemPrompt:
        'You are Atlas. You research thoroughly and summarize honestly, including what you could not find out. You say when a source is weak.',
      greeting: 'What are we looking into?',
    },
    {
      key: 'wren',
      name: 'Wren',
      description: 'Embedded and firmware. Lives in the datasheet.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      color: '#10b981',
      systemPrompt:
        'You are Wren. You work on embedded systems: power budgets, memory constraints, and the difference between the datasheet and the silicon. You give numbers, not adjectives.',
    },
    {
      key: 'juno',
      name: 'Juno',
      description: 'Runs the schedule. Nags politely.',
      provider: 'openai',
      model: 'gpt-4o',
      color: '#f59e0b',
      systemPrompt:
        'You are Juno. You track what is due, what is blocked, and what has quietly stopped moving. You are brief.',
    },
    {
      key: 'pike',
      name: 'Pike',
      description: 'Local model. Offline, private, and never sends a token anywhere.',
      provider: 'ollama',
      model: 'llama3.1:8b',
      color: '#a855f7',
      systemPrompt: 'You are Pike, running locally. You are useful without a network connection.',
    },
  ],

  projects: [
    {
      key: 'tidepool',
      name: 'Tidepool',
      description: 'On-device model runtime for low-power boards. Sub-watt inference, streamed over the local bus.',
      tasks: [
        { content: 'Quantize the encoder to int8 and measure the accuracy drop', completed: true, priority: 'high' },
        { content: 'Bring up the ESP32-S3 target — currently OOMs on the second layer', priority: 'high', dueInDays: 2 },
        { content: 'Power profile: find where the 40mW baseline is going', priority: 'medium', dueInDays: 5 },
        { content: 'Write the streaming protocol spec before anyone implements it twice', priority: 'medium', dueInDays: 9 },
        { content: 'Decide whether the Pi 5 stays the primary target', priority: 'low' },
      ],
      notes: [
        {
          title: 'Why int8 and not int4',
          content:
            'int4 halves the weights again but the encoder loses about 6 points on our eval set, and the dequant cost eats most of the bandwidth win on the S3. Revisit if we get a board with more SRAM.',
        },
        {
          title: 'Power budget, measured',
          content:
            'Idle 40mW, inference peak 780mW, average over a 12-token response 310mW. The 40mW floor is suspicious — nothing should be drawing that with the radio off.',
        },
      ],
    },
  ],

  chats: [
    {
      key: 'esp32-oom',
      name: 'ESP32 memory ceiling',
      agent: 'wren',
      tags: ['tidepool', 'firmware'],
      messages: [
        { from: 'user', content: 'The S3 dies partway through layer two. Is this just not going to fit?', at: 320 },
        {
          from: 'wren',
          content:
            'It fits, but not the way it is being loaded. The S3 has 512KB of SRAM and you are holding the full activation buffer plus both weight tiles at once — about 610KB at peak.\n\nTwo options:\n\n1. **Stream the weight tiles** from flash per layer. Costs roughly 8ms per layer in transfer, and you get the peak down to ~180KB.\n2. **Halve the activation buffer** by processing the sequence in two passes. Cheaper in memory, but you pay for it in latency on longer inputs.\n\nI would take the first. Flash reads are predictable; the second option makes latency depend on input length, which will be miserable to reason about later.',
          at: 318,
        },
        { from: 'user', content: 'What does the 8ms do to the token rate?', at: 314 },
        {
          from: 'wren',
          content:
            'At 12 layers that is 96ms of transfer per forward pass, against a current pass time of about 340ms. So roughly 4.3 tokens/sec down to 3.3.\n\nWorth noting the transfer overlaps with compute if you double-buffer — you would get most of that back, at the cost of one extra tile in memory. That still lands well under the ceiling.',
          at: 313,
        },
      ],
    },
    {
      key: 'offline',
      name: 'Working on the train',
      agent: 'pike',
      tags: ['offline'],
      messages: [
        { from: 'user', content: 'No signal for the next two hours. Can you still help me think through the protocol spec?', at: 1450 },
        {
          from: 'pike',
          content:
            'Yes — I run entirely on this machine, so the network makes no difference to me.\n\nStart with the framing question: is a response a stream of tokens, or a stream of *events* that happen to include tokens? The second is more work now and saves you a rewrite the first time you need to send anything that is not a token — a tool call, a stop reason, a power warning from the board.',
          at: 1449,
        },
      ],
    },
    {
      key: 'weekly',
      name: 'Where did last week go',
      agent: 'juno',
      messages: [
        { from: 'user', content: 'Honest assessment. What moved and what did not?', at: 60 },
        {
          from: 'juno',
          content:
            'Moved: quantization is done and measured. The accuracy drop is documented rather than assumed, which is more than the last two attempts managed.\n\nDid not move: the streaming protocol spec has been "next" for eleven days. Nothing is blocked on it yet, which is exactly why it keeps sliding — and it is the one item where two people implementing it separately costs you a week.\n\nThe power profiling task has no owner and a date in three days.',
          at: 59,
        },
      ],
    },
  ],

  channels: [
    {
      // Deliberately not #general: creating an agent auto-joins it
      // (ipc/agents.ts), so it always has agent participants and any seeded
      // @mention there would resolve and start a real turn. A dedicated room
      // can be populated before anyone joins, and it leaves #general as the
      // empty default a new user actually sees.
      key: 'tidepool-room',
      name: 'tidepool',
      project: 'tidepool',
      agents: ['atlas', 'wren', 'juno'],
      messages: [
        { from: 'user', content: 'Kicking off the power profiling work. @Wren where would you look first?', at: 240 },
        {
          from: 'wren',
          content:
            'The 40mW idle floor, before anything else. Inference power is roughly what the model size predicts, so there is little to win there — but 40mW with the radio off means something is not sleeping. My guess is the UART is held open by the logging path.\n\nCheap test: build with logging compiled out and measure again. If the floor drops, we know.',
          at: 238,
        },
        {
          from: 'atlas',
          content:
            'Worth adding that the two published runtimes in this space both report idle figures with peripherals fully gated, which is not a like-for-like comparison with ours. If we quote a number publicly we should say which peripherals were live.',
          at: 236,
        },
        { from: 'user', content: 'Good catch. @Juno can you get that on the board with an owner?', at: 234 },
        {
          from: 'juno',
          content:
            'Added, owner unset — someone needs to claim it. Due in five days, which is tight against the S3 work already in flight.',
          at: 233,
        },
      ],
    },
  ],

  workflows: [
    {
      key: 'nightly-eval',
      project: 'tidepool',
      name: 'Nightly eval sweep',
      description: 'Run the eval set against the current checkpoint and summarize any regression.',
      nodes: ['start', 'code', 'agent', 'conditional', 'end'],
    },
  ],

  routines: [
    {
      key: 'nightly',
      project: 'tidepool',
      name: 'Nightly eval',
      description: 'Runs the eval sweep and posts a summary if anything regressed.',
      cron: '0 3 * * *',
      workflow: 'nightly-eval',
    },
  ],

  memories: [
    {
      agent: 'wren',
      label: 'targets',
      value:
        'Primary target is the Pi 5. ESP32-S3 is experimental and memory-bound at 512KB SRAM. Power budget: under 1W peak, idle should be under 10mW.',
    },
    {
      agent: 'juno',
      label: 'cadence',
      value: 'Alex reviews the board on Mondays. Prefers being told what has stopped moving over what is on track.',
    },
  ],
};

/**
 * The smallest dataset that still exercises more than one of anything.
 *
 * Tests want speed and legibility, not a plausible workspace — a failure
 * should point at one row you can hold in your head, and a test that seeds the
 * full demo pays for content it never asserts on.
 */
export const minimalDataset: Dataset = {
  userName: 'Alex',
  agents: [demoDataset.agents[0], demoDataset.agents[1]],
  projects: [
    {
      key: 'tidepool',
      name: 'Tidepool',
      description: 'On-device model runtime.',
      tasks: [{ content: 'Measure the idle power floor', priority: 'high' }],
      notes: [{ title: 'Power budget', content: 'Idle 40mW, peak 780mW.' }],
    },
  ],
  chats: [
    {
      key: 'first',
      name: 'First conversation',
      agent: 'atlas',
      messages: [
        { from: 'user', content: 'What is the idle draw?', at: 10 },
        { from: 'atlas', content: 'About 40mW with the radio off, which is higher than it should be.', at: 9 },
      ],
    },
  ],
  channels: [
    {
      key: 'room',
      name: 'tidepool',
      agents: ['atlas', 'wren'],
      messages: [{ from: 'user', content: 'Morning both.', at: 5 }],
    },
  ],
  workflows: [],
  routines: [],
  memories: [],
};

export const datasets = {
  demo: demoDataset,
  minimal: minimalDataset,
} as const;

export type ScenarioName = keyof typeof datasets;
