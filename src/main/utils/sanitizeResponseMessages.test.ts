import { describe, it, expect } from 'vitest';
import { sanitizeResponseMessagesForReplay } from './sanitizeResponseMessages';

describe('sanitizeResponseMessagesForReplay', () => {
  it('passes through balanced tool-call + tool-result', () => {
    const input = [
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'okay' },
          { type: 'tool-call', toolCallId: 'call_a', toolName: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_a', toolName: 'bash', output: 'ok' }],
      },
    ];
    expect(sanitizeResponseMessagesForReplay(input)).toEqual(input);
  });

  // Deleting the call would satisfy the provider but leave the model believing
  // it never tried — so it gets answered instead, and the attempt stays in the
  // conversation where the model can act on it.
  it('answers a dangling tool-call with a failure result', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run a tool' },
          { type: 'tool-call', toolCallId: 'call_dangling', toolName: 'bash', input: {} },
        ],
      },
    ];
    const out = sanitizeResponseMessagesForReplay(input) as Array<{ role: string; content: any[] }>;
    expect(out).toHaveLength(2);
    expect(out[0].content.map(p => p.type)).toEqual(['text', 'tool-call']);
    expect(out[1].role).toBe('tool');
    expect(out[1].content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call_dangling', toolName: 'bash' });
    const notice = out[1].content[0].output.value;
    // Attributed to us, not to bash — the model must not read this as tool output.
    expect(notice).toContain('Reported by Eaves');
    // Reports an unknown outcome, never that nothing happened: a call can run
    // and lose its result, and "nothing ran" reads as licence to redo it.
    expect(notice).toContain('unknown');
    expect(notice).not.toMatch(/nothing was run|no changes were made/i);
  });

  it('keeps a tools-only assistant message, answered', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_only', toolName: 'bash', input: {} },
        ],
      },
      { role: 'user', content: 'follow-up' },
    ];
    const out = sanitizeResponseMessagesForReplay(input) as Array<{ role: string }>;
    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'user']);
  });

  it('drops an orphaned tool-result whose call is missing (Anthropic rejects)', () => {
    // Anthropic /v1/messages: "unexpected `tool_use_id` found in `tool_result`
    // blocks: ... Each `tool_result` block must have a corresponding `tool_use`
    // block in the previous message." Bidirectional sanitize.
    const input = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_orphan', toolName: 'bash', output: 'x' },
        ],
      },
    ];
    expect(sanitizeResponseMessagesForReplay(input)).toEqual([]);
  });

  it('preserves a tool-call/tool-result pair that spans two messages (cross-message linkage)', () => {
    // Pre-fix per-message sanitize broke this case: the call lived on one
    // chat row, the resume continuation persisted the result on a separate
    // row. Sanitize globally so the linkage holds.
    const input = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_a', toolName: 'bash', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_a', toolName: 'bash', output: 'ok' }],
      },
    ];
    expect(sanitizeResponseMessagesForReplay(input)).toEqual(input);
  });

  it('preserveCallIds keeps a dangling tool-call alive (resume path)', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'will run' },
          { type: 'tool-call', toolCallId: 'call_pending', toolName: 'bash', input: {} },
        ],
      },
    ];
    const out = sanitizeResponseMessagesForReplay(input, new Set(['call_pending']));
    expect(out).toEqual(input);
  });

  it('keeps tool messages that contain approval-response parts', () => {
    const input = [
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr_1', approved: true },
        ],
      },
    ];
    expect(sanitizeResponseMessagesForReplay(input)).toEqual(input);
  });

  it('passes through human/system messages untouched', () => {
    const input = [
      { role: 'system', content: 'you are…' },
      { role: 'user', content: 'hi' },
    ];
    expect(sanitizeResponseMessagesForReplay(input)).toEqual(input);
  });

  // Regression: an unresolved approval-pending tool-call leaves BOTH a tool-call
  // and a tool-approval-request for the same id. Dropping only the tool-call
  // left the approval-request behind, so the SDK still demanded a result
  // ("Tool result is missing…") and the thread stayed locked on every send.
  it('drops a moot approval-request but answers the call it belonged to', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running two tools' },
          { type: 'tool-call', toolCallId: 'call_22', toolName: 'bash', input: {} },
          { type: 'tool-approval-request', toolCallId: 'call_22', approvalId: 'appr_22' },
          { type: 'tool-call', toolCallId: 'call_23', toolName: 'bash', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_23', toolName: 'bash', output: 'ok' }],
      },
    ];
    const out = sanitizeResponseMessagesForReplay(input) as any[];
    // The approval-request is gone — the approval is moot once the call is
    // answered, and a lone request still makes the SDK demand a result.
    expect(out[0].content).toEqual([
      { type: 'text', text: 'running two tools' },
      { type: 'tool-call', toolCallId: 'call_22', toolName: 'bash', input: {} },
      { type: 'tool-call', toolCallId: 'call_23', toolName: 'bash', input: {} },
    ]);
    // Both answered in the next message: call_22 synthetically, call_23 for real.
    expect(out[1].content.map((p: any) => p.toolCallId)).toEqual(['call_22', 'call_23']);
    expect(out[1].content[0].output.value).toContain('No result was recorded');
    expect(out[1].content[1]).toEqual({ type: 'tool-result', toolCallId: 'call_23', toolName: 'bash', output: 'ok' });
  });

  // Regression (staggered parallel approvals): two tool-calls in ONE assistant
  // message, each gated on approval. The user decides them one at a time, so
  // each resume runs its own tool and persists that result on its own message
  // row — leaving the results non-adjacent in replayed history. Anthropic then
  // rejects the shared assistant message: "`tool_use` ids were found without
  // `tool_result` blocks immediately after: <second id>".
  it('realigns results so every parallel call is answered in the next message', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_a', toolName: 'edit_file', input: {} },
          { type: 'tool-call', toolCallId: 'call_b', toolName: 'edit_file', input: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_a', output: 'ok' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_c', toolName: 'bash', input: {} }],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_c', output: 'ok' }] },
      // call_b's result landed here, two messages after the call that made it.
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_b', output: 'ok' }] },
    ];
    const out = sanitizeResponseMessagesForReplay(input) as typeof input;

    expect(out).toEqual([
      input[0],
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'call_a', output: 'ok' },
        { type: 'tool-result', toolCallId: 'call_b', output: 'ok' },
      ] },
      input[2],
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_c', output: 'ok' }] },
    ]);
  });

  it('leaves an approval-response in place while realigning results around it', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_a', toolName: 'bash', input: {} },
          { type: 'tool-call', toolCallId: 'call_b', toolName: 'bash', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr_1', approved: true },
          { type: 'tool-result', toolCallId: 'call_a', output: 'ok' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_b', output: 'ok' }] },
    ];
    const out = sanitizeResponseMessagesForReplay(input) as typeof input;

    expect(out).toEqual([
      input[0],
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'call_a', output: 'ok' },
        { type: 'tool-result', toolCallId: 'call_b', output: 'ok' },
      ] },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'appr_1', approved: true }] },
    ]);
  });

  // Regression (wedged thread): a turn that errors mid-stream persists with
  // empty content — the error lives in a system contentBlock — and replays as
  // an empty text block, which Anthropic rejects ("text content blocks must be
  // non-empty"). Every later turn then fails the same way, retry included.
  it('drops messages whose content is empty', () => {
    const input = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'still there?' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ];
    const out = sanitizeResponseMessagesForReplay(input) as typeof input;
    expect(out).toEqual([input[0], input[3]]);
  });

  it('strips an empty text part but keeps the rest of the message', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'tool-call', toolCallId: 'call_a', toolName: 'bash', input: {} },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_a', output: 'ok' }] },
    ];
    const out = sanitizeResponseMessagesForReplay(input) as typeof input;
    expect(out[0].content).toEqual([{ type: 'tool-call', toolCallId: 'call_a', toolName: 'bash', input: {} }]);
    expect(out).toHaveLength(2);
  });

  it('preserveCallIds keeps both the tool-call and its approval-request alive (resume path)', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_pending', toolName: 'bash', input: {} },
          { type: 'tool-approval-request', toolCallId: 'call_pending', approvalId: 'appr_p' },
        ],
      },
    ];
    const out = sanitizeResponseMessagesForReplay(input, new Set(['call_pending']));
    expect(out).toEqual(input);
  });
});

/**
 * A call that stopped for a human is not a call that failed, and the
 * difference is the whole reason these two messages exist.
 *
 * An agent given the generic "outcome unknown, check state before repeating"
 * notice for a pending approval does the reasonable thing with bad
 * information: it goes looking for a race. One filed a detailed, confident,
 * wrong bug report that way — parallel writes were "dropping results" when
 * they were sitting in an approval queue.
 */
describe('a call waiting on approval says so', () => {
  const threeGatedCalls = () => [
    { role: 'user', content: 'write three files' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'write_file', input: {} },
        { type: 'tool-call', toolCallId: 'b', toolName: 'write_file', input: {} },
        { type: 'tool-call', toolCallId: 'c', toolName: 'write_file', input: {} },
        { type: 'tool-approval-request', toolCallId: 'a', approvalId: 'ap-a' },
        { type: 'tool-approval-request', toolCallId: 'b', approvalId: 'ap-b' },
        { type: 'tool-approval-request', toolCallId: 'c', approvalId: 'ap-c' },
      ],
    },
  ];

  const resultsFrom = (out: unknown[]) => {
    const found: Record<string, string> = {};
    for (const m of out as Array<{ role: string; content: unknown }>) {
      if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
      for (const p of m.content as Array<{ toolCallId: string; output?: { value?: string } }>) {
        found[p.toolCallId] = String(p.output?.value ?? '');
      }
    }
    return found;
  };

  // Resuming one approval is what the inline card does. Its siblings are still
  // pending, and must be described as pending — not as lost.
  it('tells the siblings of a resumed approval that they are waiting, not lost', () => {
    // 'a' is being resumed; 'b' and 'c' are still in the queue.
    const out = sanitizeResponseMessagesForReplay(threeGatedCalls(), new Set(['a']), new Set(['b', 'c']));
    const results = resultsFrom(out);

    expect(results.b).toMatch(/waiting for a person to approve/i);
    expect(results.c).toMatch(/waiting for a person to approve/i);
    expect(results.b).toMatch(/has NOT run/);
    // The call being resumed is answered by its approval-response, not here.
    expect(results.a).toBeUndefined();
  });

  it('never tells an approval-pending call that its outcome is unknown', () => {
    const results = resultsFrom(sanitizeResponseMessagesForReplay(threeGatedCalls(), new Set(['a']), new Set(['b', 'c'])));
    for (const id of ['b', 'c']) {
      expect(results[id]).not.toMatch(/Whether the call ran is unknown/);
      expect(results[id]).not.toMatch(/Check the current state before repeating/);
    }
  });

  it('tells it not to repeat, re-check, or work around', () => {
    const results = resultsFrom(sanitizeResponseMessagesForReplay(threeGatedCalls(), new Set(['a']), new Set(['b', 'c'])));
    expect(results.b).toMatch(/Do not repeat it/);
    expect(results.b).toMatch(/do not check whether it happened/i);
    expect(results.b).toMatch(/do not work around it/i);
  });

  // The generic notice still has a job: a turn that died mid-flight really is
  // of unknown outcome, and saying otherwise would invite a double-apply.
  it('still reports unknown for a call that never asked for approval', () => {
    const out = sanitizeResponseMessagesForReplay([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'bash', input: {} }],
      },
    ], new Set());

    const results = resultsFrom(out);
    expect(results.x).toMatch(/Whether the call ran is unknown/);
    expect(results.x).not.toMatch(/waiting for a person/i);
  });

  it('leaves a call that already has a real result alone', () => {
    const out = sanitizeResponseMessagesForReplay([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 'write_file', input: {} },
          { type: 'tool-approval-request', toolCallId: 'a', approvalId: 'ap-a' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'write_file', output: { type: 'text', value: 'written' } }],
      },
    ], new Set());

    expect(resultsFrom(out).a).toBe('written');
  });
  // The one the existing "moot approval-request" test protects: an approval a
  // newer message overtook is NOT pending, and must keep the honest unknown
  // wording. Nobody is coming to decide it.
  it('reports unknown for an approval that was overtaken, not pending', () => {
    const out = sanitizeResponseMessagesForReplay(threeGatedCalls(), new Set(['a']), new Set());
    const results = resultsFrom(out);
    expect(results.b).toMatch(/Whether the call ran is unknown/);
    expect(results.b).not.toMatch(/waiting for a person/i);
  });
});
