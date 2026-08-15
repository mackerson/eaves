import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/eaves-test', isPackaged: true },
}));

import { scanTurnFailures, failureSection } from './replayProjection';

const human = (content: string) => ({ senderType: 'human', senderId: 'user-1', content });
const agent = (content: string) => ({
  senderType: 'agent', senderId: 'agent-1', content,
  contentBlocks: [{ type: 'text', content }],
});
/** How a turn that died mid-stream is persisted: the error in a system block. */
const failed = (reason: string, partial = '') => ({
  senderType: 'agent', senderId: 'agent-1',
  content: partial ? `${partial}\n\n[Error: ${reason}]` : '',
  contentBlocks: [
    ...(partial ? [{ type: 'text', content: partial }] : []),
    { type: 'system', content: `Error: ${reason}` },
  ],
});

describe('scanTurnFailures', () => {
  it('leaves a healthy conversation alone', () => {
    const rows = [human('hi'), agent('hello')];
    const scan = scanTurnFailures(rows);
    expect(scan.rows).toEqual(rows);
    expect(scan.unresolved).toEqual([]);
  });

  it('pulls a failed turn out of history and reports it', () => {
    const scan = scanTurnFailures([human('hi'), failed('overloaded')]);
    expect(scan.rows).toEqual([human('hi')]);
    expect(scan.unresolved).toEqual(['overloaded']);
  });

  // The model produced real text before the stream died. That text is genuine
  // output and stays; only the error notice comes out.
  it('keeps partial output but strips the error notice', () => {
    const scan = scanTurnFailures([human('hi'), failed('connection lost', 'Let me check that')]);
    expect(scan.rows).toHaveLength(2);
    expect(scan.rows[1].content).toBe('Let me check that');
    expect(scan.rows[1].contentBlocks.map((b: any) => b.type)).toEqual(['text']);
    expect(scan.unresolved).toEqual(['connection lost']);
  });

  // Once the agent replies successfully the failure is history — the model
  // moved on, and a stale warning just competes for attention.
  it('clears failures once a later turn succeeds', () => {
    const scan = scanTurnFailures([
      human('hi'), failed('overloaded'), human('again?'), agent('here now'),
    ]);
    expect(scan.unresolved).toEqual([]);
    expect(scan.rows.map(r => r.senderType)).toEqual(['human', 'human', 'agent']);
  });

  it('reports failures again if the thread re-breaks after recovering', () => {
    const scan = scanTurnFailures([
      failed('first'), agent('recovered'), failed('second'),
    ]);
    expect(scan.unresolved).toEqual(['second']);
  });

  it('caps how many it reports, keeping the most recent', () => {
    const scan = scanTurnFailures(
      [failed('a'), failed('b'), failed('c'), failed('d')],
      2,
    );
    expect(scan.unresolved).toEqual(['c', 'd']);
  });

  // A channel dispatch failure persists '[Error: …]' as the whole content.
  // Left in, it reaches other participants as though the agent said it.
  it('removes a channel dispatch failure from the message stream', () => {
    const dispatchFailure = {
      senderType: 'agent', senderId: 'agent-1',
      content: '[Error: Cannot reach the model server]',
      contentBlocks: [{ type: 'system', content: 'Error: Cannot reach the model server' }],
    };
    const scan = scanTurnFailures([human('ping'), dispatchFailure]);
    expect(scan.rows).toEqual([human('ping')]);
    expect(scan.unresolved).toEqual(['Cannot reach the model server']);
  });

  it('ignores a human row that happens to mention an error', () => {
    const rows = [human('Error: something broke on my end, any ideas?')];
    const scan = scanTurnFailures(rows);
    expect(scan.rows).toEqual(rows);
    expect(scan.unresolved).toEqual([]);
  });
});

describe('failureSection', () => {
  it('is empty when nothing is unresolved', () => {
    expect(failureSection([])).toBe('');
  });

  it('states what happened without prescribing a retry', () => {
    const section = failureSection(['overloaded']);
    expect(section).toContain('Interrupted turns');
    expect(section).toContain('overloaded');
    expect(section).toContain('The user did not see them');
    // Retrying is right for an overload and wrong for a malformed request;
    // the model decides from context, we don't push it either way.
    expect(section.toLowerCase()).not.toContain('try again');
    expect(section.toLowerCase()).not.toContain('retry');
  });

  it('appends as a suffix so the cached system-prompt prefix still hits', () => {
    expect(failureSection(['x']).startsWith('\n\n')).toBe(true);
  });
});
