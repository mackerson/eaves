import { ipcMain, BrowserWindow } from 'electron';
import { ipcResult } from '../utils/ipcValidation';
import type { ZoomLevelState } from '../../shared/ipc-types';

/**
 * Chromium's zoom levels are exponential: factor = 1.2 ^ level. Clamping to
 * ±3 keeps the app between ~58% and ~173% — far enough to matter on a 4K
 * panel or with tired eyes, close enough that the layout still works and a
 * user can always find the menu item that undoes it. An unclamped zoom is a
 * one-keystroke way to make the app unusable with no visible way back.
 */
const MIN_ZOOM_LEVEL = -3;
const MAX_ZOOM_LEVEL = 3;
const ZOOM_STEP = 1;

function zoomFactorFor(level: number): number {
  return Math.pow(1.2, level);
}

function clampZoom(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level));
}

/**
 * Window-scoped view controls (zoom / fullscreen / devtools) for the View menu.
 *
 * Every handler acts on the app's own main window via the injected getter —
 * never on `event.sender` or a renderer-supplied window id — so a compromised
 * renderer (or a plugin webview reaching the bridge) cannot drive some other
 * window's contents or open devtools somewhere it has no business being.
 */
export function registerWindowHandlers(getMainWindow: () => BrowserWindow | null) {
  const liveWindow = (): BrowserWindow | null => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  const zoomState = (level: number): ZoomLevelState => ({
    level,
    factor: zoomFactorFor(level),
    min: MIN_ZOOM_LEVEL,
    max: MAX_ZOOM_LEVEL,
  });

  // Reads the live level rather than a cached one: Chromium owns zoom state and
  // resets it on cross-origin navigation, so our copy could drift and then
  // "zoom in" would jump instead of step.
  const applyZoom = (next: (current: number) => number): ZoomLevelState => {
    const win = liveWindow();
    if (!win) return zoomState(0);
    const current = clampZoom(Math.round(win.webContents.getZoomLevel()));
    const level = clampZoom(next(current));
    win.webContents.setZoomLevel(level);
    return zoomState(level);
  };

  ipcMain.handle('window:zoom-in', ipcResult('window:zoom-in', async (): Promise<ZoomLevelState> => {
    return applyZoom(current => current + ZOOM_STEP);
  }));

  ipcMain.handle('window:zoom-out', ipcResult('window:zoom-out', async (): Promise<ZoomLevelState> => {
    return applyZoom(current => current - ZOOM_STEP);
  }));

  ipcMain.handle('window:zoom-reset', ipcResult('window:zoom-reset', async (): Promise<ZoomLevelState> => {
    return applyZoom(() => 0);
  }));

  ipcMain.handle('window:get-zoom', ipcResult('window:get-zoom', async (): Promise<ZoomLevelState> => {
    const win = liveWindow();
    if (!win) return zoomState(0);
    return zoomState(clampZoom(Math.round(win.webContents.getZoomLevel())));
  }));

  ipcMain.handle('window:toggle-fullscreen', ipcResult('window:toggle-fullscreen', async () => {
    const win = liveWindow();
    if (!win) return { fullscreen: false };
    win.setFullScreen(!win.isFullScreen());
    return { fullscreen: win.isFullScreen() };
  }));

  ipcMain.handle('window:is-fullscreen', ipcResult('window:is-fullscreen', async () => {
    const win = liveWindow();
    return { fullscreen: win ? win.isFullScreen() : false };
  }));

  ipcMain.handle('window:toggle-devtools', ipcResult('window:toggle-devtools', async () => {
    const win = liveWindow();
    if (!win) return { open: false };
    win.webContents.toggleDevTools();
    return { open: win.webContents.isDevToolsOpened() };
  }));

  // Caption buttons. Linux runs frameless, so the renderer draws minimise /
  // maximise / close and needs a way to actually perform them. Windows keeps
  // the OS-drawn overlay buttons and never calls these.
  ipcMain.handle('window:minimize', ipcResult('window:minimize', async () => {
    liveWindow()?.minimize();
    return { success: true };
  }));

  // Returns only whether the request was issued, not the resulting state:
  // on Linux the window manager applies maximise asynchronously, so
  // isMaximized() read straight after maximize() still reports the old value
  // and a state-shaped return would simply be wrong. The truth arrives on
  // 'window:maximize-changed', which also covers WM-initiated tiling.
  ipcMain.handle('window:toggle-maximize', ipcResult('window:toggle-maximize', async () => {
    const win = liveWindow();
    if (!win) return { success: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { success: true };
  }));

  ipcMain.handle('window:is-maximized', ipcResult('window:is-maximized', async () => {
    return { maximized: liveWindow()?.isMaximized() ?? false };
  }));

  // Deliberately close() rather than destroy(): on Linux and Windows the app
  // intercepts close to hide to the tray (see main.ts), and a caption button
  // that quits when the native one would have hidden is a different button.
  ipcMain.handle('window:close', ipcResult('window:close', async () => {
    liveWindow()?.close();
    return { success: true };
  }));
}
