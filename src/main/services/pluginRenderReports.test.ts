/**
 * The loop these close: an agent writes a plugin view, activation says
 * "running", and that was the last thing it ever learned. Running is not
 * rendering, and the difference used to be visible only to whoever was
 * looking at the window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  recordRenderReport,
  getRenderReport,
  clearRenderReport,
  resetRenderReports,
} from './pluginRenderReports';

describe('render reports', () => {
  beforeEach(() => resetRenderReports());

  it('says nothing at all until someone has looked', () => {
    expect(getRenderReport('com.alice.dice')).toBeUndefined();
  });

  it('keeps the failure the preview reported, verbatim', () => {
    recordRenderReport('com.alice.dice', { status: 'failed', message: 'x is not a function' });
    expect(getRenderReport('com.alice.dice')).toMatchObject({
      status: 'failed',
      message: 'x is not a function',
    });
  });

  it('lets a later look replace an earlier one', () => {
    recordRenderReport('com.alice.dice', { status: 'failed', message: 'broken' });
    recordRenderReport('com.alice.dice', { status: 'ok' });
    expect(getRenderReport('com.alice.dice')?.status).toBe('ok');
  });

  it('caps a runaway stack so a report cannot flood a turn', () => {
    recordRenderReport('com.alice.dice', { status: 'failed', message: 'x'.repeat(10_000) });
    expect(getRenderReport('com.alice.dice')!.message!.length).toBe(2000);
  });

  it('forgets a draft on request, so no verdict outlives its code', () => {
    recordRenderReport('com.alice.dice', { status: 'failed', message: 'broken' });
    clearRenderReport('com.alice.dice');
    expect(getRenderReport('com.alice.dice')).toBeUndefined();
  });

  it('keeps drafts apart', () => {
    recordRenderReport('a', { status: 'ok' });
    recordRenderReport('b', { status: 'failed', message: 'nope' });
    expect(getRenderReport('a')?.status).toBe('ok');
    expect(getRenderReport('b')?.status).toBe('failed');
  });
});
