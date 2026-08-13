# Changelog

Notable changes to Enclave. Everything below 1.0 is alpha — expect the schema,
the plugin API and the IPC surface to move.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/) with the caveat
above: in 0.x, a minor bump can carry breaking changes.

## [0.4.1] — 2026-08-13

A hotfix. 0.4.0 could not open a database created by any earlier build.

### Fixed

- **Upgrading from an earlier version left the app with no window.** The v75
  baseline refused any database below v74, and 0.3.12 — the build most installs
  had — leaves one at v72. The refusal threw before the window was created, so
  the app started, spawned its processes and displayed nothing. Databases from
  v52 onward are now carried forward automatically, with their data intact.
- **A fatal error during startup now says so.** Previously any failure before
  the window opened presented as a silent hang; it now shows a dialog naming the
  problem and where the log is.

### Known limitations

Unchanged from 0.4.0: the builds are unsigned, there is no macOS build, and a
plugin's UI bundle is not sandboxed.

## [0.4.0] — 2026-08-13

First public release, and the first with installers.

### Added

- **Memory.** Core memory blocks an agent maintains itself, an archival store
  with FTS5 full-text search and optional `sqlite-vec` vector search, transcript
  search across every conversation an agent took part in, and on-demand
  summarization of a stretch of one.
- **Automatic compaction** — long histories fold into a running summary instead
  of falling off the end of the context window.
- **Work sessions** — an agent gets its own container for one task and reports
  back to the conversation that asked for it, instead of doing its scratch work
  in a room everyone else has to re-read.
- **Graph workflows** with agent, code, HTTP, scraper, conditional, loop and
  delay nodes; schedulable as cron routines. Agents can author workflows, and
  anything an agent writes is gated behind human review before it can run.
- **Approval batching** — a turn's pending actions are decided together, with
  per-conversation waivers instead of a prompt every time.
- **LAN peer-to-peer sync** between your own devices, with certificate pinning
  at pairing.
- **Compact conversation mode** — one conversation, no app chrome.
- **CI** on every pull request: three TypeScript projects and the full suite.

### Changed

- **Schema squashed to a single v75 baseline.** Databases below v74 are refused
  at startup with an explanation rather than half-migrated. A frozen snapshot of
  the pre-squash schema is what the test suite compares the baseline against, so
  the two cannot drift apart unnoticed.
- Upgraded to electron-builder 26.

### Fixed

- **Packaged builds could ship a native module built for the wrong ABI**, giving
  an app that died at startup with no window and no database. Packaging now
  rebuilds native modules for Electron first.
- **Errors logged inside an object lost their message.** `JSON.stringify` renders
  an `Error` as `{}`, so the one artifact a user could send back was the one with
  the reason removed.
- **Installer filenames did not match their own update manifest**, so
  auto-update could offer a version it would then fail to download.
- **Uninstalling a plugin** derived a directory from its id and deleted it
  without checking the directory belonged to that plugin.
- **Provider keys could be handed to a provider as ciphertext** when the OS
  keychain was unavailable; decryption now fails closed.
- **Plugin config writes** are validated against the keys and types a plugin's
  manifest declares.

### Known limitations

- **The builds are unsigned.** Windows SmartScreen will warn on first run.
- **No macOS build** in this release — it has to be built on a Mac.
- A plugin's UI bundle is not sandboxed; it runs in the renderer with the full
  IPC bridge. See [SECURITY.md](SECURITY.md).

[0.4.1]: https://github.com/mackerson/enclave-ai/releases/tag/v0.4.1
[0.4.0]: https://github.com/mackerson/enclave-ai/releases/tag/v0.4.0
