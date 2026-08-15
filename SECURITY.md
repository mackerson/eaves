# Security Policy

## Reporting a vulnerability

Report security issues **privately** — do not open a public issue.

- **Preferred:** open a private report via GitHub — this repo → **Security** →
  *"Report a vulnerability."*
- **Or email:** `security@ackersonlabs.com`

Include what you found, steps to reproduce, the affected version, and impact.
We aim to acknowledge within **3 business days** and to keep you posted through
triage and fix. Please allow reasonable time to remediate before public
disclosure.

## Scope

Eaves is a local-first Electron app. The trust boundary that matters:

- The **main process** is the capability root (filesystem, network, PTY,
  SQLite, provider keys). The **renderer is untrusted;** preload is the only
  bridge, and IPC is Zod-validated.
- A plugin's **backend code runs sandboxed** in a Worker thread, reaching the
  host only through a permission-gated RPC bridge.

### What is not a boundary

Two things are deliberately not boundaries today. Reports that rely on them
are accurate but already known, so we would rather say so up front than have
you spend time on them:

- **A plugin's UI bundle is not sandboxed.** It is imported into the renderer
  and shares the full `window.electron` bridge, so it can call any IPC the app
  itself can — including writing another plugin's declared settings. Plugin UI
  is trusted-by-install. Isolating it needs a per-plugin renderer context,
  which is a design change rather than a patch.
- **Module blocking in the worker is advisory.** The worker's forbidden-module
  list gates `globalThis.require`, which Node's CJS wrapper shadows, and it
  does not see `node:`-prefixed specifiers. The enforced boundaries are the
  worker thread itself, `PermissionGate` on the RPC bridge, and
  `ResourceMonitor`.

Install a plugin the way you would install any code that runs as you.

The most valuable reports show plugin *backend* code escaping the worker
sandbox or its granted permissions, an IPC path that bypasses validation,
arbitrary code execution, or exfiltration of local user data. An issue
confined to a single third-party plugin acting within its granted permissions
belongs in that plugin's own repository.

## Supported versions

Security fixes target the latest release. There is no bug-bounty program at this
time — we're grateful for responsible disclosure.
