import { describe, it, expect } from 'vitest';
import { perspectiveShiftMessages } from './perspectiveShift';

const AGENT = 'agent-1';

const fromAgent = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content,
  name: `agent_${id}`,
  metadata: { senderType: 'agent', displayName: id === AGENT ? 'Self' : 'Other' },
  ...extra,
});

const fromHuman = (content: string) => ({
  role: 'user',
  content,
  name: 'human_user-1',
  metadata: { senderType: 'human', displayName: 'Miz' },
});

describe('perspectiveShiftMessages', () => {
  it('keeps own messages as assistant and prefixes everyone else', () => {
    const out = perspectiveShiftMessages(
      [fromHuman('hello'), fromAgent(AGENT, 'hi back'), fromAgent('agent-2', 'me too')],
      AGENT,
    );
    expect(out).toEqual([
      { role: 'user', content: '[Miz]: hello' },
      { role: 'assistant', content: 'hi back', toolCalls: undefined },
      { role: 'user', content: '[Other]: me too' },
    ]);
  });

  // Regression: a turn that fails mid-stream persists with empty content (the
  // error lives in a system contentBlock). Replaying it as an empty text block
  // gets the whole request rejected — "text content blocks must be non-empty" —
  // so one failed turn wedged every later turn in the channel.
  it('drops empty-content rows left behind by failed turns', () => {
    const out = perspectiveShiftMessages(
      [fromHuman('hello'), fromAgent(AGENT, ''), fromAgent('agent-2', '   '), fromHuman('still there?')],
      AGENT,
    );
    expect(out).toEqual([{ role: 'user', content: '[Miz]: hello\n\n[Miz]: still there?' }]);
  });

  it('keeps a tools-only own turn when it carries a tool summary', () => {
    const out = perspectiveShiftMessages(
      [
        fromAgent(AGENT, '', {
          responseMessages: [
            { role: 'assistant', content: [{ type: 'tool-call', toolName: 'bash', input: { cmd: 'ls' } }] },
            { role: 'tool', content: [{ type: 'tool-result', toolName: 'bash', output: 'ok' }] },
          ],
        }),
      ],
      AGENT,
    );
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].content).toContain('[tool-call] bash');
    expect(out[0].content).toContain('[tool-result] bash');
  });

  it('merges consecutive same-role messages across a dropped empty row', () => {
    const out = perspectiveShiftMessages(
      [fromAgent(AGENT, 'first'), fromHuman(''), fromAgent(AGENT, 'second')],
      AGENT,
    );
    expect(out).toEqual([{ role: 'assistant', content: 'first\n\nsecond', toolCalls: undefined }]);
  });
});
