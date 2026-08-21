import { BrowserWindow } from 'electron';
import * as path from 'path';
import { logger } from '../services/logger';
import { recordRenderReport } from '../services/pluginRenderReports';

/**
 * A draft's UI, rendered in a window of its own.
 *
 * Why not just show it in the app: a plugin UI bundle is `import()`ed into the
 * realm of the window that renders it. For an *installed* plugin that is
 * accepted — the user approved it. A draft has not been approved, and the
 * dialog that approves it (windows/pluginConsentWindow.ts) is reachable from
 * the main window's realm. Previewing a draft there would hand unreviewed,
 * agent-written code the ability to script its own approval.
 *
 * So: a separate BrowserWindow, with **no preload at all**. The IPC bridge does
 * not exist in this realm, so draft code cannot reach `promotePluginDraft` — or
 * anything else — no matter what it tries. Navigation and popups are denied too,
 * because a preview has no business going anywhere.
 */

export interface PreviewRequest {
  /** `plugin://draft.<folder>/<entry>` — the draft's UI bundle. */
  bundleUrl: string;
  componentName: string;
  exportType: 'default' | 'named';
  /** Shown in the preview's banner so the window says what it is. */
  name: string;
}

/**
 * Read a render outcome out of a console line, if that is what it is.
 *
 * `sourceId` is the script the line came from, and it is the reason this is
 * worth doing at all: the draft's own bundle shares this realm and could log
 * the same marker, but it logs from `plugin://`, while the preview page logs
 * from the app origin. Rejecting the former makes a draft unable to forge its
 * own verdict without first tricking the preview page into logging for it.
 *
 * A hardening, not a proof. The worst a successful forgery achieves is lying
 * about whether it rendered — it reaches no data and approves nothing.
 */
export function parseRenderMarker(
  message: string,
  sourceId: string,
): { status: 'ok' | 'failed'; message?: string } | null {
  const marker = '[eaves:render]';
  const at = message.indexOf(marker);
  if (at === -1) return null;
  if (sourceId.startsWith('plugin://')) return null;

  try {
    const parsed = JSON.parse(message.slice(at + marker.length)) as {
      status?: unknown;
      message?: unknown;
    };
    if (parsed.status !== 'ok' && parsed.status !== 'failed') return null;
    return {
      status: parsed.status,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    };
  } catch {
    return null; // a line that looks like a marker but is not one
  }
}

/** One window per draft id, so previewing twice focuses rather than piles up. */
const open = new Map<string, BrowserWindow>();

export function showPluginPreview(draftId: string, req: PreviewRequest): void {
  const existing = open.get(draftId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const parent = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());

  const win = new BrowserWindow({
    width: 720,
    height: 560,
    parent: parent ?? undefined,
    show: false,
    title: `Preview — ${req.name}`,
    backgroundColor: '#0a0a0b',
    webPreferences: {
      // No preload: this realm gets no IPC bridge, by design.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // A preview renders. It does not navigate, and it does not open windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // The window has no preload and therefore no way to send anything back. It
  // does not need one: main owns this webContents, so the outcome rides out on
  // a console line. See the report() helper in renderer/preview.tsx.
  win.webContents.on('console-message', (_event, _level, message, _line, sourceId) => {
    const report = parseRenderMarker(message, sourceId);
    if (report) recordRenderReport(draftId, report);
  });

  const params = new URLSearchParams({
    bundle: req.bundleUrl,
    component: req.componentName,
    exportType: req.exportType,
    name: req.name,
    draftId,
  });

  // Resolve against whatever the app itself loaded from, rather than probing
  // for a dev server a second time: if the app is on a Vite port, so is this.
  const appUrl = parent?.webContents.getURL();
  const load = appUrl && appUrl.startsWith('http')
    ? win.loadURL(new URL(`preview.html?${params.toString()}`, appUrl).toString())
    // __dirname is dist/main/main/windows — renderer is at dist/renderer.
    : win.loadFile(path.join(__dirname, '..', '..', '..', 'renderer', 'preview.html'), {
        search: params.toString(),
      });

  load.catch((error: unknown) => {
    logger.error('[PluginPreview] Failed to load the preview page', {
      draftId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => open.delete(draftId));
  open.set(draftId, win);
}

/** Close any preview of this draft — it has been retracted, kept, or rewritten. */
export function closePluginPreview(draftId: string): void {
  const win = open.get(draftId);
  if (win && !win.isDestroyed()) win.close();
  open.delete(draftId);
}
