import { memo, useState } from 'react';
import { Shield, ShieldCheck, ShieldX, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { ToolApprovalState } from '@/types';

interface ApprovalCardProps {
  approval: ToolApprovalState;
  context: 'chat' | 'channel';
  contextId: string;
  agentId: string;
  messageId: string;
}

/**
 * Inline approval card for the SDK-native HITL flow. Rendering the prompt in
 * the transcript rather than in a blocking dialog means the stream can close
 * while the user thinks — resolution fires `approval:respond` IPC, which
 * re-streams the model with the appended tool-approval-response message.
 */
export const ApprovalCard = memo(function ApprovalCard({
  approval,
  context,
  contextId,
  agentId,
  messageId,
}: ApprovalCardProps) {
  const [isExpanded, setIsExpanded] = useState(approval.status === 'pending');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (approved: boolean) => {
    if (submitting || approval.status !== 'pending') return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.electron.respondToApproval({
        approvalId: approval.approvalId,
        approved,
        context,
        contextId,
        agentId,
        messageId,
      });
      if (!result.success) {
        setError(result.error ?? 'Failed to record decision');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setSubmitting(false);
    }
  };

  const isPending = approval.status === 'pending';
  const isApproved = approval.status === 'approved';
  const isDenied = approval.status === 'denied';

  const inputPreview = (() => {
    try {
      return JSON.stringify(approval.input, null, 2);
    } catch {
      return String(approval.input);
    }
  })();

  return (
    <div
      className={`border rounded-lg p-3 my-2 ${
        isPending
          ? 'bg-yellow-500/10 border-yellow-500/50'
          : isApproved
            ? 'bg-emerald-500/10 border-emerald-500/40'
            : 'bg-red-500/10 border-red-500/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsExpanded(v => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {isPending && <Shield size={16} className="text-yellow-500" />}
        {isApproved && <ShieldCheck size={16} className="text-emerald-500" />}
        {isDenied && <ShieldX size={16} className="text-red-500" />}
        <span className="font-medium text-sm">
          {isPending && 'Approval needed: '}
          {isApproved && 'Approved: '}
          {isDenied && 'Denied: '}
          <code className="app-text-primary">{approval.toolName}</code>
        </span>
      </div>

      {isExpanded && (
        <div className="mt-3 space-y-2 text-xs">
          <div className="text-muted-foreground font-medium">Input:</div>
          <pre className="bg-bg-tertiary p-2 rounded border border-border-secondary overflow-x-auto overflow-y-hidden whitespace-pre-wrap">
            {inputPreview}
          </pre>

          {approval.reason && (
            <div>
              <span className="text-muted-foreground font-medium">Reason:</span>{' '}
              {approval.reason}
            </div>
          )}

          {error && <div className="text-red-500">{error}</div>}

          {isPending && (
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => respond(true)}
                disabled={submitting}
                className="px-3 py-1.5 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-1"
              >
                {submitting ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                Approve
              </button>
              <button
                onClick={() => respond(false)}
                disabled={submitting}
                className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 flex items-center gap-1"
              >
                <ShieldX size={12} />
                Deny
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
