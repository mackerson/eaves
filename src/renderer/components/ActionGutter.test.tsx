import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ActionGutter } from './ActionGutter';
import { useApprovalQueueStore } from '@/stores/useApprovalQueueStore';
import { useUIPreferencesStore, useUIStore, useConversationsStore } from '@/stores';

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

beforeEach(() => {
  listPendingApprovals = vi.fn().mockResolvedValue({ success: true, approvals: [] });
  (window as any).electron = {
    listPendingApprovals,
    listApprovalGrants: vi.fn().mockResolvedValue({ success: true, grants: [] }),
    grantToolApproval: vi.fn().mockResolvedValue({ success: true }),
    revokeToolApproval: vi.fn().mockResolvedValue({ success: true }),
    respondToApprovals: vi.fn().mockResolvedValue({ success: true }),
    onChatStream: vi.fn().mockReturnValue(() => {}),
    onMessageUpdated: vi.fn().mockReturnValue(() => {}),
  };
  useUIStore.setState({ view: 'chats' } as never);
  useConversationsStore.setState({ currentChatId: 'chat-1' } as never);
  useUIPreferencesStore.setState({ actionGutterCollapsed: false });
  useApprovalQueueStore.setState({
    pending: [], choices: {}, decided: [], grants: [], alwaysAllow: {},
    loading: false, submitting: false, error: null,
  });
});

describe('ActionGutter', () => {
  // Hidden until there is something to decide: an empty bar would just take
  // width away from the conversation.
  it('renders nothing when there is nothing pending', async () => {
    const { container } = render(<ActionGutter />);
    await waitFor(() => expect(listPendingApprovals).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('appears when actions are pending', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1'), approval('a2')] });
    render(<ActionGutter />);

    await waitFor(() => expect(screen.getByTestId('action-gutter')).toBeTruthy());
    expect(screen.getByTestId('action-gutter-count').textContent).toBe('2');
  });

  it('collapses to a rail and comes back', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1')] });
    render(<ActionGutter />);
    await waitFor(() => expect(screen.getByTestId('action-gutter')).toBeTruthy());

    fireEvent.click(screen.getByTestId('collapse-gutter'));
    expect(screen.queryByTestId('action-gutter')).toBeNull();
    expect(useUIPreferencesStore.getState().actionGutterCollapsed).toBe(true);

    fireEvent.click(screen.getByTestId('action-gutter-rail'));
    await waitFor(() => expect(screen.getByTestId('action-gutter')).toBeTruthy());
  });

  // Collapsing must not make a waiting agent invisible — otherwise the
  // conversation just looks stalled and there's nothing to click.
  it('keeps the pending count visible while collapsed', async () => {
    useUIPreferencesStore.setState({ actionGutterCollapsed: true });
    listPendingApprovals.mockResolvedValue({
      success: true, approvals: [approval('a1'), approval('a2'), approval('a3')],
    });
    render(<ActionGutter />);

    await waitFor(() => expect(screen.getByTestId('action-gutter-rail')).toBeTruthy());
    expect(screen.getByTestId('action-gutter-rail-count').textContent).toBe('3');
  });

  it('stays away entirely when collapsed and nothing is pending', async () => {
    useUIPreferencesStore.setState({ actionGutterCollapsed: true });
    const { container } = render(<ActionGutter />);
    await waitFor(() => expect(listPendingApprovals).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('warns that undecided actions stay pending', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1'), approval('a2')] });
    render(<ActionGutter />);
    await waitFor(() => expect(screen.getByTestId('action-gutter')).toBeTruthy());

    fireEvent.click(screen.getAllByTestId('action-row')[0].querySelector('.action-row-btn.approve')!);

    expect(screen.getByTestId('submit-decisions').textContent).toContain('Submit 1 decision');
    expect(screen.getByText(/1 left undecided/)).toBeTruthy();
  });
});

describe('ActionGutter waivers', () => {
  it('offers "stop asking" only once an action is approved', async () => {
    listPendingApprovals.mockResolvedValue({ success: true, approvals: [approval('a1', 'edit_file')] });
    render(<ActionGutter />);
    await waitFor(() => expect(screen.getByTestId('action-gutter')).toBeTruthy());

    // Undecided, or denied: a waiver makes no sense.
    expect(screen.queryByTestId('always-allow')).toBeNull();
    fireEvent.click(screen.getByTestId('action-row').querySelector('.action-row-btn.deny')!);
    expect(screen.queryByTestId('always-allow')).toBeNull();

    fireEvent.click(screen.getByTestId('action-row').querySelector('.action-row-btn.approve')!);
    expect(screen.getByTestId('always-allow')).toBeTruthy();
  });

  // A standing permission the user cannot see is one they cannot take back, so
  // the gutter stays present for waivers even with an empty queue.
  it('lists existing waivers even when nothing is pending', async () => {
    (window as any).electron.listApprovalGrants.mockResolvedValue({
      success: true,
      grants: [{ id: 'g1', containerId: 'chat-1', agentId: 'agent-1', toolName: 'bash', grantedAt: 1 }],
    });
    render(<ActionGutter />);

    await waitFor(() => expect(screen.getByTestId('action-gutter-grants')).toBeTruthy());
    expect(screen.getByText('bash')).toBeTruthy();
  });
});
