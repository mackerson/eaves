import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/eaves-test', isPackaged: true },
}));

// Compaction reaches for the DB and an LLM; neither is what these tests are
// about. Pass history through untouched so the assertions see the real
// projection + repair output.
vi.mock('./compaction', () => ({
  maybeCompactHistory: async (opts: { messages: unknown[] }) => ({ messages: opts.messages, didCompact: false }),
  summarySection: (s: string) => s,
}));

import { assembleReplayHistory, findReplayViolations } from './replayHistory';
import { projectChatHistory } from './replayProjection';
import type { AttachmentLoaders } from './replayProjection';
import wedgedChatRows from './__fixtures__/wedged-chat-rows.json';

const agent = { id: 'agent-1', name: 'Claude', provider: 'anthropic', model: 'claude-opus-4-8' } as never;
const budget = { messageBudget: 1_000_000, contextWindow: 200_000, sizeClass: 'large', systemPromptBudget: 10_000 } as never;
const noLoaders: AttachmentLoaders = { loadImageAsBase64: () => null, loadAttachmentText: () => null };

const assemble = (rows: any[], preserveCallIds?: Set<string>) => {
  const { messages } = projectChatHistory(rows, noLoaders);
  return assembleReplayHistory({
    agent, containerId: 'chat-1', budget, messages, preserveCallIds, source: 'test',
  });
};

const call = (id: string, name = 'edit_file') => ({ type: 'tool-call', toolCallId: id, toolName: name, input: {} });
const result = (id: string) => ({ type: 'tool-result', toolCallId: id, output: 'ok' });
const agentRow = (responseMessages: unknown[], content = '') => ({
  senderType: 'agent', senderId: 'agent-1', content, responseMessages,
});
const humanRow = (content: string) => ({
  senderType: 'human', senderId: 'user-1', content, contentBlocks: [{ type: 'text', content }],
});

describe('replay assembly, from stored rows', () => {
  it('keeps a clean tool conversation intact', async () => {
    const { messages, violations } = await assemble([
      humanRow('look at the repo'),
      agentRow([
        { role: 'assistant', content: [{ type: 'text', text: 'on it' }, call('c1', 'bash')] },
        { role: 'tool', content: [result('c1')] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ], 'done'),
    ]);
    expect(violations).toEqual([]);
    expect(messages).toHaveLength(4);
  });

  // The production failure this whole module exists for. Two approval-gated
  // calls in ONE assistant turn, decided one at a time: each resume ran its
  // own tool and persisted that result on its own row, so replay interleaved
  // them and Anthropic rejected the shared assistant message —
  // "`tool_use` ids were found without `tool_result` blocks immediately
  // after". Every later turn in that chat then failed the same way.
  it('survives parallel approvals resolved across separate rows', async () => {
    const rows = [
      humanRow('take it for a spin'),
      agentRow([
        { role: 'assistant', content: [{ type: 'text', text: 'two edits coming' }, call('cA'), call('cB')] },
      ]),
      // First resume: answers cA, makes its own call, answers that too.
      agentRow([
        { role: 'tool', content: [result('cA')] },
        { role: 'assistant', content: [call('cC', 'bash')] },
        { role: 'tool', content: [result('cC')] },
      ]),
      // Second resume: answers cB — four messages after the call that made it.
      agentRow([
        { role: 'tool', content: [result('cB')] },
        { role: 'assistant', content: [{ type: 'text', text: 'both edits landed' }] },
      ], 'both edits landed'),
    ];

    const { messages, violations } = await assemble(rows);
    expect(violations).toEqual([]);

    // cA and cB are answered together, in the message right after their call.
    const answering = messages[2] as { role: string; content: Array<{ toolCallId: string }> };
    expect(answering.role).toBe('tool');
    expect(answering.content.map(p => p.toolCallId)).toEqual(['cA', 'cB']);
  });

  // The second half of the same production failure: a turn that dies
  // mid-stream persists with empty content (the error lives in a system
  // contentBlock), replays as an empty text block, and gets the request
  // rejected — which persists another empty row. Retry can't clear it.
  it('does not wedge on the empty rows a failed turn leaves behind', async () => {
    const errorRow = {
      senderType: 'agent', senderId: 'agent-1', content: '',
      contentBlocks: [{ type: 'system', content: 'Error: overloaded' }],
    };
    const { messages, violations } = await assemble([
      humanRow('hello'),
      errorRow, errorRow, errorRow,
      humanRow('still there?'),
      errorRow,
    ]);
    expect(violations).toEqual([]);
    expect(messages.map((m: any) => m.role)).toEqual(['user', 'user']);
  });

  it('tells the model about a call that was approved but never ran', async () => {
    const { messages, violations } = await assemble([
      humanRow('edit it'),
      agentRow([
        { role: 'assistant', content: [{ type: 'text', text: 'editing' }, call('never')] },
      ]),
    ]);
    expect(violations).toEqual([]);
    const assistant = messages[1] as { content: Array<{ type: string }> };
    expect(assistant.content.map(p => p.type)).toEqual(['text', 'tool-call']);
    const answer = messages[2] as { role: string; content: Array<{ output: { value: string } }> };
    expect(answer.role).toBe('tool');
    expect(answer.content[0].output.value).toContain('No result was recorded');
  });

  it('keeps the pending call alive on the resume path', async () => {
    const { messages, violations } = await assemble([
      humanRow('edit it'),
      agentRow([
        { role: 'assistant', content: [call('pending'), { type: 'tool-approval-request', toolCallId: 'pending', approvalId: 'a1' }] },
      ]),
    ], new Set(['pending']));
    expect(violations).toEqual([]);
    const assistant = messages[1] as { content: Array<{ type: string }> };
    expect(assistant.content.map(p => p.type)).toEqual(['tool-call', 'tool-approval-request']);
  });

  it('is idempotent — re-assembling its own output changes nothing', async () => {
    const rows = [
      humanRow('go'),
      agentRow([
        { role: 'assistant', content: [call('cA'), call('cB')] },
      ]),
      agentRow([{ role: 'tool', content: [result('cA')] }]),
      agentRow([{ role: 'tool', content: [result('cB')] }], 'done'),
    ];
    const first = await assemble(rows);
    const second = await assembleReplayHistory({
      agent, containerId: 'chat-1', budget, messages: first.messages, source: 'test',
    });
    expect(second.messages).toEqual(first.messages);
    expect(second.violations).toEqual([]);
  });
});

// A real conversation that wedged in beta, exported from the DB with all text
// replaced by "redacted" — the structure is the point. Keeping it as a fixture
// means the exact shape that got past us stays covered.
describe('the conversation that wedged in beta', () => {
  const rows = wedgedChatRows as any[];

  // [15]/[19] are the staggered parallel approvals — the pair the provider
  // actually named before it stopped looking. [17]/[20] are calls left pending
  // or approved-but-never-run once the thread jammed. The rest is the pile of
  // empty rows each failed turn added.
  it('violates the provider rules as stored', () => {
    const { messages } = projectChatHistory(rows, noLoaders);
    expect(findReplayViolations(messages)).toEqual([
      '[15] tool-call unanswered by the next message: toolu_01SaGDSQ5QrvyLN4KWd2GXjX',
      '[17] tool-call unanswered by the next message: toolu_01APZLEZmABTAjURhiM6TH8W',
      '[19] tool-result with no call in the previous message: toolu_01SaGDSQ5QrvyLN4KWd2GXjX',
      '[20] tool-call unanswered by the next message: toolu_01Pf1TKtL7GCXZi3de6YG516, toolu_013tyoS38idG3erxboKV7QyS',
      '[21] assistant: empty content',
      '[22] assistant: empty content',
      '[23] assistant: empty content',
      '[24] assistant: empty content',
      '[25] assistant: empty content',
      '[27] assistant: empty content',
    ]);
  });

  it('assembles clean', async () => {
    const { messages, violations } = await assemble(rows);
    expect(violations).toEqual([]);
    expect(messages.length).toBeLessThan(rows.length * 3);
  });
});

describe('findReplayViolations', () => {
  it('names an unanswered tool-call', () => {
    expect(findReplayViolations([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x' }] },
      { role: 'user', content: 'next' },
    ])).toEqual(['[0] tool-call unanswered by the next message: x']);
  });

  it('names an orphan tool-result', () => {
    expect(findReplayViolations([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'y' }] },
    ])).toEqual(['[1] tool-result with no call in the previous message: y']);
  });

  it('names empty content', () => {
    expect(findReplayViolations([
      { role: 'assistant', content: '' },
      { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
    ])).toEqual(['[0] assistant: empty content', '[1] assistant: empty text part']);
  });

  it('exempts preserved calls from the adjacency rule', () => {
    expect(findReplayViolations(
      [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'pending' }] }],
      new Set(['pending']),
    )).toEqual([]);
  });

  it('is quiet on a healthy conversation', () => {
    expect(findReplayViolations([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'running' }, { type: 'tool-call', toolCallId: 'x' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])).toEqual([]);
  });
});
