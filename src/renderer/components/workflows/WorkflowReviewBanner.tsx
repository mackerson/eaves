import { useMemo } from 'react';
import type { Workflow } from '@/types';
import { AlertTriangle, Check, Trash2 } from 'lucide-react';

interface WorkflowReviewBannerProps {
  workflow: Workflow;
  onApprove: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

/**
 * Banner shown on workflows that are awaiting human review. Enumerates every
 * side-effect-capable node (code / agent / http / webscraper) with the exact
 * payload an agent wrote, so the user can audit before approving.
 */
export function WorkflowReviewBanner({ workflow, onApprove, onDelete }: WorkflowReviewBannerProps) {
  const sensitiveNodes = useMemo(() => {
    const nodes = workflow.dagDefinition?.nodes ?? [];
    return nodes
      .map((node) => {
        const type = (node as any).type;
        const data = (node as any).data ?? {};
        if (type === 'code') {
          return {
            kind: 'code' as const,
            id: node.id,
            title: `Code · ${data.language ?? 'javascript'}`,
            body: String(data.code ?? ''),
          };
        }
        if (type === 'agent') {
          return {
            kind: 'agent' as const,
            id: node.id,
            title: `Agent · ${data.agentId || '(system default)'}`,
            body: String(data.prompt ?? ''),
          };
        }
        if (type === 'http') {
          return {
            kind: 'http' as const,
            id: node.id,
            title: `HTTP · ${String(data.method ?? 'GET').toUpperCase()}`,
            body: String(data.url ?? ''),
          };
        }
        if (type === 'webscraper') {
          return {
            kind: 'webscraper' as const,
            id: node.id,
            title: 'Web Scraper',
            body: String(data.url ?? ''),
          };
        }
        return null;
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  }, [workflow]);

  return (
    <div
      className="p-4 border-b-2 space-y-3"
      style={{
        background: 'rgba(234, 179, 8, 0.08)',
        borderColor: 'rgb(234, 179, 8)',
      }}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'rgb(234, 179, 8)' }} />
        <div className="flex-1">
          <h3 className="font-semibold text-[var(--text-primary)]">
            This workflow is pending human review
          </h3>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {workflow.createdBy === 'agent' ? 'An agent created this workflow.' : 'This workflow is awaiting review.'}
            {' '}
            It cannot execute until you approve it. Review every code block, agent prompt, and HTTP endpoint below.
            Malicious or mistaken scripts can touch your filesystem, network, and data.
          </p>
        </div>
      </div>

      {sensitiveNodes.length > 0 && (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {sensitiveNodes.map((n) => (
            <details
              key={n.id}
              className="rounded border border-[var(--border-primary)] bg-[var(--bg-primary)]"
              open={n.kind === 'code'}
            >
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-[var(--text-primary)]">
                {n.title} <span className="text-xs text-[var(--text-tertiary)] ml-2">#{n.id}</span>
              </summary>
              <pre className="px-3 pb-3 text-xs whitespace-pre-wrap break-words font-mono text-[var(--text-secondary)]">
                {n.body || '(empty)'}
              </pre>
            </details>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="px-3 py-1.5 rounded bg-[var(--accent-primary)] text-white text-sm font-medium flex items-center gap-1.5 hover:opacity-90"
        >
          <Check className="w-4 h-4" />
          Approve and enable
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-1.5 rounded border border-[var(--border-primary)] text-[var(--text-secondary)] text-sm font-medium flex items-center gap-1.5 hover:bg-[var(--bg-tertiary)]"
        >
          <Trash2 className="w-4 h-4" />
          Delete
        </button>
      </div>
    </div>
  );
}
