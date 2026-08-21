/**
 * The preview window's whole reason to exist is isolation, and isolation is
 * exactly the kind of property that regresses silently — a preload added for
 * convenience, a navigation handler dropped in a refactor. So it is asserted
 * here rather than left to review.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Handler = (...args: any[]) => void;

class FakeWindow {
  static created: FakeWindow[] = [];
  opts: any;
  destroyed = false;
  shown = false;
  focused = false;
  loadedUrl: string | null = null;
  loadedFile: { file: string; options?: any } | null = null;
  windowOpenHandler: (() => { action: string }) | null = null;
  contentsHandlers = new Map<string, Handler>();
  handlers = new Map<string, Handler>();
  url = 'http://localhost:5173/index.html';

  webContents = {
    setWindowOpenHandler: (fn: () => { action: string }) => { this.windowOpenHandler = fn; },
    on: (event: string, fn: Handler) => { this.contentsHandlers.set(event, fn); },
    getURL: () => this.url,
  };

  constructor(opts: any) {
    this.opts = opts;
    FakeWindow.created.push(this);
  }
  isDestroyed() { return this.destroyed; }
  focus() { this.focused = true; }
  show() { this.shown = true; }
  close() { this.destroyed = true; this.handlers.get('closed')?.(); }
  once(event: string, fn: Handler) { this.handlers.set(event, fn); }
  on(event: string, fn: Handler) { this.handlers.set(event, fn); }
  loadURL(url: string) { this.loadedUrl = url; return Promise.resolve(); }
  loadFile(file: string, options?: any) { this.loadedFile = { file, options }; return Promise.resolve(); }
}

let allWindows: FakeWindow[] = [];
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(
    function (this: any, opts: any) { return new FakeWindow(opts); } as any,
    { getAllWindows: () => allWindows },
  ),
}));

import { showPluginPreview, closePluginPreview, parseRenderMarker } from './pluginPreviewWindow';

const request = {
  bundleUrl: 'plugin://draft.com-alice-sketch/ui/index.js',
  componentName: 'Sketch',
  exportType: 'named' as const,
  name: 'Sketch',
};

describe('showPluginPreview', () => {
  let parent: FakeWindow;

  beforeEach(() => {
    FakeWindow.created = [];
    parent = new FakeWindow({});
    FakeWindow.created = [];
    allWindows = [parent];
    closePluginPreview('com.alice.sketch');
  });

  const preview = () => FakeWindow.created[FakeWindow.created.length - 1];

  it('creates the window with no preload, so the realm has no IPC bridge', () => {
    showPluginPreview('com.alice.sketch', request);

    const web = preview().opts.webPreferences;
    expect(web.preload).toBeUndefined();
    expect(web.contextIsolation).toBe(true);
    expect(web.nodeIntegration).toBe(false);
    expect(web.sandbox).toBe(true);
    expect(web.webSecurity).toBe(true);
  });

  it('denies popups and navigation', () => {
    showPluginPreview('com.alice.sketch', request);

    expect(preview().windowOpenHandler?.()).toEqual({ action: 'deny' });

    const navigate = preview().contentsHandlers.get('will-navigate');
    expect(navigate).toBeDefined();
    const event = { preventDefault: vi.fn() };
    navigate!(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('resolves the page against whatever the app itself loaded from', () => {
    showPluginPreview('com.alice.sketch', request);

    const url = new URL(preview().loadedUrl!);
    expect(url.origin).toBe('http://localhost:5173');
    expect(url.pathname).toBe('/preview.html');
    expect(url.searchParams.get('bundle')).toBe(request.bundleUrl);
    expect(url.searchParams.get('component')).toBe('Sketch');
    expect(url.searchParams.get('exportType')).toBe('named');
  });

  it('loads from disk when the app is not on a dev server', () => {
    parent.url = 'file:///opt/eaves/dist/renderer/index.html';
    showPluginPreview('com.alice.sketch', request);

    expect(preview().loadedFile?.file).toMatch(/renderer[/\\]preview\.html$/);
    expect(preview().loadedFile?.options.search).toContain('component=Sketch');
  });

  it('focuses the existing window rather than stacking a second one', () => {
    showPluginPreview('com.alice.sketch', request);
    const first = preview();
    showPluginPreview('com.alice.sketch', request);

    expect(FakeWindow.created).toHaveLength(1);
    expect(first.focused).toBe(true);
  });

  it('opens a fresh window after the previous one was closed', () => {
    showPluginPreview('com.alice.sketch', request);
    closePluginPreview('com.alice.sketch');
    showPluginPreview('com.alice.sketch', request);

    expect(FakeWindow.created).toHaveLength(2);
  });
});

/**
 * The preview window has no preload, so its verdict rides out on a console
 * line. `sourceId` is what stops the draft's own bundle forging one: the
 * preview page logs from the app origin, plugin code logs from `plugin://`.
 */
describe('parseRenderMarker', () => {
  const APP = 'http://localhost:5173/assets/preview-abc.js';
  const PLUGIN = 'plugin://draft.com-alice-dice/ui/index.js';
  const line = (payload: unknown) => `[eaves:render] ${JSON.stringify(payload)}`;

  it('reads a success', () => {
    expect(parseRenderMarker(line({ status: 'ok' }), APP)).toEqual({ status: 'ok', message: undefined });
  });

  it('reads a failure and its detail', () => {
    expect(parseRenderMarker(line({ status: 'failed', message: 'boom' }), APP))
      .toEqual({ status: 'failed', message: 'boom' });
  });

  it('ignores the same marker logged by the plugin bundle', () => {
    expect(parseRenderMarker(line({ status: 'ok' }), PLUGIN)).toBeNull();
  });

  it('ignores ordinary console output', () => {
    expect(parseRenderMarker('Warning: each child needs a key', APP)).toBeNull();
  });

  it('ignores a marker with nothing parseable after it', () => {
    expect(parseRenderMarker('[eaves:render] not json', APP)).toBeNull();
  });

  it('ignores a status it does not recognise', () => {
    expect(parseRenderMarker(line({ status: 'maybe' }), APP)).toBeNull();
  });
});
