# Development

Clone, run, test, and find your data. Conventions and the PR flow live in
[CONTRIBUTING.md](../CONTRIBUTING.md); stack and patterns for coding agents
are in [CLAUDE.md](../CLAUDE.md).

## Getting started

```bash
git clone https://github.com/mackerson/eaves.git
cd eaves
yarn install                 # Install deps + rebuild sqlite for Electron
yarn setup:plugins           # Clone plugin repos + create symlinks
yarn dev:clean               # Start development
```

Node version is pinned in `.nvmrc` (currently **22**). Package manager: **yarn (classic, 1.x)**.

### On Windows

Nothing Windows-specific to configure. `yarn install`, `yarn dev`,
`yarn build` and `yarn test:run` all run on plain Node — no Git Bash, no
`jq`, no Developer Mode, no symlink privileges. What you do need:

- **Node 22.12 or newer.** `.nvmrc` pins only the major, and `@electron/rebuild`
  requires `>=22.12.0`.
- **Visual Studio Build Tools** (C++ workload) and **Python**, to compile
  `better-sqlite3` against Electron.
- **Git for Windows**, if you want the in-app shell code executor to work.
  That feature runs scripts through Git Bash; nothing in the build does.

Two Windows behaviours are worth knowing, because both fail silently rather
than loudly, and both have bitten this repo:

- **`bash` on PATH is WSL, not Git Bash.** `C:\Windows\System32\bash.exe` ships
  with Windows and shadows Git Bash, so anything that shells out to a bare
  `bash` lands in a Linux VM with its own filesystem, its own Node, and no
  ability to read the Windows path it was handed. Package scripts avoid bash
  entirely for this reason; `ShellExecutor` probes Git Bash explicitly and
  refuses the WSL launcher outright.
- **`ln -s` under MSYS copies.** Without Developer Mode, Git Bash silently
  copies a directory instead of linking it. `setup:plugins` creates junctions
  from Node, which need no privileges at all.

Keep `*.sh` files LF — `.gitattributes` enforces it, because Git's Windows
default (`core.autocrlf=true`) otherwise rewrites them to CRLF on checkout
and Git Bash rejects the carriage return with `$'\r': command not found`.

## Project structure

```
eaves/
├── src/
│   ├── main/               # Electron main process
│   │   ├── services/       # Core services (DB, AI, plugins, sandbox, sync)
│   │   ├── repositories/   # Data access layer
│   │   └── ipc/            # IPC handlers by domain
│   ├── renderer/           # React frontend
│   │   ├── components/     # UI components
│   │   ├── stores/         # Zustand state
│   │   └── views/          # Top-level views
│   └── shared/             # Shared types, IPC contracts, Zod validation
├── scripts/qa/             # Headless E2E harness (real IPC, isolated profile)
├── plugins/                # Symlinks to sibling plugin repos (gitignored)
├── bundled-plugins.json    # Manifest of plugins that ship with the app
└── dist/                   # Built files
```

## Scripts

**Development**:
```bash
yarn dev                 # Development mode
yarn dev:clean           # Clean dev processes + start fresh (recommended)
yarn dev:status          # Check running dev processes
yarn kill:dev            # Kill orphaned dev processes
```

**Plugins**:
```bash
yarn setup:plugins           # Clone plugin repos + symlink into plugins/
yarn setup:plugins:pull      # Pull latest on all plugin repos
yarn build:plugins           # Build all plugin UI bundles
```

**Build**:
```bash
yarn typecheck           # Typecheck the renderer
yarn build               # Typecheck + build everything
yarn build:main          # Build main process only
yarn build:renderer      # Build renderer only
yarn build:mcp           # Build the MCP servers
yarn start               # Run built app
yarn package             # Package app for distribution
```

**Testing**:
```bash
yarn test                # Run tests in watch mode
yarn test:run            # Run tests once
yarn test:coverage       # Run tests with coverage report
yarn test:ui             # Open Vitest UI
yarn knip                # Find unused files, exports, and dependencies
```

Tests and dev automatically handle native module rebuilds (`better-sqlite3`).
Switching between `yarn test` and `yarn dev` just works — no manual
`rebuild-sqlite3` needed.

**End-to-end**: `scripts/qa/harness.mjs` launches a headless Eaves on an
isolated profile — real renderer, real IPC, real SQLite, never your own data.

```bash
yarn build:main && yarn build:renderer
node scripts/qa/harness.mjs launch --fresh
node scripts/qa/harness.mjs eval '(async () => (await window.electron.getChats()).chats.length)()'
node scripts/qa/harness.mjs stop
```

**Environment**:
```bash
yarn rebuild-sqlite3     # Rebuild SQLite for Electron (usually automatic)
yarn reset:dev           # Reset dev environment to defaults (with confirmation)
yarn reset:dev:force     # Reset without confirmation (use with caution!)
```

## Workflow

`dev:clean` kills orphaned Electron/Vite processes before starting, preventing
duplicate windows.

**Quitting the app:**
- **macOS**: Press `Cmd+Q` (closing the window keeps the app running in dock)
- **Windows/Linux**: Just close the window

## Data storage

Eaves stores all data locally on your machine.

**Database** (platform-specific):
- **macOS**: `~/Library/Application Support/eaves/eaves-data/eaves.db`
- **Linux**: `~/.config/eaves/eaves-data/eaves.db`
- **Windows**: `%APPDATA%\eaves\eaves-data\eaves.db`

**User plugins**:
- **macOS**: `~/Library/Application Support/eaves/plugins/`
- **Linux**: `~/.config/eaves/plugins/`
- **Windows**: `%APPDATA%\eaves\plugins\`

**Logs**: in the `userData` directory alongside the database.

## Initial state

On first run, Eaves creates a default agent, a "Personal" project, and a
`#general` channel. To reset to that state during development, use
`yarn reset:dev`.

## Database migrations

The schema is versioned via SQLite's `user_version` and migrated automatically
on startup (`src/main/services/migrations.ts`). The migration history has been
squashed into a single baseline at **v75**; `MIN_SUPPORTED_VERSION` is 74, and
a database older than that is rejected at startup with a clear message rather
than silently half-migrated. A frozen snapshot of the pre-squash schema
(`__fixtures__/schema-v74.sql`) is what the test suite compares the baseline
against, so the two cannot drift.
