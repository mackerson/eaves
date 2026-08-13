import { useCallback, useEffect, useState } from 'react';
import { Shield, ShieldOff, Check, X, ChevronDown, ChevronRight, ChevronsRight, Loader2 } from 'lucide-react';
import { useApprovalQueueStore, type PendingApproval } from '@/stores/useApprovalQueueStore';
import { useUIStore, useConversationsStore, useUIPreferencesStore } from '@/stores';
import './ActionGutter.css';

/**
 * The actions an agent is waiting on, collected in one place.
 *
 * Reported pain: approvals live inline in the transcript, so deciding several
 * means scrolling back through the conversation for each one. This is the same
 * queue, off to the side, decided together — one submit resumes the agent once
 * rather than once per approval.
 *
 * Deliberately a live queue, not a plan: it shows what is actually pending
 * right now. An agent does not know its whole sequence in advance — tool calls
 * arrive as the model decides them — so a "here is everything I intend to do"
 * tree would be a promise the data cannot keep.
 */
export function ActionGutter() {
  const view = useUIStore((s) => s.view);
  const currentChatId = useConversationsStore((s) => s.currentChatId);
  const currentChannelId = useConversationsStore((s) => s.currentChannelId);

  const pending = useApprovalQueueStore((s) => s.pending);
  const choices = useApprovalQueueStore((s) => s.choices);
  const decided = useApprovalQueueStore((s) => s.decided);
  const submitting = useApprovalQueueStore((s) => s.submitting);
  const error = useApprovalQueueStore((s) => s.error);
  const load = useApprovalQueueStore((s) => s.load);
  const choose = useApprovalQueueStore((s) => s.choose);
  const chooseAll = useApprovalQueueStore((s) => s.chooseAll);
  const submit = useApprovalQueueStore((s) => s.submit);
  const grants = useApprovalQueueStore((s) => s.grants);
  const alwaysAllow = useApprovalQueueStore((s) => s.alwaysAllow);
  const toggleAlwaysAllow = useApprovalQueueStore((s) => s.toggleAlwaysAllow);
  const revokeGrant = useApprovalQueueStore((s) => s.revokeGrant);

  const collapsed = useUIPreferencesStore((s) => s.actionGutterCollapsed);
  const setCollapsed = useUIPreferencesStore((s) => s.setActionGutterCollapsed);

  const isChannel = view === 'channels';
  const contextId = isChannel ? currentChannelId : currentChatId;

  const refresh = useCallback(() => {
    if (!contextId) return;
    load({ context: isChannel ? 'channel' : 'chat', contextId });
  }, [contextId, isChannel, load]);

  useEffect(() => { refresh(); }, [refresh]);

  // A turn that suspends on an approval ends its stream, so stream traffic is
  // the signal that the queue may have changed. Cheap: the read is a registry
  // lookup, not a query.
  useEffect(() => {
    const offStream = window.electron.onChatStream(() => refresh());
    const offUpdated = window.electron.onMessageUpdated(() => refresh());
    return () => { offStream(); offUpdated(); };
  }, [refresh]);

  const staged = pending.filter((p) => choices[p.approvalId]).length;
  const recentlyDecided = decided.slice(0, 3);

  // Nothing to collect, nothing just handled, nothing waived — stay out of the
  // way entirely. Grants show even when idle: a standing waiver the user cannot
  // see is one they cannot take back.
  if (pending.length === 0 && recentlyDecided.length === 0 && grants.length === 0) return null;

  // Collapsed still shows the count. Hiding a waiting agent completely would
  // leave the conversation looking stalled with no way to find out why.
  if (collapsed) {
    return (
      <button
        className="action-gutter-rail"
        data-testid="action-gutter-rail"
        onClick={() => setCollapsed(false)}
        title={pending.length > 0 ? `${pending.length} action(s) waiting on you` : 'Actions'}
        aria-label={`Show actions${pending.length > 0 ? ` (${pending.length} pending)` : ''}`}
      >
        <Shield className="h-4 w-4" aria-hidden />
        {pending.length > 0 && (
          <span className="action-gutter-rail-count" data-testid="action-gutter-rail-count">{pending.length}</span>
        )}
      </button>
    );
  }

  return (
    <aside className="action-gutter" data-testid="action-gutter" aria-label="Pending actions">
      <header className="action-gutter-header">
        <Shield className="h-4 w-4" aria-hidden />
        <span className="action-gutter-title">Actions</span>
        {pending.length > 0 && (
          <span className="action-gutter-count" data-testid="action-gutter-count">{pending.length}</span>
        )}
        <button
          className="action-gutter-collapse"
          onClick={() => setCollapsed(true)}
          title="Collapse"
          aria-label="Collapse actions"
          data-testid="collapse-gutter"
        >
          <ChevronsRight className="h-3 w-3" aria-hidden />
        </button>
      </header>

      {pending.length > 0 && (
        <>
          <div className="action-gutter-bulk">
            <button
              className="action-gutter-bulk-btn approve"
              onClick={() => chooseAll('approve')}
              disabled={submitting}
              data-testid="approve-all"
            >
              <Check className="h-3 w-3" aria-hidden /> Approve all
            </button>
            <button
              className="action-gutter-bulk-btn deny"
              onClick={() => chooseAll('deny')}
              disabled={submitting}
              data-testid="deny-all"
            >
              <X className="h-3 w-3" aria-hidden /> Deny all
            </button>
          </div>

          <ul className="action-gutter-list">
            {pending.map((approval) => (
              <ActionRow
                key={approval.approvalId}
                approval={approval}
                choice={choices[approval.approvalId]}
                alwaysAllow={!!alwaysAllow[approval.approvalId]}
                disabled={submitting}
                onChoose={(c) => choose(approval.approvalId, c)}
                onToggleAlwaysAllow={() => toggleAlwaysAllow(approval.approvalId)}
              />
            ))}
          </ul>

          <footer className="action-gutter-footer">
            {error && <p className="action-gutter-error" role="alert">{error}</p>}
            <button
              className="action-gutter-submit"
              onClick={submit}
              disabled={submitting || staged === 0}
              data-testid="submit-decisions"
            >
              {submitting
                ? <><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Submitting…</>
                : staged === 0
                  ? 'Choose an action'
                  : `Submit ${staged} decision${staged === 1 ? '' : 's'}`}
            </button>
            {/* Undecided items stay pending — silence is not a denial. */}
            {staged > 0 && staged < pending.length && (
              <p className="action-gutter-note">{pending.length - staged} left undecided, and stay pending.</p>
            )}
          </footer>
        </>
      )}

      {grants.length > 0 && (
        <div className="action-gutter-grants" data-testid="action-gutter-grants">
          <span className="action-gutter-decided-label">Not asking here</span>
          {grants.map((g) => (
            <span key={g.id} className="action-gutter-grant-row">
              <ShieldOff className="h-3 w-3" aria-hidden />
              <code>{g.toolName}</code>
              <button
                className="action-gutter-grant-revoke"
                onClick={() => revokeGrant(g.id)}
                title={`Start asking about ${g.toolName} again`}
                aria-label={`Revoke waiver for ${g.toolName}`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      {recentlyDecided.length > 0 && (
        <div className="action-gutter-decided">
          <span className="action-gutter-decided-label">Just handled</span>
          {recentlyDecided.map((d) => (
            <span key={d.approvalId} className={`action-gutter-decided-row ${d.approved ? 'approved' : 'denied'}`}>
              {d.approved ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
              {d.toolName}
            </span>
          ))}
        </div>
      )}
    </aside>
  );
}

function ActionRow({
  approval,
  choice,
  alwaysAllow,
  disabled,
  onChoose,
  onToggleAlwaysAllow,
}: {
  approval: PendingApproval;
  choice?: 'approve' | 'deny';
  alwaysAllow: boolean;
  disabled: boolean;
  onChoose: (choice: 'approve' | 'deny') => void;
  onToggleAlwaysAllow: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const full = (() => {
    try {
      return JSON.stringify(approval.input, null, 2);
    } catch {
      return String(approval.input);
    }
  })();
  // One line is enough to decide most of these; the rest is a click away.
  const summary = full.replace(/\s+/g, ' ').slice(0, 80);

  return (
    <li className={`action-row ${choice ?? ''}`} data-testid="action-row">
      <div className="action-row-head">
        <button
          className="action-row-disclosure"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Hide details' : 'Show details'}
        >
          {expanded ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
        </button>
        <code className="action-row-tool">{approval.toolName}</code>
        <div className="action-row-actions">
          <button
            className={`action-row-btn approve ${choice === 'approve' ? 'chosen' : ''}`}
            onClick={() => onChoose('approve')}
            disabled={disabled}
            title="Approve"
            aria-pressed={choice === 'approve'}
          >
            <Check className="h-3 w-3" aria-hidden />
          </button>
          <button
            className={`action-row-btn deny ${choice === 'deny' ? 'chosen' : ''}`}
            onClick={() => onChoose('deny')}
            disabled={disabled}
            title="Deny"
            aria-pressed={choice === 'deny'}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      </div>
      {expanded
        ? <pre className="action-row-input">{full}</pre>
        : <p className="action-row-summary">{summary}</p>}
      {/* Only meaningful alongside an approval: a waiver is "stop asking", not
          "always refuse". */}
      {choice === 'approve' && (
        <label className="action-row-always" data-testid="always-allow">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={onToggleAlwaysAllow}
            disabled={disabled}
          />
          <span>Stop asking about {approval.toolName} here</span>
        </label>
      )}
    </li>
  );
}
