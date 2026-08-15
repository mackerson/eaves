---
name: e2e-qa
description: Launch and drive an isolated headless Eaves instance for end-to-end QA — real renderer, real IPC, real SQLite, never the user's profile. Use when verifying a change in the running app, screenshotting UI, or exercising IPC flows.
---

# Headless E2E QA for Eaves

`scripts/qa/harness.mjs` launches an isolated Eaves (fresh `XDG_CONFIG_HOME`
→ fresh DB, migrations run on boot) with CDP on :9222 and drives it via
`Runtime.evaluate`. `window.electron.*` is fully exposed, so flows can be
exercised through real IPC and asserted against the rendered DOM.

## Order of operations (each step matters)

1. **Build what Electron actually loads.** Electron runs `dist/main/` — run
   `yarn build:main` after any main-process change or you verify stale code
   (symptom: new IPC/migration behavior silently absent; Zod strips unknown
   keys, so a new filter field just no-ops). If no Vite dev server is on
   :5173, also `yarn build:renderer` (the harness serves `dist/renderer`
   itself). The harness fatals/warns on staleness but never rebuilds.

   **Read the launch banner before trusting any UI result.** It names which
   server is serving the renderer. A Vite dev server builds from source and is
   always current; the harness's own static server serves `dist/renderer` as
   of *its* start, so a leftover one from an earlier run silently serves old
   UI code — the app boots, assertions run, and a fix under test reads as
   still broken. `launch` warns when it reuses one (with its pid and start
   time) and when `dist/renderer` is older than `src/renderer`; `stop` kills
   it and clears `<scratch>/renderer-server.json`. Both warnings mean: stop,
   rebuild, launch. Probes resolve via `localhost` exactly as the app does —
   Vite binds `[::1]` and the static server binds `127.0.0.1`, so on a
   dual-stack box each can hold "5173" independently.
2. **sqlite ABI**: `yarn rebuild-sqlite3` before launching if tests ran last
   (`yarn test` pretest rebuilds for system Node; a crash-loop of
   `ERR_DLOPEN_FAILED` in the electron log means this).
3. `node scripts/qa/harness.mjs launch --fresh` — spawns everything detached,
   waits for CDP, auto-skips OOBE. Migration success is greppable in
   `<scratch>/xdg/eaves/logs/*.log` (scratch defaults to
   `$TMPDIR/eaves-qa`, override with `EAVES_QA_DIR`).
4. Drive it:
   - `node scripts/qa/harness.mjs eval '(async () => (await window.electron.getChats()).chats.length)()'`
   - `node scripts/qa/harness.mjs screenshot /tmp/shot.png`
   - For multi-step flows, import the client instead of shelling per call:
     `const { connect } = await import('./scripts/qa/harness.mjs')` →
     `{ evaljs, waitFor, screenshot, send, close }`.
5. `node scripts/qa/harness.mjs stop` — always, when done.

## IPC quirks that waste time if unknown

- Several `AppEventType` union members (`agent:created`, `channel:created`)
  are **never emitted in production code**. To exercise the activity/event
  pipeline, use `sendChatMessage` (emits `message:created`).
- `createAgent` returns the bare agent object, not a `{ success }` envelope.
  Most other IPC returns `{ success, ...payload, error? }` — check per-call
  in `src/main/preload.ts`.
- `getActivityRecentCount` requires a **positive** integer timestamp (Zod
  `.positive()`); `0` fails validation and returns `success: false`.
- UI navigation: sidebar sections are clickable text nodes (e.g. find the
  element whose trimmed innerText is `Activity` and click it); views render
  ~1s after click, prefer `waitFor` over fixed sleeps.

## Safety rails

- Never point the harness at the real profile (`~/.config/eaves`) — the
  fresh-XDG isolation is the whole point. `--fresh` wipes only the scratch
  profile.
- The CDP port is an unauthenticated localhost debug socket. Local runs
  only; never bind beyond 127.0.0.1, never leave an instance running after
  QA (`stop`).
- Headless flags (`--headless=new --disable-gpu`) are default; pass
  `--headed` to watch a run.
