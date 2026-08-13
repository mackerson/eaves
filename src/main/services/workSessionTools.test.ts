import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getWorkSession, completeWorkSession } = vi.hoisted(() => ({
  getWorkSession: vi.fn(),
  completeWorkSession: vi.fn(),
}));

vi.mock('./WorkSessionService', () => ({
  getWorkSession,
  completeWorkSession,
}));

import { createWorkSessionTools } from './workSessionTools';

const exec = async (tool: { execute?: (...args: any[]) => any }, args: unknown) =>
  tool.execute!(args as never, {} as never);

describe('createWorkSessionTools', () => {
  const sessionId = 'ws-1';
  const getMainWindow = vi.fn(() => null);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails when session is missing', async () => {
    getWorkSession.mockReturnValue(null);
    const tools = createWorkSessionTools(sessionId, getMainWindow);
    expect(await exec(tools.complete_work_session, { summary: 'done' })).toEqual({
      success: false,
      error: 'Work session not found',
    });
    expect(completeWorkSession).not.toHaveBeenCalled();
  });

  it('returns reported note when complete succeeds with channel', async () => {
    getWorkSession.mockReturnValue({ id: sessionId });
    completeWorkSession.mockReturnValue({ success: true, reportedTo: 'ch-1' });
    const tools = createWorkSessionTools(sessionId, getMainWindow);
    const result = await exec(tools.complete_work_session, { summary: 'shipped' });
    expect(result).toEqual({
      success: true,
      reportedTo: 'ch-1',
      note: 'Summary posted to the originating channel.',
    });
    expect(completeWorkSession).toHaveBeenCalledWith(sessionId, 'shipped', null);
  });

  it('notes standalone sessions when reportedTo is absent', async () => {
    getWorkSession.mockReturnValue({ id: sessionId });
    completeWorkSession.mockReturnValue({ success: true });
    const tools = createWorkSessionTools(sessionId, getMainWindow);
    const result = await exec(tools.complete_work_session, { summary: 'done' });
    expect(result.success).toBe(true);
    expect(result.reportedTo).toBeNull();
    expect(result.note).toMatch(/standalone/i);
  });

  it('propagates completeWorkSession failure envelope', async () => {
    getWorkSession.mockReturnValue({ id: sessionId });
    completeWorkSession.mockReturnValue({ success: false, error: 'already complete' });
    const tools = createWorkSessionTools(sessionId, getMainWindow);
    expect(await exec(tools.complete_work_session, { summary: 'x' })).toEqual({
      success: false,
      error: 'already complete',
    });
  });
});
