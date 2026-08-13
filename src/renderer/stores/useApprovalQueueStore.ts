import { create } from 'zustand';

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  context: 'chat' | 'channel';
  contextId: string;
  agentId: string;
  messageId: string;
  createdAt: number;
}

/** What the user has chosen for an item that hasn't been submitted yet. */
export type Choice = 'approve' | 'deny';

export interface ToolGrant {
  id: string;
  containerId: string;
  agentId: string;
  toolName: string;
  grantedAt: number;
}

export interface DecidedRecord {
  approvalId: string;
  toolName: string;
  approved: boolean;
  at: number;
}

interface ApprovalQueueState {
  pending: PendingApproval[];
  /** Per-approval choice, staged until submit. */
  choices: Record<string, Choice>;
  /** Decided in this session — the "already handled" half of the queue. */
  decided: DecidedRecord[];
  /** Tools this conversation has stopped asking about. */
  grants: ToolGrant[];
  /** Approvals the user also wants to stop being asked about, staged until submit. */
  alwaysAllow: Record<string, boolean>;
  loading: boolean;
  submitting: boolean;
  error: string | null;

  load: (filter?: { context: 'chat' | 'channel'; contextId: string }) => Promise<void>;
  choose: (approvalId: string, choice: Choice) => void;
  chooseAll: (choice: Choice) => void;
  clearChoices: () => void;
  toggleAlwaysAllow: (approvalId: string) => void;
  submit: () => Promise<void>;
  revokeGrant: (grantId: string) => Promise<void>;
}

/**
 * The pending-actions queue behind the gutter.
 *
 * Kept separate from the transcript on purpose: the reported pain is having to
 * scroll back through a conversation to find what needs deciding. The registry
 * is the source of truth for what is pending — `decided` only records what this
 * session submitted, so the gutter can confirm an action without pretending to
 * reconstruct history it does not have.
 */
export const useApprovalQueueStore = create<ApprovalQueueState>((set, get) => ({
  pending: [],
  choices: {},
  decided: [],
  grants: [],
  alwaysAllow: {},
  loading: false,
  submitting: false,
  error: null,

  load: async (filter) => {
    set({ loading: true });
    try {
      const [result, grantResult] = await Promise.all([
        window.electron.listPendingApprovals(filter),
        filter ? window.electron.listApprovalGrants(filter.contextId) : Promise.resolve({ success: true, grants: [] as never[] }),
      ]);
      if (result.success && result.approvals) {
        const pending = result.approvals;
        set((state) => ({
          pending,
          grants: grantResult.success && grantResult.grants ? grantResult.grants : state.grants,
          loading: false,
          error: null,
          // Drop staged choices for approvals that are no longer pending —
          // another surface (the inline card) may have decided them.
          choices: Object.fromEntries(
            Object.entries(state.choices).filter(([id]) => pending.some((p) => p.approvalId === id)),
          ),
        }));
      } else {
        set({ loading: false, error: result.error ?? 'Could not load pending actions' });
      }
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load pending actions' });
    }
  },

  choose: (approvalId, choice) =>
    set((state) => ({ choices: { ...state.choices, [approvalId]: choice } })),

  chooseAll: (choice) =>
    set((state) => ({
      choices: Object.fromEntries(state.pending.map((p) => [p.approvalId, choice])),
    })),

  clearChoices: () => set({ choices: {}, alwaysAllow: {} }),

  toggleAlwaysAllow: (approvalId) =>
    set((state) => ({ alwaysAllow: { ...state.alwaysAllow, [approvalId]: !state.alwaysAllow[approvalId] } })),

  revokeGrant: async (grantId) => {
    const result = await window.electron.revokeToolApproval(grantId);
    if (result.success) {
      set((state) => ({ grants: state.grants.filter((g) => g.id !== grantId) }));
    } else {
      set({ error: result.error ?? 'Could not revoke' });
    }
  },

  /**
   * Submit every staged choice as one batch, which resumes the agent once.
   * Undecided items are left pending rather than assumed — an approval nobody
   * answered is not a denial.
   */
  submit: async () => {
    const { pending, choices, alwaysAllow } = get();
    const decisions = pending
      .filter((p) => choices[p.approvalId])
      .map((p) => ({ approvalId: p.approvalId, approved: choices[p.approvalId] === 'approve' }));

    if (decisions.length === 0) return;

    // Capture names now, not in the state updater below. Submitting resumes the
    // agent, whose stream events trigger a refresh that replaces `pending` —
    // so by the time the updater runs, the approvals just decided are gone and
    // every "just handled" row would read as a generic "tool".
    const toolNames = new Map(pending.map((p) => [p.approvalId, p.toolName]));

    // Every pending approval in one conversation comes from the same turn, so
    // the batch shares a context; the main process rejects one that doesn't.
    const first = pending.find((p) => p.approvalId === decisions[0].approvalId)!;

    set({ submitting: true, error: null });
    try {
      // Waivers are written before the resume, so the tools they cover are
      // already un-prompted when the agent picks up. Only ever paired with an
      // approval — "never ask me again" attached to a denial would be a
      // standing block nobody asked for.
      const toGrant = pending.filter(
        (p) => alwaysAllow[p.approvalId] && choices[p.approvalId] === 'approve',
      );
      for (const p of toGrant) {
        await window.electron.grantToolApproval({
          containerId: p.contextId, agentId: p.agentId, toolName: p.toolName,
        });
      }

      const result = await window.electron.respondToApprovals({
        decisions,
        context: first.context,
        contextId: first.contextId,
        agentId: first.agentId,
        messageId: first.messageId,
      });

      if (!result.success) {
        set({ submitting: false, error: result.error ?? 'Could not submit decisions' });
        return;
      }

      const now = Date.now();
      set((state) => ({
        submitting: false,
        choices: {},
        alwaysAllow: {},
        pending: state.pending.filter((p) => !choices[p.approvalId]),
        decided: [
          ...decisions.map((d) => ({
            approvalId: d.approvalId,
            toolName: toolNames.get(d.approvalId) ?? 'tool',
            approved: d.approved,
            at: now,
          })),
          ...state.decided,
        ].slice(0, 20),
      }));
    } catch (e) {
      set({ submitting: false, error: e instanceof Error ? e.message : 'Could not submit decisions' });
    }
  },
}));
