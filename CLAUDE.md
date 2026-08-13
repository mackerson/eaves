# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

Package manager: **yarn (classic, 1.x)**. Node version pinned in `.nvmrc` (currently 22).

```bash
# First-time setup
yarn install              # Install deps + rebuild sqlite for Electron
yarn setup:plugins        # Clone plugin repos + create symlinks

# Development (recommended)
yarn dev:clean            # Clean dev processes + start fresh
yarn dev                  # Start dev mode (Vite renderer + Electron main)
yarn dev:status           # Check running dev processes
yarn kill:dev             # Kill orphaned dev processes

# Plugins
yarn setup:plugins        # Clone plugin repos from GitHub + symlink into plugins/
yarn setup:plugins:pull   # Pull latest on all plugin repos
yarn build:plugins        # Build all plugin UI bundles

# Build
yarn build                # Full production build
yarn build:renderer       # Vite build for React frontend
yarn build:main           # TypeScript compile for Electron main process
yarn build:mcp            # TypeScript compile for MCP servers

# Testing
yarn test                 # Run tests in watch mode
yarn test:run             # Run tests once
yarn test:coverage        # Coverage report
yarn test:ui              # Open Vitest UI
yarn vitest run src/main/repositories/AgentRepository.test.ts  # Run single test file

# E2E QA (headless app on an isolated profile — details in .claude/skills/e2e-qa)
node scripts/qa/harness.mjs launch --fresh    # run yarn build:main first (+ build:renderer if no Vite dev server)
node scripts/qa/harness.mjs eval '<js>'       # drive real IPC/DOM; also: screenshot, stop

# Distribution
yarn package              # Package app for distribution
yarn rebuild-sqlite3      # Rebuild SQLite for Electron
yarn reset:dev            # Reset dev environment to defaults
```

Note: Native module rebuilds are automatic. `predev` rebuilds better-sqlite3 for Electron, `pretest` rebuilds for system Node. No manual `rebuild-sqlite3` needed when switching between dev and test.

## Architecture Overview

Enclave is a local-first Electron desktop application for multi-agent AI conversations with persistent memory.

Architecture diagrams and invariants live in `docs/architecture/README.md` — that page is the diagram home; this file stays command- and pattern-oriented.

### Process Architecture

**Main Process** (`src/main/`):
- Entry: `main.ts` initializes services, registers IPC handlers, creates window
- Services: Database, PluginManager, EventBus, TerminalManager, RoutineScheduler, ChannelDispatcher
- IPC handlers registered in `src/main/ipc/` before window creation
- Repository pattern for all database operations (`src/main/repositories/`)

**Renderer Process** (`src/renderer/`):
- React 18 + TypeScript + Tailwind CSS + shadcn/ui
- Zustand stores for state management (`src/renderer/stores/`)
- IPC calls via `window.electron.*` bridge from preload script
- Layout: `AppLayout.tsx` with sidebar and content area

### Key Patterns

**IPC Communication**:
```typescript
// Main: ipcMain.handle('agent:create', handler)
// Renderer: await window.electron.createAgent(data)
// Types: src/shared/ipc-types.ts defines request/response shapes
```

**IPC Validation**: All IPC handlers validate input using Zod schemas from `src/shared/validation.ts`. Use `validateWithSchema()` helper for consistent error handling.

**Repository Pattern**: All database ops through repository classes (AgentRepository, ChannelRepository, etc.). Repositories use `safeJsonParse` from `src/main/utils/safeJson.ts` for safe JSON parsing with fallback defaults.

**Event Bus**: Global pub/sub for app events (`eventBus.emitEvent`, `eventBus.onEvent`). `ChannelRepository` emits `message:created`/`message:updated` when messages are created or drafts finalized; the canonical delete IPC handlers emit `message:deleted`/`channel:deleted`/`project:deleted`. The bus is **storage-only** — nothing on it starts an agent turn (ADR-001); consumers are side services only.

**Plugin System** (Sandboxed, `src/main/services/sandbox/`):
- All plugins run sandboxed in Worker Threads via `SandboxedPluginManager`
- Plugins require `"sandboxVersion": 1` in manifest (non-sandboxed plugins are skipped)
- Permission-gated API access (`data:agents:read`, `storage:write`, `tools:register`, etc.)
- `PluginWorker`: Worker thread wrapper with health monitoring
- `PermissionGate`: Runtime permission enforcement (21 permission grants; union in `src/shared/types.ts`)
- `ResourceMonitor`: Memory tracking, auto-termination of runaway plugins
- Bridges: `EventBridge`, `ToolBridge`, `ServiceBridge` for cross-boundary RPC
- Module blocking: **advisory only, not a security boundary.** `worker-entry.ts`
  keeps a forbidden/allowed module list, but it gates `globalThis.require` —
  which Node's CJS wrapper shadows, so plugin module code never reaches it
  (bundled plugins do call `require('fs')` directly today). `node:`-prefixed
  specifiers also miss the list. Treat plugin code as trusted-by-install;
  the enforced boundaries are the worker thread, `PermissionGate` on the RPC
  bridge, and `ResourceMonitor`.
- Plugins live in separate repos (`mackerson/enclave-plugin-*`), symlinked for dev
- `bundled-plugins.json` defines which plugins ship with packaged builds
- Three load paths: `plugins/` (dev symlinks) > `~/.config/enclave/plugins/` (user) > `dist/plugins/` (bundled)

### Chat vs Channel Architecture

Two UI surfaces share one storage substrate: since the chat→channel fold a "chat" is a `channels` row with `type='direct'`, and since Phase 3 Round 3 there is a **single repository** — `ChannelRepository` (ChatRepository was deleted). Its documented direct-channel projection serves the chat IPC surface; row CRUD delegates to the shared `messageCRUD.ts` helpers. The two surfaces are API/UI shape, not separate stores.
- **Channels** (`view: 'channels'`, `ChannelRepository`): IRC-style multi-participant rooms, project-scoped, many humans ↔ many agents
- **Chats** (`view: 'chats'`, `ChannelRepository` direct-channel projection): 1:1 human↔agent projection over `type='direct'` channels; supports tags/archive

### Multi-Agent Communication

Agents in channels can see and respond to each other via **perspective-shifted message history** and **@mention dispatching**.

**Perspective Shifting** (`src/main/utils/perspectiveShift.ts`):
When an agent receives channel history, messages are rewritten from its perspective:
- Its own prior responses → `role: 'assistant'` (no prefix)
- Other agents' messages → `role: 'user'` with `[AgentName]:` prefix
- Human messages → `role: 'user'` with `[HumanName]:` prefix
- Consecutive same-role messages are merged (Claude API requires alternating roles)

**Channel Dispatcher** (`src/main/services/ChannelDispatcher.ts`):
A main-process service that runs server-side agent responses via **explicit `requestDispatch(intent)` calls** — not by subscribing to the EventBus (nothing on the bus starts a turn, ADR-001). Intent producers: the `send-message` IPC handler (chain root), the finalizing turn (chained intent for `@mentions` in a reply, depth+1), and the `channel_send_message` tool (chain root). It parses `@AgentName` mentions and dispatches responses.

- Mention parsing resolves names against channel participants
- Agents with `channelBehavior.respondTo: 'all'` respond to every message
- Default behavior is `mentions-only` + `brief` (1-3 sentences)
- Loop prevention: per-chain depth limit (3), cooldown (2s), active dispatch set, self-mention skip. (`dispatchedBy` is written onto broadcast replies as terminal metadata but is **no longer read as a guard** — post-ADR-001, terminality is structural: broadcast turns chain no intent.)

**Channel Behavior** (`ChannelBehavior` on Agent type):
Per-agent configuration stored in DB (`channel_behavior` JSON column):
- `respondTo`: `'mentions-only'` (default) or `'all'`
- `verbosity`: `'brief'` (default), `'normal'`, or `'verbose'`
- Injected into system prompt via `buildChannelBehaviorNote()`

**Agent Channel Tools** (`src/main/services/channelTools.ts`):
Scoped to the calling agent, available to all agents:
- `channel_send_message` — post to a *different* channel (blocked for current channel)
- `channel_list` — list channels the agent participates in
- `channel_create` — create a new channel (agent auto-joins)
- `channel_invite` — invite an agent/user by name
- `channel_history` — read recent messages from a channel

**Agent Self-Config Tools** (`src/main/services/agentSelfTools.ts`):
- `get_my_channel_behavior` — read current settings
- `update_my_channel_behavior` — change respondTo/verbosity

### Database

SQLite via better-sqlite3 with auto-migrations on startup. `database.ts` opens the DB and runs migrations; the schema itself (`CREATE TABLE` statements + versioned migrations) lives in `src/main/services/migrations.ts`.

Platform locations:
- macOS: `~/Library/Application Support/enclave/enclave-data/enclave.db`
- Linux: `~/.config/enclave/enclave-data/enclave.db`
- Windows: `%APPDATA%\enclave\enclave-data\enclave.db`

### AI Integration

Uses Vercel AI SDK with multiple providers:
- `@ai-sdk/anthropic` (Claude)
- `@ai-sdk/openai` (GPT)
- Ollama (local models) via its OpenAI-compatible endpoint
- MCP protocol support via `@modelcontextprotocol/sdk`

## Directory Structure

```
src/
├── main/
│   ├── main.ts                 # Electron entry, service init
│   ├── preload.ts              # Context isolation bridge
│   ├── services/               # Core services (database, plugins, events)
│   │   └── sandbox/            # Sandboxed plugin system
│   ├── repositories/           # Database access layer
│   ├── ipc/                    # IPC handlers by domain
│   └── utils/                  # Utilities (safeJson, perspectiveShift, etc.)
├── renderer/
│   ├── App.tsx                 # Root component
│   ├── stores/                 # Zustand state
│   ├── views/                  # Top-level view components
│   └── components/             # React components
└── shared/
    ├── ipc-types.ts            # IPC request/response types
    └── validation.ts           # Zod schemas for IPC validation

plugins/                        # Symlinks to sibling repos (gitignored, run setup:plugins)
bundled-plugins.json            # Manifest of plugins that ship with app
docs/                          # Architecture RFCs, roadmap
```

## Development Notes

- Use `yarn dev:clean` to avoid orphaned processes
- Run `yarn setup:plugins` once after cloning to populate plugins/ with symlinks
- Dev tools auto-open in development mode
- Plugin changes auto-reload in dev mode
- macOS: Cmd+Q to fully quit (closing window keeps app in dock)
- When adding new IPC handlers, add Zod validation schema to `src/shared/validation.ts`
- IPC handlers use `ipcResult()` wrapper for consistent error envelopes
- Repository row types are in `src/main/repositories/row-types.ts` — SQLite stores timestamps as INTEGER (not TEXT)
