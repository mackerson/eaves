import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import * as path from 'path';

/**
 * Plugin-install consent, shown in a modal window owned by the main process.
 *
 * Why a separate window rather than a React modal in the app: plugin UI bundles
 * are import()ed into the main window's renderer, so they share its JS realm and
 * could monkeypatch a renderer-drawn dialog or the IPC call behind it. The
 * marketplace plugin can already invoke `plugin:install` directly, so consent is
 * only meaningful on a surface it cannot script. This window is created by main,
 * renders app-authored HTML, and carries its own minimal preload; the decision
 * is settled here, inside the install path.
 *
 * The page is a self-contained data: URL rather than a file on disk — it needs
 * no build step to be present in both dev and packaged builds, and it can't pull
 * in anything remote. Every interpolated value is escaped (registry metadata is
 * attacker-influenced text).
 *
 * Fails closed: a closed window, a crash, or an unrecognised sender all resolve
 * to "declined".
 */

// Duplicated verbatim in pluginConsentPreload.ts — a sandboxed preload cannot
// import it. Keep both in sync.
const CONSENT_RESPOND_CHANNEL = 'plugin-consent:respond';

export interface ConsentRequest {
  name: string;
  author: string;
  version: string;
  tier?: string;
  homepage: string;
  permissions: string[];
  /** Permissions already consented to, when this is an update rather than a
   *  first install. Anything outside this set is badged as newly requested. */
  priorPermissions?: string[];
}

/**
 * Human-readable labels for every grant in the PluginPermission union
 * (src/shared/types.ts). Kept exhaustive on purpose: an unlabelled grant falls
 * back to its raw id, which reads as noise at exactly the moment the user is
 * being asked to make a trust decision.
 */
const PERMISSION_LABELS: Record<string, string> = {
  'data:agents:read': 'Read your agents',
  'data:projects:read': 'Read your projects',
  'data:channels:read': 'Read your channels',
  'data:chats:read': 'Read your chats',
  'data:settings:read': 'Read your settings',
  'data:tasks:write': 'Create or modify tasks',
  'data:notes:write': 'Create or modify notes',
  'data:messages:write': 'Write messages',
  'data:chats:write': 'Create or modify chats',
  'data:agents:write': 'Create or modify agents',
  'ui:views:register': 'Add its own views to the app',
  'ui:notifications:show': 'Show notifications',
  'events:listen': 'Observe app events',
  'events:emit': 'Emit app events',
  'tools:register': 'Add tools your agents can use',
  'services:register': 'Provide services to other plugins',
  'services:call': 'Use services from other plugins',
  'storage:read': 'Read its own stored data',
  'storage:write': 'Store its own data',
  'network:http': 'Make network requests',
  'system:filesystem': 'Read and write files on your computer',
  // Coarse aliases — legal in a manifest, but the sandbox matches only the
  // granular ids, so these grant nothing. Shown separately, never as capabilities.
  'data:read': 'Read your data',
  'data:write': 'Modify your data',
  'ui:register': 'Add its own UI',
  'storage:access': 'Use its own storage',
  'network:access': 'Use the network',
};

/** The union's own "Dangerous (require explicit grant)" group. */
const ELEVATED = new Set(['network:http', 'system:filesystem']);

/** Grants the sandbox never matches — declaring one confers no access. */
const INERT = new Set(['data:read', 'data:write', 'ui:register', 'storage:access', 'network:access']);

const label = (p: string) => PERMISSION_LABELS[p] || p;

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function permissionRow(p: string, isNew: boolean): string {
  const elevated = ELEVATED.has(p);
  return `<li class="perm${elevated ? ' elevated' : ''}">
    <span class="mark" aria-hidden="true">${elevated ? '&#9888;' : '&middot;'}</span>
    <span class="text">${esc(label(p))}${isNew ? '<span class="badge">NEW</span>' : ''}</span>
  </li>`;
}

function renderHtml(req: ConsentRequest): string {
  const prior = new Set(req.priorPermissions || []);
  const isUpdate = (req.priorPermissions?.length ?? 0) > 0;

  const granted = req.permissions.filter((p) => !INERT.has(p));
  const inert = req.permissions.filter((p) => INERT.has(p));
  // Elevated first — the decision usually turns on those.
  const ordered = [
    ...granted.filter((p) => ELEVATED.has(p)),
    ...granted.filter((p) => !ELEVATED.has(p)),
  ];

  const permList = ordered.length
    ? `<ul class="perms">${ordered.map((p) => permissionRow(p, isUpdate && !prior.has(p))).join('')}</ul>`
    : `<p class="none">No special access.</p>`;

  const inertList = inert.length
    ? `<div class="inert">
         <p class="inert-title">Requested but not granted</p>
         <ul>${inert.map((p) => `<li>${esc(label(p))}</li>`).join('')}</ul>
         <p class="inert-note">The sandbox does not match these, so they confer no access.</p>
       </div>`
    : '';

  const initial = esc((req.name.trim()[0] || '?').toUpperCase());

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Install plugin</title>
<style>
  :root {
    --bg: #ffffff; --fg: #0f172a; --muted: #64748b; --border: #e2e8f0;
    --raised: #f8fafc; --warn: #b45309; --warn-bg: #fffbeb; --accent: #2563eb;
    --accent-fg: #ffffff; --badge-bg: #dbeafe; --badge-fg: #1d4ed8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a; --fg: #e2e8f0; --muted: #94a3b8; --border: #1e293b;
      --raised: #1e293b; --warn: #fbbf24; --warn-bg: #292215; --accent: #3b82f6;
      --accent-fg: #ffffff; --badge-bg: #1e3a8a; --badge-fg: #bfdbfe;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100vh;
    -webkit-user-select: none; user-select: none;
  }
  .head { display: flex; gap: 12px; align-items: flex-start; padding: 18px 20px 14px; }
  .avatar {
    width: 44px; height: 44px; border-radius: 10px; background: var(--raised);
    border: 1px solid var(--border); display: flex; align-items: center;
    justify-content: center; font-size: 18px; font-weight: 600; flex: 0 0 auto;
  }
  .title { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
  .meta { color: var(--muted); font-size: 12px; }
  .tier {
    display: inline-block; border: 1px solid var(--border); border-radius: 999px;
    padding: 0 7px; font-size: 10.5px; text-transform: uppercase;
    letter-spacing: .04em; color: var(--muted); margin-left: 6px; vertical-align: 1px;
  }
  .body { padding: 0 20px 16px; overflow-y: auto; flex: 1 1 auto; }
  .lead { margin: 0 0 8px; color: var(--muted); }
  ul.perms { list-style: none; margin: 0; padding: 0; }
  .perm { display: flex; gap: 8px; padding: 5px 0; align-items: baseline; }
  .perm .mark { color: var(--muted); width: 14px; flex: 0 0 auto; text-align: center; }
  .perm.elevated { color: var(--warn); font-weight: 500; }
  .perm.elevated .mark { color: var(--warn); }
  .badge {
    background: var(--badge-bg); color: var(--badge-fg); border-radius: 4px;
    font-size: 10px; font-weight: 700; padding: 1px 5px; margin-left: 7px;
    letter-spacing: .04em; vertical-align: 1px;
  }
  .none { color: var(--muted); margin: 4px 0; }
  .inert { margin-top: 12px; padding: 9px 11px; background: var(--raised); border-radius: 7px; }
  .inert-title { margin: 0 0 4px; font-size: 11.5px; font-weight: 600; color: var(--muted); }
  .inert ul { margin: 0; padding-left: 16px; color: var(--muted); font-size: 12px; }
  .inert-note { margin: 5px 0 0; font-size: 11px; color: var(--muted); }
  .source {
    margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
    font-size: 11.5px; color: var(--muted); word-break: break-all;
  }
  .source .assure { display: block; margin-top: 3px; word-break: normal; }
  .foot {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 13px 20px; border-top: 1px solid var(--border); background: var(--raised);
  }
  button {
    font: inherit; padding: 6px 15px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 500; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
  <div class="head">
    <div class="avatar">${initial}</div>
    <div>
      <p class="title">${esc(req.name)}<span class="tier">${esc(req.tier || 'plugin')}</span></p>
      <div class="meta">by ${esc(req.author)} &middot; v${esc(req.version)}</div>
    </div>
  </div>
  <div class="body">
    <p class="lead">${isUpdate ? 'After updating, this plugin will be able to:' : 'This plugin will be able to:'}</p>
    ${permList}
    ${inertList}
    <div class="source">
      Source: ${esc(req.homepage || 'unknown')}
      <span class="assure">Downloaded over HTTPS and checksum-verified. Runs sandboxed.</span>
    </div>
  </div>
  <div class="foot">
    <button id="cancel" autofocus>Cancel</button>
    <button id="install" class="primary">${isUpdate ? 'Update' : 'Install'}</button>
  </div>
<script>
  (function () {
    var done = false;
    function respond(ok) {
      if (done) return;
      done = true;
      window.pluginConsent.respond(ok);
    }
    document.getElementById('cancel').addEventListener('click', function () { respond(false); });
    document.getElementById('install').addEventListener('click', function () { respond(true); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') respond(false);
    });
  })();
</script>
</body>
</html>`;
}

/**
 * Pick the window to parent the modal to. Deliberately not `getFocusedWindow()`
 * alone: dev tools open automatically in development and can hold focus, and
 * parenting a modal to a DevTools window makes it die with that window. Skips
 * DevTools and any data: window (a consent window itself).
 */
function pickParent(): BrowserWindow | undefined {
  const usable = (w: BrowserWindow | null | undefined): w is BrowserWindow => {
    if (!w || w.isDestroyed()) return false;
    const url = w.webContents.getURL();
    return !url.startsWith('devtools://') && !url.startsWith('data:');
  };
  const focused = BrowserWindow.getFocusedWindow();
  return usable(focused) ? focused : BrowserWindow.getAllWindows().find(usable);
}

/**
 * Show the consent window and resolve with the user's decision. Resolves false
 * on decline, close, crash, or any failure to present the window — never throws,
 * so a broken dialog can't be mistaken for approval.
 */
export function showPluginConsent(req: ConsentRequest): Promise<boolean> {
  const parent = pickParent();
  const WIDTH = 460;

  const win = new BrowserWindow({
    width: WIDTH,
    // Provisional; replaced by a measurement of the laid-out page before the
    // window is shown, so the frame fits the permission list exactly.
    height: 420,
    parent: parent ?? undefined,
    modal: !!parent,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Install plugin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'pluginConsentPreload.js'),
    },
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(CONSENT_RESPOND_CHANNEL, onRespond);
      if (!win.isDestroyed()) win.close();
      resolve(approved);
    };

    // Only this window's page may answer. Another renderer sending on the same
    // channel — including the main window, where plugin UI code runs — is ignored.
    function onRespond(event: IpcMainEvent, approved: unknown) {
      if (win.isDestroyed() || event.sender !== win.webContents) return;
      settle(approved === true);
    }

    ipcMain.on(CONSENT_RESPOND_CHANNEL, onRespond);

    win.on('closed', () => settle(false));
    win.webContents.on('render-process-gone', () => settle(false));

    // A consent dialog has nowhere legitimate to navigate.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // Size to content. The page is a 100vh flex column, so measuring it as laid
    // out just reports the current window height back — .body is flex-grown and
    // its scrollHeight is the stretched size. Collapse the stretch first, read
    // the intrinsic height, then restore. A long list clamps and scrolls.
    win.once('ready-to-show', async () => {
      try {
        const h = await win.webContents.executeJavaScript(
          `(() => {
             const body = document.body, main = document.querySelector('.body');
             const prev = [body.style.height, main.style.flex, main.style.overflowY];
             body.style.height = 'auto'; main.style.flex = '0 0 auto'; main.style.overflowY = 'visible';
             const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
             body.style.height = prev[0]; main.style.flex = prev[1]; main.style.overflowY = prev[2];
             return h;
           })()`
        );
        if (Number.isFinite(h) && !win.isDestroyed()) {
          win.setContentSize(WIDTH, Math.max(240, Math.min(640, Math.round(h))));
          win.center();
        }
      } catch {
        /* keep the provisional height — never block consent on a measurement */
      }
      if (!win.isDestroyed()) win.show();
    });

    win
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(renderHtml(req)))
      .catch(() => settle(false));
  });
}
