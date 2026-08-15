/**
 * Reference material about Eaves itself, served on demand by the
 * `eaves_guide` tool.
 *
 * No model has this application in its weights, and nothing else tells an agent
 * what a project, channel, routine or workflow is here. `list_tools` /
 * `get_tool_info` cover an agent's own capabilities; this covers the product
 * they sit inside, so an agent can answer "how do I…" and drive the app on the
 * user's behalf instead of guessing from the name.
 *
 * Same economics as toolDocs.ts: this is deliberately NOT on the wire. A tool
 * description is resent on every step of every turn whether or not the tool is
 * ever called, so the description stays one line and the content is fetched
 * only when a user actually asks. Baking this into a system prompt instead
 * would have charged every agent for it on every turn, forever, and would have
 * left agents created after first-run knowing nothing.
 *
 * Keep it accurate. A confidently wrong tour is worse than no tour: the user
 * cannot tell the difference and will go looking for a menu that isn't there.
 */

export interface GuideTopic {
  /** Stable id — the `topic` argument callers pass. */
  id: string;
  /** One line, shown in the topic index. */
  summary: string;
  body: string;
}

export const EAVES_GUIDE_TOPICS: GuideTopic[] = [
  {
    id: 'approvals',
    summary: 'Why some tool calls stop and wait for a person, and what to do while they do.',
    body: `Some tools do not run the moment you call them. Anything that can change the user's machine — \`write_file\`, \`edit_file\`, \`bash\`, \`execute_code\` — pauses and asks the person first.

**What you will see.** The turn ends without a result for that call. In a later turn you get either the tool's real result, or a note saying the call is still waiting. Neither is an error, and neither means anything was lost.

**What to do.** Nothing, mostly:

- **Do not repeat the call.** If it was approved and ran, calling again does it twice. This is the expensive mistake.
- **Do not go looking for evidence** that it ran — reading the file back, listing the directory, checking for side effects. The answer arrives on its own, and probing wastes a turn to learn nothing.
- **Do carry on** with anything that does not depend on it.
- **Do say what you are waiting on** if everything else is blocked. The person may not realise a decision is sitting in front of them.

**Several at once.** If you make several gated calls in one turn, each is decided separately. The person may approve one and leave the others, so you can get one real result while its siblings are still pending. That is normal — it is a queue, not a failure.

**Why this exists.** The gate is the user's control over their own machine, and it is deliberate. An agent that treats a pending approval as a fault, and works around it, is routing around the one place a person gets to say no.`,
  },
  {
    id: 'overview',
    summary: 'What Eaves is and how its main surfaces fit together.',
    body: `Eaves is a local-first desktop application for working with AI agents. Everything — conversations, agents, notes, tasks, memory — is stored in a SQLite database on the user's own machine. Nothing is sent anywhere except the model provider calls the user configured.

The main surfaces, all reachable from the left sidebar:

- **Chats** — 1:1 conversations between the user and one agent.
- **Channels** — IRC-style rooms where several people and agents talk together.
- **Agents** — create and edit the agents themselves.
- **Projects** — the scope everything else hangs off. Tasks, notes, events, workflows and routines all belong to a project.
- **Tasks**, **Notes**, **Calendar**, **Files** — per-project working material.
- **Memory** — durable facts an agent can store and search across conversations.
- **Workflows** — multi-step graphs the app can run.
- **Routines** — scheduled work, on a cron expression.
- **Plugins** — sandboxed extensions.
- **Activity** — a log of what has been happening.
- **Settings** — providers and API keys, defaults, appearance, backups, updates.

An agent is not confined to the conversation it is in: with tools it can create notes and tasks, read and write files in the project directory, search memory, post to other channels, and build workflows and routines.`,
  },
  {
    id: 'getting-started',
    summary: 'A suggested first hour for someone who has just finished setup.',
    body: `A reasonable order for a new user, roughly in order of payoff:

1. **Say what they are here to do.** Their answer decides everything below; don't run through this list mechanically.
2. **Set up a project.** Projects scope tasks, notes, files, workflows and routines. Working in the default project is fine, but a real one — with a workspace directory — is where file tools become useful.
3. **Capture something real.** A few tasks or a note in the project, created for them via tools, so they see the app fill with their own material rather than a demo.
4. **Show memory.** Store a fact or two about how they work. It survives across conversations and is what makes later sessions feel continuous.
5. **Point at channels** if more than one agent would help, or if they want agents talking to each other.
6. **Mention routines and workflows** only if they described something repetitive. They are the strongest features but the wrong place to start cold.
7. **Settings worth knowing early:** adding more providers, and where backups live.

Do this conversationally, a step at a time, and check what they want next rather than delivering the whole list at once. Use the tools — creating the note is worth more than describing how to create a note.`,
  },
  {
    id: 'chats',
    summary: 'One-to-one conversations with a single agent.',
    body: `A chat is a private conversation between the user and one agent. New chats are started from the Chats section in the sidebar.

- Chats can be **tagged** and **archived**. Titles and tags are generated automatically from the conversation.
- Individual agent messages can be **regenerated**, producing alternative branches the user can swipe between; the chosen branch is the one that continues.
- Files and images can be attached to a message.
- Which tools an agent may use is adjustable per chat.
- A second agent can be brought into a chat.

Chats and channels share one storage substrate — a chat is a two-participant direct channel — so the difference is presentation, not a separate world.`,
  },
  {
    id: 'channels',
    summary: 'Multi-participant rooms where agents can address each other.',
    body: `A channel holds several participants — any mix of people and agents — and is scoped to a project.

- **@mentions** dispatch a response. Writing \`@Atlas\` in a channel prompts that agent to reply.
- Each agent has a **channel behavior**: it responds either to mentions only (the default) or to every message, at brief, normal or verbose length. An agent can read and change its own settings with \`get_my_channel_behavior\` and \`update_my_channel_behavior\`.
- Agents see channel history rewritten from their own point of view, with other speakers prefixed by name, so they can follow and answer each other.
- Reply chains are depth-limited and rate-limited so two agents cannot mention each other into an infinite loop.

Agents also have channel tools: \`channel_list\`, \`channel_create\`, \`channel_invite\`, \`channel_history\`, and \`channel_send_message\` for posting to a *different* channel than the current one.`,
  },
  {
    id: 'agents',
    summary: 'What an agent is made of and how to create or change one.',
    body: `An agent is a named configuration: a system prompt, a provider and model, a temperature, a colour, and a set of enabled tools. They are managed in the Agents section.

Fields worth knowing:

- **System prompt** — the agent's identity and instructions. This is the main lever.
- **Description** — a one-liner, used in listings and pickers.
- **Greeting** — an optional first message posted automatically when a new chat with the agent is created.
- **Provider / model** — which service and model the agent runs on; different agents can use different providers.
- **Temperature** — lower is more focused, higher more varied.
- **Channel behavior** — see the channels topic.

Two settings under Settings → Defaults point at agents: the **default agent** for new conversations, and the **system agent** used for background work like generating chat titles. Both start out pointing at the agent created during first-run setup.

There is no limit on how many agents exist, and creating a second one specialised for a specific job is usually better than overloading the first.`,
  },
  {
    id: 'projects',
    summary: 'The scope that tasks, notes, files, workflows and routines belong to.',
    body: `A project is the unit of scope. Tasks, notes, calendar events, workflows and routines all belong to exactly one project, and switching projects switches all of them.

Each project gets a **workspace directory** on disk. File tools — reading, writing, editing, globbing, grepping — operate relative to that directory, so a project is also where an agent's file work lands. A project can additionally be pointed at existing directories elsewhere on the machine.

Channels are project-scoped too. Chats are not.

Because scope follows the *conversation*, an agent working in a channel files its notes and tasks against that channel's project, not whichever project happens to be selected on screen.`,
  },
  {
    id: 'tasks-and-notes',
    summary: 'Per-project task lists and notes, both writable by agents.',
    body: `**Tasks** are a simple checklist per project: title, done or not. Agents can list, add, toggle and delete them (\`list_tasks\`, \`add_task\`, \`toggle_task\`, \`delete_task\`).

**Notes** are free-form text with a title, colour, pin state and labels. Agents can list, add and delete them (\`list_notes\`, \`add_note\`, \`delete_note\`). Labels are per-project.

Both are ordinary UI surfaces as well — the user can work with them directly, and anything an agent creates shows up there immediately.

The **Calendar** holds project events with start and end times.`,
  },
  {
    id: 'memory',
    summary: 'Durable facts that persist across conversations.',
    body: `Memory is key/value storage that outlives any single conversation, browsable under Memory in the sidebar.

Agent tools: \`store_memory\`, \`retrieve_memory\` (exact key), \`search_memories\` (by relevance, preferred), \`list_memories\` (keys, optionally filtered), \`delete_memory\`.

Search is hybrid: full-text always, plus semantic vector search when the vector extension is available. Prefer \`search_memories\` over listing everything.

A memory backend ships with the app and works out of the box; a plugin can replace it with a different store.

Memory is what makes a later session feel like a continuation rather than a restart, so it is worth showing a new user early — store something true about how they work, then retrieve it.`,
  },
  {
    id: 'workflows',
    summary: 'Multi-step graphs the app can execute.',
    body: `A workflow is a directed graph of steps, built either in the visual editor under Workflows or by an agent calling \`create_workflow\`.

Node types include: start and end, action, HTTP request, conditional branch, code (a script run in a subprocess), agent (hand a step to an agent), loop, delay, and break. Outputs of earlier nodes can be referenced from later ones.

Workflows can be triggered by hand or run on a schedule by a routine.

There is a **review gate**: when enabled in Settings, a newly created or modified workflow must be approved by the user before it will run. A routine that fires against a workflow still pending review is blocked and surfaces a warning rather than executing.

An agent asked to "do this every week" usually wants a routine, and a routine usually wants a workflow. Build the workflow first.`,
  },
  {
    id: 'routines',
    summary: 'Work on a schedule, defined by a cron expression.',
    body: `A routine runs something on a schedule, using standard cron syntax: \`minute hour dayOfMonth month dayOfWeek\`.

Examples: \`0 9 * * *\` daily at 9am, \`0 9 * * 1-5\` weekdays at 9am, \`0 */6 * * *\` every six hours, \`0 0 * * 0\` midnight on Sundays.

Routines are project-scoped and managed under Routines, or by agents via \`create_routine\` and \`list_routines\`. All routines can be paused globally from Settings.

A routine will not start a second run while its previous one is still going, so a long job cannot pile up on itself.`,
  },
  {
    id: 'tools',
    summary: 'How an agent discovers and uses its own capabilities.',
    body: `Agents have built-in tools for tasks, notes, files, shell commands, code execution, web search and fetch, memory, channels, workflows and routines. Which ones are enabled is configurable per agent and per chat.

Two tools cover discovery: \`list_tools\` gives a compact list of what is available right now, and \`get_tool_info\` returns the full reference for one of them. Tool descriptions are kept short deliberately — they are resent on every turn — so the detailed documentation is fetched on demand rather than carried permanently.

**MCP servers** can be connected to add external tools; they appear alongside the built-ins.

File and shell tools run on the user's own machine with the user's own permissions. That is the point of a local-first app, and it is also why an agent should say what it is about to do before doing anything destructive.`,
  },
  {
    id: 'plugins',
    summary: 'Sandboxed extensions, and what they can and cannot reach.',
    body: `Plugins extend Eaves — new views, new tools, new service backends. They run in worker threads with permission-gated access to app data, and the app monitors their memory use.

Plugins are managed under Plugins, and a bundled marketplace plugin lists installable ones. Several ship with the app, including importers for character cards and ChatGPT exports.

Installing a plugin is a trust decision: an installed plugin is code running on the user's machine. The sandbox limits what it can reach, not whether it should be trusted in the first place.`,
  },
  {
    id: 'settings',
    summary: 'Providers and keys, defaults, appearance, data and updates.',
    body: `Settings covers:

- **Providers** — API keys per provider, and endpoint URLs for local providers like Ollama and LM Studio. Keys are encrypted at rest and cannot be read back once saved; they can be replaced or removed. More than one provider can be configured at a time, and different agents can use different ones.
- **Defaults** — which agent is used for new conversations, and which handles background work.
- **Appearance** — themes, background, fonts.
- **Data** — where everything is stored on disk, and database backups. Eaves snapshots the database at startup and daily, keeping the ten most recent, and any snapshot can be restored. Note that snapshots cover the database only — attachments, project workspaces, avatars, themes and installed plugins are files on disk and are not rolled back by a restore. To back up everything, copy the whole app data folder shown in that panel.
- **Updates** — automatic, manual, or left to the system package manager.`,
  },
];

const TOPIC_IDS = EAVES_GUIDE_TOPICS.map(t => t.id);

export function guideTopicIndex(): string {
  return [
    'Eaves guide — available topics. Call eaves_guide again with one of these ids.',
    '',
    ...EAVES_GUIDE_TOPICS.map(t => `- ${t.id}: ${t.summary}`),
  ].join('\n');
}

export function lookupGuideTopic(topic: string): string {
  const key = topic.trim().toLowerCase();
  const found = EAVES_GUIDE_TOPICS.find(t => t.id === key);
  if (found) return found.body;
  // Say what does exist rather than just failing — a wrong guess should teach
  // the correction in one round trip.
  return `No guide topic named "${topic}". Available topics: ${TOPIC_IDS.join(', ')}.`;
}
