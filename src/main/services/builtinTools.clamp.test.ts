import { describe, it, expect, vi } from 'vitest';

// builtinTools transitively loads database.ts (reads app.getPath at load) and
// the event bus / logger. Stub them so the import graph resolves.
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));

import { clampToolStream, MAX_TOOL_STREAM_CHARS } from './builtinTools';

describe('clampToolStream', () => {
  it('passes short output through untouched', () => {
    const s = 'ok\ndone';
    expect(clampToolStream(s)).toBe(s);
    const exact = 'x'.repeat(MAX_TOOL_STREAM_CHARS);
    expect(clampToolStream(exact)).toBe(exact);
  });

  it('truncates oversized output, keeping head and tail with a marker', () => {
    const head = 'HEAD_START' + 'a'.repeat(MAX_TOOL_STREAM_CHARS);
    const body = 'M'.repeat(50_000);
    const text = head + body + 'TAIL_ERROR_END';
    const out = clampToolStream(text);

    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('HEAD_START');            // head preserved
    expect(out).toContain('TAIL_ERROR_END');        // tail (where errors live) preserved
    expect(out).toMatch(/truncated [\d,]+ of [\d,]+ chars/);
    expect(out).not.toContain('M'.repeat(20_000));  // the bulk is gone
  });
});
