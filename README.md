# Enclave

**AI chat that remembers your projects, works offline, and respects your privacy.**

Enclave is a desktop application for conversations with AI agents that develop genuine continuity. Chat with Claude, GPT, or local models. Your data lives on your device. Optional sync works without cloud storage.

Built because AI should work for you, not corporations.

---

## What It Is

Desktop app for AI conversations with persistent memory:
- **Agents remember** your projects and context across sessions
- **Works offline** - no internet required for local models
- **Your data stays local** - stored on your device in SQLite
- **Optional P2P sync** - devices connect directly, no cloud storage
- **Extensible** - plugin system for community tools
- **Multi-agent support** - Claude, GPT, OpenRouter, and local models, all in one place

Think of it as giving you an AI sidekick that actually works *for you* - remembers your goals, understands your context, and can't be shut down by a corporate API change.

---

## Quick Start

### Download & Install

**Pre-built installers** (Coming soon):
- **macOS**: Download `.dmg`, drag to Applications
- **Windows**: Download `.exe` installer
- **Linux**: Download `.AppImage`, `.deb`, or `.rpm`

For now, see [Development](#development) to build from source.

### First Run

1. **Add your API key** - Settings → API Keys (Anthropic, OpenAI, or use local models)
2. **Start chatting** - Agents remember your conversation history
3. **Create projects** - Organize work into projects with tasks and notes
4. **Try plugins** - Browse installed plugins, build your own

Your data lives in a local SQLite database. See [Data Storage](#data-storage) for file locations.

---

## Features

### 🧠 Agent Memory
Agents remember your conversations and develop genuine continuity:
- Persistent memory across sessions
- Context builds over time - no more re-explaining
- Agents learn your preferences and project goals
- Memory tied to projects for focused context

### 🤖 Multi-Agent Support
Work with different AI models in one place:
- Anthropic Claude (Opus, Sonnet, Haiku)
- OpenAI (GPT-4o and newer)
- OpenRouter (hundreds of models behind one key)
- Local models (Ollama, LM Studio)
- MCP (Model Context Protocol) server integration
- Per-agent configuration and personality

Available models are fetched live from each provider, so new releases appear without an app update.

### 🔒 Privacy by Architecture
Your data stays under your control:
- All data stored locally in SQLite
- No cloud dependency, no tracking, no telemetry
- Works offline, always
- Optional P2P sync (we can't read your data - architecture proves it)

### 🔌 Plugin System
Community-driven extensibility:
- Full API for data access, UI extensions, events
- Isolated storage per plugin
- Build custom tools and workflows
- Examples: WebView browser, terminal, custom visualizations

### 💬 IRC-Style Organization
Flexible workspace for focused thinking:
- Channels for organizing conversations
- Projects with tasks, notes, and milestones
- Multi-agent discussions in shared spaces
- Real-time streaming with tool call visualization

---

## Why This Matters

### Information Asymmetry
Right now, the power dynamic is broken:
- **Corporations have AI** that analyzes you, predicts you, profits from you
- **You get dumbed-down chatbots** that forget everything and can be shut down anytime
- **Information flows one way**: You → Corporate AI → Corporate profit

Enclave flips this:
- **Your AI works for you** - remembers your goals, protects your interests
- **You control the data** - it lives on your devices, not corporate servers
- **Information flows to you**: World → Your Agent → You (filtered and contextualized)

Think about what becomes possible when you have an AI sidekick that:
- Reads terms of service and flags concerning clauses
- Analyzes news sources for bias and provides missing context
- Recognizes social engineering and manipulation attempts
- Helps you navigate corporate bureaucracy with full memory of past interactions
- Maintains your privacy by filtering what data you share

This is information asymmetry reversal. It's only possible with local-first, user-controlled infrastructure.

---

## How Device Sync Works

Enclave supports optional device synchronization using a **coordination model** (like Tailscale) rather than cloud storage. **LAN peer-to-peer sync (Phase 1) has shipped**; cross-network coordination is on the roadmap.

### Direct P2P Sync (Free, Always) — *Phase 1 shipped*
- Devices connect directly over IP (local network today; internet via coordination later)
- Direct peer-to-peer encrypted sync between your devices
- No servers, no cloud storage, no middleman
- Works on LAN, VPN, or direct IP connection
- Like AirDrop, but for any of your devices that can reach each other

### Coordination Service (Optional Premium)
- Helps devices find each other across networks and NAT
- Provides encrypted relay when direct connection isn't possible
- End-to-end encrypted - we **can't read your data**
- Coordination metadata only (device info, connection logs)
- Your conversations, agents, and content never touch our servers

### What This Means

**Privacy by architecture:**
- We coordinate connections, not content
- Even if our servers were compromised, your data is safe
- End-to-end encryption means we physically can't read your conversations
- Similar trust model to Signal, Tailscale, Syncthing

**Technical details:** See the [architecture overview](docs/architecture/README.md)

---

## Plugins

Plugins live in their own repositories and are symlinked into the core for development. See `bundled-plugins.json` for the full manifest.

### Plugin Tiers

| Tier | Description | Ships with app? |
|------|-------------|-----------------|
| **Bundled** | Core functionality (memory, importers, sync, marketplace) | Yes |
| **Example** | Reference implementations (webview "hello dolly") | Yes |
| **QA** | Needs testing before promotion (claude-code-terminal, enclave-claude-context) | Not yet |
| **Community** | Optional, user-installed (openmemory) | No |

### Plugin Loading

Enclave loads plugins from three locations (highest priority first):
1. `plugins/` in the app directory (dev mode only, symlinks to sibling repos)
2. `~/.config/enclave/plugins/` (user-installed)
3. `dist/plugins/` (bundled with packaged app)

### Plugin Repos

Each plugin has its own repo at `mackerson/enclave-plugin-<name>`:

| Plugin | Repo | Tier |
|--------|------|------|
| simple-memory | `enclave-plugin-simple-memory` | Bundled |
| character-card-import | `enclave-plugin-character-card-import` | Bundled |
| chatgpt-import | `enclave-plugin-chatgpt-import` | Bundled |
| enclave-sync | `enclave-plugin-enclave-sync` | Bundled |
| plugin-marketplace | `enclave-plugin-plugin-marketplace` | Bundled |
| simple-memory-processor | `enclave-plugin-simple-memory-processor` | Bundled |
| event-inspector | `enclave-plugin-event-inspector` | Bundled |
| webview | `enclave-plugin-webview` | Example |
| claude-code-terminal | `enclave-plugin-claude-code-terminal` | QA |
| enclave-claude-context | `enclave-plugin-enclave-claude-context` | QA |
| openmemory | `enclave-plugin-openmemory` | Community |

### Creating a Plugin

All sandboxed plugins (`sandboxVersion: 1`) use the same pattern:

1. Create a repo with `plugin.json`:
```json
{
  "id": "com.example.myplugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Does something cool",
  "type": "tool",
  "entry": "index.cjs",
  "sandboxVersion": 1,
  "permissions": ["storage:read", "storage:write", "tools:register"]
}
```

2. Create `index.cjs` with activate/deactivate:
```javascript
module.exports = {
  async activate(context) {
    context.tools.register('my_tool', {
      description: 'Does something',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => ({ result: 'done' }),
    });
  },
  async deactivate(context) {}
};
```

3. Install to `~/.config/enclave/plugins/your-plugin/` or add to `bundled-plugins.json`.

### Plugin API

The sandboxed plugin context provides:
- **Data Access**: Read agents, projects, channels, settings
- **Actions**: Create tasks/notes, send messages, switch context
- **UI Extensions**: Register views, sidebar items, commands
- **Events**: Subscribe to app events, emit custom events
- **Tools**: Register AI tools (available to agents)
- **Services**: Register/discover inter-plugin services
- **Storage**: Plugin-isolated key-value storage
- **Logging**: Prefixed logging for debugging

---

## Architecture

### Tech Stack
- **Desktop**: Electron
- **Frontend**: React + TypeScript + Tailwind CSS + shadcn/ui
- **Database**: SQLite (via better-sqlite3)
- **AI SDK**: Vercel AI SDK (provider-agnostic streaming)
- **Build**: Vite for renderer, TypeScript for main process

### Repository Pattern
All database operations use repository classes for clean separation:
- `AgentRepository` - Agent CRUD
- `ProjectRepository` - Projects, tasks, notes
- `ChannelRepository` - Channels and messages
- `SettingsRepository` - App settings
- `PluginStorageRepository` - Plugin data

### Event System
App-wide EventBus for communication:
- Data events (`agent:created`, `project:updated`, etc.)
- AI events (`chat:start`, `tool:call`, etc.)
- Plugin events (`plugin:loaded`, `plugin:view:registered`, etc.)

---

## Documentation

- **Architecture**: `CLAUDE.md` - Build commands, architecture overview, key patterns

---

## Development

### Project Structure
```
~/personal/enclave/
├── app/                    # This repo (core application)
│   ├── src/
│   │   ├── main/           # Electron main process
│   │   │   ├── services/   # Core services (DB, AI, plugins, sandbox)
│   │   │   ├── repositories/ # Data access layer
│   │   │   └── ipc/        # IPC handlers
│   │   ├── renderer/       # React frontend
│   │   │   ├── components/ # UI components
│   │   │   ├── stores/     # Zustand state
│   │   │   └── views/      # Top-level views
│   │   └── shared/         # Shared types, validation
│   ├── plugins/            # Symlinks to ../plugins/* (gitignored)
│   ├── bundled-plugins.json # Manifest of plugins that ship with app
│   └── dist/               # Built files
└── plugins/                # Sibling directory (separate git repos)
    ├── simple-memory/
    ├── chatgpt-import/
    └── ...
```

### Getting Started

```bash
git clone https://github.com/mackerson/enclave-ai.git
cd enclave-ai
yarn install                 # Install deps + rebuild sqlite for Electron
yarn setup:plugins           # Clone plugin repos + create symlinks
yarn dev:clean               # Start development
```

Node version is pinned in `.nvmrc` (currently **22**). Package manager: **yarn (classic, 1.x)**.

### Scripts

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
```

**Build**:
```bash
yarn build               # Build for production
yarn build:main          # Build main process only
yarn build:renderer      # Build renderer only
yarn start               # Run built app
yarn package             # Package app for distribution
```

**Testing**:
```bash
yarn test                # Run tests in watch mode
yarn test:run            # Run tests once
yarn test:coverage       # Run tests with coverage report
yarn test:ui             # Open Vitest UI
```

Note: Tests and dev automatically handle native module rebuilds (`better-sqlite3`). Switching between `yarn test` and `yarn dev` just works — no manual `rebuild-sqlite3` needed.

**Environment**:
```bash
yarn rebuild-sqlite3     # Rebuild SQLite for Electron (usually automatic)
yarn reset:dev           # Reset dev environment to defaults (with confirmation)
yarn reset:dev:force     # Reset without confirmation (use with caution!)
```

### Development Workflow

```bash
yarn setup:plugins       # One-time: clone plugin repos
yarn dev:clean           # Start dev (recommended over plain `yarn dev`)
```

`dev:clean` kills orphaned Electron/Vite processes before starting, preventing duplicate windows.

**Quitting the app:**
- **macOS**: Press `Cmd+Q` (closing the window keeps the app running in dock)
- **Windows/Linux**: Just close the window

### Data Storage

Enclave stores all data locally on your machine:

**Database Location** (platform-specific):
- **macOS**: `~/Library/Application Support/enclave/enclave-data/enclave.db`
- **Linux**: `~/.config/enclave/enclave-data/enclave.db`
- **Windows**: `%APPDATA%\enclave\enclave-data\enclave.db`

**User Plugins**:
- **macOS**: `~/Library/Application Support/enclave/plugins/`
- **Linux**: `~/.config/enclave/plugins/`
- **Windows**: `%APPDATA%\enclave\plugins\`

**Logs**:
- Located in `userData` directory alongside the database

### Initial State

On first run, Enclave automatically creates:
- **Default Agent**: "Assistant" (Claude Sonnet)
- **Default Project**: "Personal"
- **Default Channel**: "#general" (public channel)
- **Default User**: Name from `.env` or "User"

To reset to default state during development, use `yarn reset:dev`.

### Database Migrations
The schema is versioned via SQLite's `user_version` and migrated automatically on startup (`src/main/services/migrations.ts`). The early migration history was squashed into a single baseline (`MIN_SUPPORTED_VERSION = 52`); the schema is currently at **v67**. Databases older than the baseline are detected and rejected with a clear message rather than silently mangled.

---

## Roadmap

### v0.3 (Current) - Plugins, Multi-Agent & Sync Foundations
- ✅ Sandboxed plugin infrastructure (Worker Threads, permission gating)
- ✅ Bundled plugins: memory, importers, sync, marketplace
- ✅ Multi-agent channels (IRC-style rooms, @mention dispatch, perspective-shifted history)
- ✅ LAN peer-to-peer device sync (Phase 1)
- ⏳ Plugin developer documentation

### v0.4 - Memory & Intelligence
- Long-term agent memory
- Context window management
- Conversation summarization
- Semantic memory search

### v0.5 - Agent Collaboration (deepening)
- Agent-to-agent tool calling
- Orchestration patterns
- Richer multi-agent coordination

### v0.6 - Device Sync (cross-network)
- ✅ P2P device sync over LAN (free, no servers) — *shipped in v0.3*
- ⏳ Internet device coordination across NAT (premium)
- ⏳ End-to-end encryption hardening (we can't read your data)
- See the [architecture overview](docs/architecture/README.md) for details

### v1.0 - Production Ready
- Full stability and testing
- Community plugin ecosystem
- Cross-platform installers

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, conventions, and the PR flow,
and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for community expectations.
Security issues go through [SECURITY.md](./SECURITY.md), never a public issue.

---

## Philosophy

**Software should respect users. AI should work for people, not corporations.**

Enclave is built on the belief that:
- **Users deserve sovereignty** - Your data, your devices, your control
- **Agents need continuity** - Memory and identity matter for genuine utility
- **Communities build better tools** - Open systems enable protective innovation
- **Architecture is ethics** - Local-first design prevents exploitation

### Inspired By

- **Justin Frankel** (Winamp, WASTE) - Tools that respect users
- **Valve Software** - Quality over metrics, soul over shipping
- **Signal, Syncthing, Tailscale** - Privacy through architecture
- **Open source communities** - Transparent, user-first development

### Core Values

- **Privacy by architecture** - We can't read your data (coordination, not storage)
- **Local-first always** - Your devices, your control, forever
- **Community extensibility** - Open plugin system for protective tools
- **User sovereignty** - Architecture prevents corporate lock-in

The business model (optional coordination service) funds development without compromising the foundation. The MIT-licensed core can never be taken away.

---

## License

**MIT License** - Use it, fork it, learn from it, build on it.

The core will always be free. Optional services (cloud sync, mobile) fund continued development while preserving the local-first foundation.

See [LICENSE](LICENSE) for full text.

---

## Acknowledgments

Special thanks to:
- **Anthropic** - For Claude and the MCP protocol that makes agent extensibility possible
- **Justin Frankel** - For Winamp, WASTE, and showing that respectful software can win
- **Local LLM community** - Ollama, LM Studio, and everyone pushing intelligence to the edge
- **Signal, Tailscale, Syncthing communities** - For proving privacy-first architecture works

And to **you**, for caring enough to read this far.

---

**Version**: 0.3.8
**License**: MIT
