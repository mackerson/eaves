<!--
Thanks for contributing. CONTRIBUTING.md has the conventions; the short
version is below.
-->

## What and why

<!-- What changed, and what problem it solves. The "why" is the part that
outlives the diff — a reviewer can read the code, but not your reasoning. -->

## How you verified it

<!-- Not "it compiles". What did you actually run? A test, a manual path
through the app, a packaged build? If you couldn't verify something, say so
plainly — an honest gap is more useful than an implied guarantee. -->

## Checklist

- [ ] `yarn typecheck` passes (and `yarn build` if you touched the main process)
- [ ] `yarn test:run` passes
- [ ] Tests added or updated for behaviour changes
- [ ] New IPC handler? Zod schema in `src/shared/validation.ts` + `ipcResult()` wrapper
- [ ] Schema change? A migration, and the parity test still passes
- [ ] Docs updated if a contract changed

## AI assistance

<!-- Optional but appreciated. This project is built with heavy AI assistance
and says so in the README, so there is nothing to apologise for. If an agent
wrote part of this, a Co-Authored-By trailer on the commit is the convention.
You are accountable for the diff either way. -->
