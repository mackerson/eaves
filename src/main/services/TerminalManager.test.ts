import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({ BrowserWindow: class {} }));

const { spawn, spawned } = vi.hoisted(() => {
  const spawned: any[] = [];
  return {
    spawned,
    spawn: vi.fn(() => {
      const proc = {
        onData: vi.fn((cb: (d: string) => void) => { proc._data = cb; }),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        _data: null as null | ((d: string) => void),
      };
      spawned.push(proc);
      return proc;
    }),
  };
});
vi.mock('@lydell/node-pty', () => ({ spawn }));

import { getTerminalManager } from './TerminalManager';

/** Every fake window writes here, so assertions read one ordered log. */
let sentSink: Array<[string, unknown]> = [];

function fakeWindow() {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: {
      send: (channel: string, data: unknown) => { sentSink.push([channel, data]); },
    },
  };
}

describe('TerminalManager', () => {
  let manager: ReturnType<typeof getTerminalManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    spawned.length = 0;
    sentSink = [];
    manager = getTerminalManager();
    manager.cleanup();
  });

  /**
   * The regression: initialize() took the window itself, so after
   * `mainWindow.on('closed')` nulled main.ts's reference and `activate` built a
   * new window, this still held the destroyed one. sendToRenderer guards on
   * isDestroyed(), so PTY output was silently dropped rather than erroring —
   * the reopened terminal was a permanently blank pane.
   */
  it('follows the current window rather than the one it started with', () => {
    let current: any = fakeWindow();
    manager.initialize(() => current);
    manager.createTerminal('t1');

    const emit = spawned[0]._data!;
    emit('before');
    expect(sentSink).toEqual([['terminal:data:t1', 'before']]);

    // Window destroyed, then replaced — exactly the macOS close/reopen path.
    current.destroyed = true;
    sentSink = [];
    emit('while gone');
    expect(sentSink).toEqual([]);

    current = fakeWindow();
    emit('after');
    expect(sentSink).toEqual([['terminal:data:t1', 'after']]);
  });

  it('drops output when there is no window at all', () => {
    manager.initialize(() => null);
    manager.createTerminal('t1');

    expect(() => spawned[0]._data!('orphaned')).not.toThrow();
    expect(sentSink).toEqual([]);
  });

  // A PTY's id only ever existed in the renderer that made it, so once the
  // window is gone nothing can reach the session again. Leaving it running
  // orphans a shell child holding its cwd and any command in flight.
  it('kills every PTY on cleanup', () => {
    manager.initialize(() => fakeWindow());
    manager.createTerminal('t1');
    manager.createTerminal('t2');

    manager.cleanup();

    expect(spawned[0].kill).toHaveBeenCalled();
    expect(spawned[1].kill).toHaveBeenCalled();
    expect(manager.getTerminals()).toEqual([]);
  });

  it('is safe to call cleanup twice', () => {
    manager.initialize(() => fakeWindow());
    manager.createTerminal('t1');

    manager.cleanup();
    expect(() => manager.cleanup()).not.toThrow();
    expect(spawned[0].kill).toHaveBeenCalledTimes(1);
  });

  // Matters most on the quit path: one PTY refusing to die must not strand
  // the rest as orphans.
  it('keeps killing after one PTY refuses', () => {
    manager.initialize(() => fakeWindow());
    manager.createTerminal('t1');
    manager.createTerminal('t2');
    spawned[0].kill.mockImplementation(() => { throw new Error('ESRCH'); });

    manager.cleanup();

    expect(spawned[1].kill).toHaveBeenCalled();
    expect(manager.getTerminals()).toEqual([]);
  });
});
