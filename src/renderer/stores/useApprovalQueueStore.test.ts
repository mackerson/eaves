import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useApprovalQueueStore } from './useApprovalQueueStore';

const approval = (approvalId: string, toolName = 'bash') => ({
  approvalId,
  toolCallId: `call-${approvalId}`,
  toolName,
  input: { command: 'echo hi' },
  context: 'chat' as const,
  contextId: 'chat-1',
  agentId: 'agent-1',
  messageId: 'msg-1',
  createdAt: 1,
});

let listPendingApprovals: ReturnType<typeof vi.fn>;
let respondToApprovals: ReturnType<typeof vi.fn>;
let grantToolApproval: ReturnType<typeof vi.fn>;
let revokeToolApproval: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listPendingApprovals = vi.fn().mockResolvedValue({ success: true, approvals: [] });
  respondToApprovals = vi.fn().mockResolvedValue({ success: true });
  grantToolApproval = vi.fn().mockResolvedValue({ success: true });
  revokeToolApproval = vi.fn().mockResolvedValue({ success: true });
  (window as any).electron = {
    listPendingApprovals, respondToApprovals, grantToolApproval, revokeToolApproval,
    listApprovalGrants: vi.fn().mockResolvedValue({ success: true, grants: [] }),
  };
  useApprovalQueueStore.setState({
    pending: [], choices: {}, decided: [], grants: [], alwaysAllow: {},
    loading: false, submitting: false, error: null,
  });
});

describe('approval queue', () => {
  it('submits every staged decision as one batch', async () => {
    listPendingApprovals.mockResolvedValue({
      success: true, approvals: [approval('a1'), approval('a2', 'edit_file'), approval('a3')],
    });
    await useApprovalQueueStore.getState().load({ context: 'chat', contextId: 'chat-1' });

    useApprovalQueueStore.getState().chooseAll('approve');
    useApprovalQueueStore.getState().choose('a2', 'deny');
    await useApprovalQueueStore.getState().submit();

    // One call, not three — the whole point: the agent resumes once.
    expect(respondToApprovals).toHaveBeenCalledTimes(1);
    expect(respondToApprovals.mock.calls[0][0]).toMatchObject({
      context: 'chat',
      contextId: 'chat-1',
      decisions: [
        { approvalId: 'a1', approved: true },
        { approvalId: 'a2', approved: false },
        { approvalId: 'a3', approved: true },
      ],
    });
  });

  // Silence is not a denial: an approval the user did not answer stays
  // pending rather than being swept along with the batch.
  it('leaves undecided approvals pending', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1'), approval('a2')] });
    await useApprovalQueueStore.getState().load();

    useApprovalQueueStore.getState().choose('a1', 'approve');
    await useApprovalQueueStore.getState().submit();

    expect(respondToApprovals.mock.calls[0][0].decisions).toEqual([{ approvalId: 'a1', approved: true }]);
    expect(useApprovalQueueStore.getState().pending.map(p => p.approvalId)).toEqual(['a2']);
  });

  it('does nothing when nothing is staged', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1')] });
    await useApprovalQueueStore.getState().load();

    await useApprovalQueueStore.getState().submit();
    expect(respondToApprovals).not.toHaveBeenCalled();
  });

  it('records what it just handled, so the gutter can confirm it', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1', 'edit_file')] });
    await useApprovalQueueStore.getState().load();

    useApprovalQueueStore.getState().choose('a1', 'deny');
    await useApprovalQueueStore.getState().submit();

    expect(useApprovalQueueStore.getState().decided[0]).toMatchObject({
      approvalId: 'a1', toolName: 'edit_file', approved: false,
    });
  });

  // Submitting resumes the agent, whose stream events refresh the queue. The
  // handled list must survive that race — it read "tool" for everything before.
  it('remembers tool names even if the queue refreshes mid-submit', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1', 'edit_file')] });
    await useApprovalQueueStore.getState().load();
    useApprovalQueueStore.getState().choose('a1', 'approve');

    respondToApprovals.mockImplementation(async () => {
      // Stand in for the refresh a resume triggers: the decided approval is
      // no longer pending by the time the submit resolves.
      useApprovalQueueStore.setState({ pending: [] });
      return { success: true };
    });
    await useApprovalQueueStore.getState().submit();

    expect(useApprovalQueueStore.getState().decided[0].toolName).toBe('edit_file');
  });

  it('keeps the queue intact when the submit fails', async () => {
    respondToApprovals.mockResolvedValue({ success: false, error: 'resume blew up' });
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1')] });
    await useApprovalQueueStore.getState().load();

    useApprovalQueueStore.getState().choose('a1', 'approve');
    await useApprovalQueueStore.getState().submit();

    const state = useApprovalQueueStore.getState();
    expect(state.error).toBe('resume blew up');
    expect(state.pending).toHaveLength(1);
    expect(state.decided).toHaveLength(0);
    expect(state.submitting).toBe(false);
  });

  // Another surface (the inline card) can decide an approval; a refresh must
  // not leave a staged choice pointing at something no longer pending.
  it('drops staged choices for approvals that vanished', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1'), approval('a2')] });
    await useApprovalQueueStore.getState().load();
    useApprovalQueueStore.getState().chooseAll('approve');

    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a2')] });
    await useApprovalQueueStore.getState().load();

    expect(Object.keys(useApprovalQueueStore.getState().choices)).toEqual(['a2']);
  });

  it('surfaces a load failure instead of showing an empty queue', async () => {
    listPendingApprovals.mockResolvedValue({ success: false, error: 'registry unavailable' });
    await useApprovalQueueStore.getState().load();

    expect(useApprovalQueueStore.getState().error).toBe('registry unavailable');
    expect(useApprovalQueueStore.getState().loading).toBe(false);
  });
});

describe('approval waivers', () => {
  it('writes a waiver for approved actions marked "stop asking"', async () => {
    listPendingApprovals.mockResolvedValue({
      success: true, approvals: [approval('a1', 'edit_file'), approval('a2', 'bash')],
    });
    await useApprovalQueueStore.getState().load({ context: 'chat', contextId: 'chat-1' });

    useApprovalQueueStore.getState().chooseAll('approve');
    useApprovalQueueStore.getState().toggleAlwaysAllow('a1');
    await useApprovalQueueStore.getState().submit();

    expect(grantToolApproval).toHaveBeenCalledTimes(1);
    expect(grantToolApproval).toHaveBeenCalledWith({
      containerId: 'chat-1', agentId: 'agent-1', toolName: 'edit_file',
    });
  });

  // "Never ask me again" attached to a denial would be a standing block nobody
  // asked for — a waiver only makes sense paired with an approval.
  it('never writes a waiver for a denied action', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1', 'bash')] });
    await useApprovalQueueStore.getState().load({ context: 'chat', contextId: 'chat-1' });

    useApprovalQueueStore.getState().choose('a1', 'deny');
    useApprovalQueueStore.getState().toggleAlwaysAllow('a1');
    await useApprovalQueueStore.getState().submit();

    expect(grantToolApproval).not.toHaveBeenCalled();
  });

  it('revokes a waiver and drops it from the list', async () => {
    useApprovalQueueStore.setState({
      grants: [{ id: 'g1', containerId: 'chat-1', agentId: 'agent-1', toolName: 'bash', grantedAt: 1 }],
    });

    await useApprovalQueueStore.getState().revokeGrant('g1');

    expect(revokeToolApproval).toHaveBeenCalledWith('g1');
    expect(useApprovalQueueStore.getState().grants).toEqual([]);
  });

  it('keeps a waiver listed when revoking fails', async () => {
    revokeToolApproval.mockResolvedValue({ success: false, error: 'gone' });
    useApprovalQueueStore.setState({
      grants: [{ id: 'g1', containerId: 'chat-1', agentId: 'agent-1', toolName: 'bash', grantedAt: 1 }],
    });

    await useApprovalQueueStore.getState().revokeGrant('g1');
    expect(useApprovalQueueStore.getState().grants).toHaveLength(1);
    expect(useApprovalQueueStore.getState().error).toBe('gone');
  });
});
