# Writing Enclave Plugins

A practical guide to building a plugin — the manifest, the sandboxed `context`
API you get at runtime, permissions, and how to add tools, views, and events.

**Build mechanics** — where plugins live, first-time setup, and how the UI bundle is
built (Vite) — live in [`plugin-build-system.md`](./plugin-build-system.md). This
guide focuses on *writing* the plugin: the manifest, the runtime API, and permissions.

## What a plugin is

A plugin is a small package that Enclave loads into a **sandboxed Worker Thread**.
It can register agent tools, background services, UI views, and event listeners —
but it has **no ambient access** to the filesystem, network, or host modules. Every
capability comes through a proxied `context` object and is gated by a permission the
user consented to at install time. Each plugin runs in its own worker, is
resource-monitored, and is terminated if it misbehaves or exceeds its limits — so a
buggy or hostile plugin can't take the app down or reach data it wasn't granted.

Two moving parts:
- A **backend entry** (`index.cjs`) that runs in the worker and calls `context.*`.
- An optional **UI bundle** (`ui/`) — a React component surface rendered in the app.

A plugin can be backend-only (tools, services), UI-only (a view), or both.

## Quick start — a tool plugin

The smallest useful plugin registers an agent tool. Two files:

**`plugin.json`**
```json
{
  "id": "com.example.wordcount",
  "name": "Word Count",
  "version": "1.0.0",
  "description": "A tool that counts words in text.",
  "author": "you@example.com",
  "type": "tool",
  "sandboxVersion": 1,
  "permissions": ["tools:register"],
  "entry": "index.cjs"
}
```

**`index.cjs`**
```js
module.exports = {
  async activate(context) {
    context.tools.register('count_words', {
      description: 'Count the number of words in a piece of text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to count' } },
        required: ['text'],
      },
      execute: async ({ text }) => {
        const count = String(text).trim().split(/\s+/).filter(Boolean).length;
        return { count };
      },
    });
    context.utils.log.info('word-count plugin activated');
  },

  async deactivate(context) {
    context.tools.unregister('count_words');
  },
};
```

Drop it in a directory Enclave loads (see `plugin-build-system.md` → *Where plugins
live*), and agents can call `count_words`. That's a complete plugin — no build step,
because it has no UI.

## The manifest (`plugin.json`)

| Field | Required | Notes |
|---|---|---|
| `id` | ✓ | Reverse-DNS, stable forever (e.g. `com.example.wordcount`). It keys storage, grants, and load state. |
| `name` | ✓ | Human-facing display name. |
| `version` | ✓ | Semver. |
| `type` | ✓ | One of `ui`, `tool`, `hybrid`, `mcp`, `import`, `terminal` — the plugin's primary shape. |
| `sandboxVersion` | ✓* | Must be `1`. **Plugins without it are skipped entirely** — there is no non-sandboxed load path. |
| `permissions` | – | Array of the grants below. Omit if the plugin needs none. |
| `entry` | – | Backend entry file (e.g. `index.cjs`). Omit for UI-only plugins. |
| `description`, `author`, `icon` | – | Metadata (≤500 / ≤100 / ≤50 chars). |
| `ui` | – | UI bundle wiring — `{ "entry": "ui/dist/index.js", "components": { "MyView": "named" } }`. |
| `config` | – | Default config object, surfaced to the plugin as `context.plugin.config`. |
| `provides` / `requires` | – | Service capability declarations (see *Services*). |

\* Effectively required — the loader skips any manifest without `sandboxVersion: 1`.

## Lifecycle

`activate(context)` runs once when the plugin loads. `deactivate(context)` runs on
the way out — disable, reload, update, and uninstall all take that path.

What `deactivate` can rely on:

- It is called **only if `activate` resolved**. A plugin whose `activate` threw
  never took ownership of anything, so it is not asked to release anything.
- It still has a working `context`. The host tears down the RPC channel *after*
  the hook returns, so flushing state through `context.storage` works.
- It gets **3 seconds**, inside the host's 5s graceful-shutdown budget. Overrun
  or throw and the host logs it and continues shutting down — an uninstall
  cannot be blocked by plugin code, so treat cleanup as best-effort.
- It runs at most once per load.

## The `context` API

`activate(context)` receives a proxied object. Everything is async (calls cross the
worker boundary via RPC) and **gated by permissions** — calling a namespace you didn't
declare a permission for is denied.

### `context.tools` — register agent tools · `tools:register`
```js
context.tools.register(name, {
  description,               // shown to the model
  inputSchema,              // JSON Schema (or `parameters`, normalized to inputSchema)
  execute: async (args) => result,
  needsApproval,            // true = always gate behind human approval (static only)
});
context.tools.unregister(name);
```

### `context.ui` — surfaces · `ui:views:register`, `ui:notifications:show`
```js
context.ui.registerView({ id, title, icon, component });  // a full sidebar view
context.ui.registerSidebarItem(item);
context.ui.registerTerminalView(view);
context.ui.registerCommand({ id, title, handler });
context.ui.showNotification(message, type);
context.ui.showToast(message, duration);
```
`component` maps to a name exported by your UI bundle (see *UI plugins*).

### `context.events` — pub/sub · `events:listen`, `events:emit`
```js
const id = context.events.on('message:created', (data) => { /* … */ });
context.events.once('chat:complete', (data) => { /* … */ });
context.events.off('message:created', id);
context.events.emit('my-plugin:did-thing', { ok: true });
```
`on`/`once`/`off` need `events:listen`; `emit` needs `events:emit`. Host-namespace
events cannot be forged — you can listen but not impersonate core events.

### `context.data` — read app state · `data:<domain>:read`
```js
await context.data.agents.getAll();          // data:agents:read
await context.data.projects.getCurrent();    // data:projects:read
await context.data.channels.getById(id);     // data:channels:read
await context.data.chats.getByAgent(agentId, options); // data:chats:read
await context.data.settings.get();           // data:settings:read
```
Read-only. Each domain is a separate grant — request only what you use.

### `context.actions` — mutate app state · `data:<domain>:write`
```js
await context.actions.createTask(projectId, content);   // data:tasks:write
await context.actions.createNote(projectId, content);   // data:notes:write
await context.actions.createChat(params);               // data:chats:write
await context.actions.createAgent(params);              // data:agents:write
await context.actions.bulkImportMessages(chatId, msgs); // data:messages:write
await context.actions.bulkImportAttachments(list);      // data:chats:write
```

### `context.services` — cross-plugin RPC · `services:register`, `services:call`
Register a capability other plugins (or the core) can call, or consume one:
```js
context.services.register('memory-backend', { store, retrieve, search }, metadata);
const backend = await context.services.getDefault('memory-backend');
await backend.search({ query: 'hello' });
context.services.hasProviders('memory-backend');
```

### `context.utils` — storage, logging, paths
```js
await context.utils.storage.set(key, value);  // storage:write
await context.utils.storage.get(key);          // storage:read
await context.utils.storage.keys();
context.utils.log.info('message', data);       // namespaced console logging
context.utils.paths;                            // resolved app paths (no electron.app in workers)
```
Storage is a per-plugin key/value store — isolated from other plugins.

## Permissions

Declare exactly what you use in `permissions`. The user sees and consents to the set
at install; requesting more than you need gets your plugin rejected or distrusted.

| Grant | Unlocks |
|---|---|
| `data:agents:read` / `:projects:read` / `:channels:read` / `:chats:read` / `:settings:read` | the matching `context.data.*` reads |
| `data:tasks:write` / `:notes:write` / `:messages:write` / `:chats:write` / `:agents:write` | the matching `context.actions.*` mutations |
| `ui:views:register` | `registerView` / `registerSidebarItem` / `registerTerminalView` |
| `ui:notifications:show` | `showNotification` / `showToast` |
| `events:listen` / `events:emit` | `context.events` subscribe / publish |
| `tools:register` | `context.tools` |
| `services:register` / `services:call` | provide / consume services |
| `storage:read` / `storage:write` | `context.utils.storage` |
| **`network:http`** | outbound HTTP — **dangerous**, requires explicit consent + review |
| **`system:filesystem`** | filesystem access — **dangerous**, requires explicit consent + review |

The two dangerous grants widen the trust boundary; keep them out of your manifest
unless the plugin genuinely needs them, and expect extra scrutiny at review.

## Sandbox constraints

The worker blocks host and I/O modules — `require('fs')`, `child_process`, `net`,
`http`/`https`, `vm`, `worker_threads` and friends throw. Electron's `app` object is
not available either; use `context.utils.paths` instead of `app.getPath(...)`.

The practical rule: **reach the outside world only through `context`**. If you find
yourself wanting a blocked module, either there's a `context` API for it, the
capability needs a permission (`network:http` / `system:filesystem`), or it doesn't
belong in a plugin.

## UI plugins

A UI plugin ships a React bundle and wires it in the manifest:
```json
"ui": { "entry": "ui/dist/index.js", "components": { "MyView": "named" } }
```
- Build the bundle with the project's Vite config — see `plugin-build-system.md` →
  *Plugin UI build*.
- Register the view from `index.cjs`: `context.ui.registerView({ id, title, icon,
  component: 'MyView' })` — `component` must match a `components` key.
- Inside the component, host UI primitives are available on `window.EnclaveAPI.UI`
  (buttons, cards, inputs, `AppIcon`, …) so plugins match the app's look and theme.
- Installed bundles are served over the privileged `plugin://` scheme, so UI plugins
  work in packaged builds with no dev server.

## Build, test, publish

- **Local dev:** `yarn setup:plugins` symlinks sibling plugin repos into `plugins/`,
  which is the first load path Enclave checks, so a linked repo shadows the bundled
  copy of the same id. The dev watcher only watches `*/plugin.json`: editing the
  manifest reloads the plugin, but editing backend code needs the **Reload** button
  on the plugin's card in Plugins, and UI changes need `yarn build:plugins` to
  regenerate `ui/dist` first. Details in `plugin-build-system.md`.
- **Standalone build:** each plugin repo ships a `release.mjs` that builds → packs →
  checksums a distributable tarball, so authors don't need a full Enclave dev tree.
- **Publish:** bump `version` in `plugin.json`, then push a `vX.Y.Z` tag. The repo's
  `.github/workflows/release.yml` builds the bundle, checksums it, and publishes a
  GitHub release; paste the emitted `release` block into
  [`enclave-plugin-registry`](https://github.com/mackerson/enclave-plugin-registry)
  and bump `latest`. `scripts/validate.mjs` is the merge gate.

  The bundle is the built runtime only — `plugin.json`, the backend entry, `lib/`
  if present, and `ui/dist` — at the tar root. Not the source repo.

  Two checks will reject a bundle at install time, so keep them in mind:
  its `plugin.json` `id` must match the registry entry, and its `permissions`
  must equal the registry's **exactly** — the user consented to that list, and
  differing in either direction fails the install.
- **Trust model:** the registry is first-party only, and a curated entry plus its
  sha256 is the whole trust root — there is no bundle signing yet. Third-party
  submission and signing are later phases.

## Checklist before you ship

- [ ] `id` is reverse-DNS and final (it keys storage + grants).
- [ ] `sandboxVersion: 1` is set.
- [ ] `permissions` lists **only** what the code uses. `network:http` and
      `system:filesystem` are the two the sandbox treats as elevated, and the
      install dialog calls them out with a warning marker above everything else —
      asking for either buys real scrutiny from users.
- [ ] `deactivate` unregisters tools/views and removes event listeners, and
      finishes well inside its 3s budget.
- [ ] `permissions` match the registry entry exactly — install rejects any
      difference, in either direction.
- [ ] No blocked-module `require`s; all outside access goes through `context`.
- [ ] UI `component` names match the `ui.components` map.
