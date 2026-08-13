# Contributing to Enclave

Thanks for your interest in improving Enclave. This guide covers how to get set
up, the conventions we follow, and how to get a change merged.

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

- **Found a security issue?** Do **not** open a public issue — see
  [SECURITY.md](./SECURITY.md) for private reporting.
- **Small fix** (typo, obvious bug, docs)? Open a PR directly.
- **Larger change** (new feature, refactor, dependency, schema/migration)? Open
  an issue first so we can align on direction before you invest the work.
- **Using an AI agent?** Fine — this project is built that way, see
  [AI use](./README.md#ai-use). Disclose it with a `Co-Authored-By` trailer,
  and hold it to the same bar as anything else here: you are accountable for
  the diff, not the tool.

## Development setup

Enclave is an Electron + React + TypeScript app. You'll need:

- **Node 22** (pinned in [`.nvmrc`](./.nvmrc) — `nvm use` picks it up)
- **Yarn (classic, 1.x)**

```bash
git clone https://github.com/mackerson/enclave-ai.git
cd enclave-ai
yarn install          # installs deps + rebuilds better-sqlite3 for Electron
yarn setup:plugins    # clones the bundled plugin repos + symlinks them
yarn dev:clean        # clean any orphaned dev processes, then start dev mode
```

Native module rebuilds are automatic — `predev` rebuilds better-sqlite3 for
Electron and `pretest` rebuilds it for system Node, so you don't switch by hand.

## Build & test

```bash
yarn build                                   # full production build
yarn test:run                                # run the test suite once
yarn vitest run src/main/repositories/AgentRepository.test.ts   # a single file
yarn tsc -p tsconfig.json --noEmit           # typecheck the renderer
```

Before opening a PR, make sure the typecheck is clean and the tests pass. If your
change has a runtime surface, exercise it — don't rely on "it compiles."

## Making changes

- **Keep diffs minimal and surgical.** Don't reformat or refactor code the change
  doesn't touch.
- **Match the surrounding style.** Explicit over clever; readable over terse.
- **Comment the *why*, not the *what*.** No narration of obvious code.
- **Add tests** for behavior changes, and update docs when you change a contract.
- **New IPC handler?** Add a Zod schema in `src/shared/validation.ts` and use the
  `ipcResult()` wrapper (see [CLAUDE.md](./CLAUDE.md) for the patterns).

## Commits & pull requests

- We use **[Conventional Commits](https://www.conventionalcommits.org/)** —
  `feat(scope): …`, `fix(scope): …`, `docs:`, `test:`, `chore:`, `perf:`,
  `security:`. One logical change per commit; imperative mood.
- Branch off `main`, push to your fork, and open a PR against `main`.
- In the PR description, say **what** changed and **why**, and how you verified it.
- Keep PRs focused — a 40-file grab-bag is hard to review; split unrelated work.

## Project layout

- [`docs/development.md`](./docs/development.md) — clone, scripts, data
  locations, and migrations.
- [`CLAUDE.md`](./CLAUDE.md) — the authoritative guide to the stack, build
  commands, and core patterns (IPC, repositories, the plugin sandbox).
- [`docs/architecture/README.md`](./docs/architecture/README.md) — architecture
  diagrams and invariants.

## Plugins

Plugins live in their own repositories (`enclave-plugin-*`) and run sandboxed in
Worker Threads. If you're building a plugin rather than changing the core app,
start with **[docs/plugin-development.md](./docs/plugin-development.md)** — the
manifest, the `context` API, permissions, and a worked example. You don't need a
full Enclave dev build to develop one.

## Questions

Open a [discussion or issue](https://github.com/mackerson/enclave-ai/issues) —
we're happy to help you land your first contribution.
