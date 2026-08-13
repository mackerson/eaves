import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerWindowHandlers } from './window';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/logger', () => ({
  logger: mockLogger,
  getLogger: () => mockLogger,
}));

function makeWindow() {
  let zoomLevel = 0;
  let fullScreen = false;
  let devToolsOpen = false;
  let maximized = false;
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => false,
    isFullScreen: () => fullScreen,
    setFullScreen: (value: boolean) => { fullScreen = value; },
    // Real window managers apply these asynchronously on Linux; the fake
    // applies them immediately, which is precisely why the handler must not
    // report state it read back straight after asking.
    isMaximized: () => maximized,
    maximize: () => { calls.push('maximize'); maximized = true; },
    unmaximize: () => { calls.push('unmaximize'); maximized = false; },
    minimize: () => { calls.push('minimize'); },
    close: () => { calls.push('close'); },
    webContents: {
      getZoomLevel: () => zoomLevel,
      setZoomLevel: (value: number) => { zoomLevel = value; },
      toggleDevTools: () => { devToolsOpen = !devToolsOpen; },
      isDevToolsOpened: () => devToolsOpen,
    },
  };
}

describe('Window IPC Handlers', () => {
  let handlers: Map<string, Function>;
  let win: ReturnType<typeof makeWindow> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    win = makeWindow();
    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });
    registerWindowHandlers(() => win as any);
  });

  describe('zoom', () => {
    it('steps in and out by one level and reports the factor', async () => {
      expect(await handlers.get('window:zoom-in')!({})).toMatchObject({ level: 1, min: -3, max: 3 });
      expect(await handlers.get('window:zoom-in')!({})).toMatchObject({ level: 2 });
      const out = await handlers.get('window:zoom-out')!({});
      expect(out.level).toBe(1);
      expect(out.factor).toBeCloseTo(1.2, 5);
    });

    it('clamps at the maximum so the UI can never zoom past 3 levels', async () => {
      for (let i = 0; i < 10; i++) await handlers.get('window:zoom-in')!({});
      expect(await handlers.get('window:get-zoom')!({})).toMatchObject({ level: 3 });
      expect(win!.webContents.getZoomLevel()).toBe(3);
    });

    it('clamps at the minimum', async () => {
      for (let i = 0; i < 10; i++) await handlers.get('window:zoom-out')!({});
      expect(await handlers.get('window:get-zoom')!({})).toMatchObject({ level: -3 });
    });

    it('resets to 100%', async () => {
      await handlers.get('window:zoom-in')!({});
      const reset = await handlers.get('window:zoom-reset')!({});
      expect(reset.level).toBe(0);
      expect(reset.factor).toBe(1);
    });

    it('reports a neutral state when there is no window rather than throwing', async () => {
      win = null;
      expect(await handlers.get('window:zoom-in')!({})).toMatchObject({ level: 0 });
      expect(await handlers.get('window:get-zoom')!({})).toMatchObject({ level: 0 });
    });
  });

  describe('fullscreen', () => {
    it('toggles and reports the resulting state', async () => {
      expect(await handlers.get('window:is-fullscreen')!({})).toEqual({ fullscreen: false });
      expect(await handlers.get('window:toggle-fullscreen')!({})).toEqual({ fullscreen: true });
      expect(await handlers.get('window:is-fullscreen')!({})).toEqual({ fullscreen: true });
      expect(await handlers.get('window:toggle-fullscreen')!({})).toEqual({ fullscreen: false });
    });
  });

  describe('devtools', () => {
    it('toggles and reports whether they ended up open', async () => {
      expect(await handlers.get('window:toggle-devtools')!({})).toEqual({ open: true });
      expect(await handlers.get('window:toggle-devtools')!({})).toEqual({ open: false });
    });
  });

  describe('caption buttons', () => {
    it('toggles maximize and restore', async () => {
      expect(await handlers.get('window:is-maximized')!({})).toEqual({ maximized: false });
      await handlers.get('window:toggle-maximize')!({});
      expect(win!.calls).toContain('maximize');
      expect(await handlers.get('window:is-maximized')!({})).toEqual({ maximized: true });
      await handlers.get('window:toggle-maximize')!({});
      expect(win!.calls).toContain('unmaximize');
      expect(await handlers.get('window:is-maximized')!({})).toEqual({ maximized: false });
    });

    // The regression: reading isMaximized() back straight after asking is a
    // guess, because the window manager has not acted yet. Returning it would
    // hand callers a value that is wrong exactly when it matters.
    it('does not report a maximize state it cannot yet know', async () => {
      const result = await handlers.get('window:toggle-maximize')!({});
      expect(result).toEqual({ success: true });
      expect(result).not.toHaveProperty('maximized');
    });

    it('minimizes', async () => {
      expect(await handlers.get('window:minimize')!({})).toEqual({ success: true });
      expect(win!.calls).toContain('minimize');
    });

    // close(), not destroy() — Linux and Windows intercept close to hide to
    // the tray, and the caption button must behave like the native one did.
    it('closes rather than destroying, so tray-hide still applies', async () => {
      expect(await handlers.get('window:close')!({})).toEqual({ success: true });
      expect(win!.calls).toContain('close');
    });

    it('is inert with no window', async () => {
      win = null;
      expect(await handlers.get('window:is-maximized')!({})).toEqual({ maximized: false });
      expect(await handlers.get('window:toggle-maximize')!({})).toEqual({ success: false });
      expect(await handlers.get('window:minimize')!({})).toEqual({ success: true });
    });
  });

  it('never touches a window other than the injected main window', async () => {
    // The handlers take (event, ...) like every ipcMain handler; passing a
    // hostile sender must not give it a way to reach its own webContents.
    const hostile = { sender: makeWindow().webContents };
    await handlers.get('window:zoom-in')!(hostile);
    expect(hostile.sender.getZoomLevel()).toBe(0);
    expect(win!.webContents.getZoomLevel()).toBe(1);
  });
});
