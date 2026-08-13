import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { describeActivity } from '@/lib/activityLabels';
import { useToastStore } from '@/stores';
import type { Activity } from '@/types';
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Coins,
  Loader2,
  OctagonX,
  ShieldQuestion,
  TriangleAlert,
} from 'lucide-react';

/**
 * "What is happening right now", across every agent.
 *
 * The activity feed answers what *happened*; until ActiveWorkRegistry there was
 * no answer to what is happening. This is that answer, plus the three things
 * that are actionable while it is still happening:
 *
 *   running work   — from the registry, the only live source; stoppable
 *   approvals      — work blocked on a human; nothing moves until you decide
 *   spend          — today's cost per agent, so a runaway is visible now
 *                    rather than on the bill
 *   errors         — recent failures, so a broken agent surfaces without
 *                    hunting the feed
 *
 * Only the first is live state. The other three are queries over persisted
 * rows, and they are labelled with their window ("today", "last hour") rather
 * than implying they are complete — see the fail-closed note on spend below.
 */

interface ActiveWork {
  id: string;
  kind: string;
  agentId?: string;
  agentName?: string;
  containerId?: string;
  label?: string;
  startedAt: number;
  cancellable: boolean;
}

interface PendingApproval {
  approvalId: string;
  toolName: string;
  context: 'chat' | 'channel';
  contextId: string;
  agentId: string;
  createdAt: number;
}

/** How often the running list is re-read. The registry has no push channel,
 *  and the elapsed timers need a tick regardless. */
const POLL_MS = 1000;

/** Failures worth interrupting someone over. Deliberately not every *:error —
 *  a plugin that fails to load is a settings problem, not live work. */
const ERROR_TYPES = [
  'chat:error',
  'tool:error',
  'code-execution:error',
  'workflow:execution:failed',
  'routine:execution:failed',
  'messaging:bridge:error',
  'plugin:crash',
];

const ERROR_WINDOW_MS = 60 * 60 * 1000;

/** Rows the registry emits, in words. */
const KIND_LABELS: Record<string, string> = {
  'chat-turn': 'chat',
  'channel-turn': 'channel',
  'routine': 'routine',
  'workflow': 'workflow',
  'workflow-node': 'workflow step',
  'code-execution': 'running code',
  'bridge-turn': 'bridge',
  'compaction': 'compacting',
};

/**
 * The failure text out of an error row's payload.
 *
 * describeActivity finds a row's subject among its top-level keys, and an error
 * keeps its message one level down under `error`. Without this an error row
 * reads "Chat error" and nothing else — a category, not something you can act
 * on, which is the exact failure the label work set out to fix.
 */
function readErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const err = (data as Record<string, unknown>).error;
  if (typeof err === 'string') return err.trim() || undefined;
  if (err && typeof err === 'object') {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function elapsed(since: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const mins = Math.floor(secs / 60);
  return `${mins}:${String(secs % 60).padStart(2, '0')}`;
}

function formatCost(cost: number): string {
  // Sub-cent totals round to $0.00, which reads as "free" rather than "small".
  if (cost > 0 && cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface SpendRow {
  agentId: string;
  agentName: string;
  cost: number;
  tokens: number;
  turns: number;
  /** False when any row in this total was a floor rather than a settled sum. */
  complete: boolean;
}

/**
 * Aggregate today's `agent:spend` rows per agent.
 *
 * `usageIsTotal: false` means that turn's usage was a floor — it ended before
 * the SDK's summed usage arrived. A total built from one is an underestimate,
 * and presenting it as a figure would be the more damaging error, so it is
 * carried through and marked rather than silently rounded into the number.
 */
export function aggregateSpend(rows: Activity[]): SpendRow[] {
  const byAgent = new Map<string, SpendRow>();
  for (const row of rows) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const agentId = typeof d.agentId === 'string' ? d.agentId : 'unknown';
    const agentName = typeof d.agentName === 'string' ? d.agentName : 'Unattributed';
    const entry = byAgent.get(agentId) ?? { agentId, agentName, cost: 0, tokens: 0, turns: 0, complete: true };
    if (typeof d.cost === 'number') entry.cost += d.cost;
    if (typeof d.totalTokens === 'number') entry.tokens += d.totalTokens;
    entry.turns += 1;
    if (d.usageIsTotal !== true) entry.complete = false;
    byAgent.set(agentId, entry);
  }
  return [...byAgent.values()].sort((a, b) => b.cost - a.cost);
}

export function LiveWorkSection() {
  const [collapsed, setCollapsed] = useState(false);
  const [work, setWork] = useState<ActiveWork[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [spend, setSpend] = useState<SpendRow[]>([]);
  const [errors, setErrors] = useState<Activity[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  const refreshWork = useCallback(async () => {
    const result = await window.electron.listActiveWork();
    if (result.success) setWork(result.work ?? []);
    setNow(Date.now());
    setLoaded(true);
  }, []);

  const refreshContext = useCallback(async () => {
    const [pending, spendRows, errorRows] = await Promise.all([
      window.electron.listPendingApprovals(),
      window.electron.getActivities({
        types: ['agent:spend'],
        audience: 'system',
        startTime: startOfToday(),
        limit: 1000,
      }),
      window.electron.getActivities({
        types: ERROR_TYPES,
        startTime: Date.now() - ERROR_WINDOW_MS,
        limit: 20,
      }),
    ]);
    if (pending.success) setApprovals(pending.approvals ?? []);
    if (spendRows.success) setSpend(aggregateSpend(spendRows.activities ?? []));
    if (errorRows.success) setErrors(errorRows.activities ?? []);
  }, []);

  useEffect(() => {
    void refreshWork();
    void refreshContext();
    const workTimer = setInterval(refreshWork, POLL_MS);
    // The persisted queries are far cheaper to run rarely; a turn's cost lands
    // when it ends, not while it streams.
    const contextTimer = setInterval(refreshContext, POLL_MS * 5);
    return () => {
      clearInterval(workTimer);
      clearInterval(contextTimer);
    };
  }, [refreshWork, refreshContext]);

  const stop = useCallback(async (id: string) => {
    setStopping((s) => ({ ...s, [id]: true }));
    try {
      const result = await window.electron.cancelActiveWork(id);
      // `cancelled: false` means the work exposed no cancel hook. Reporting a
      // stop that did not happen is worse than saying so.
      if (!result.success || !result.cancelled) {
        useToastStore.getState().showToast('That work can’t be stopped from here', 'warning');
      }
      await refreshWork();
    } finally {
      setStopping((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
    }
  }, [refreshWork]);

  const stopAll = useCallback(async () => {
    const cancellable = work.filter((w) => w.cancellable);
    await Promise.all(cancellable.map((w) => window.electron.cancelActiveWork(w.id)));
    await refreshWork();
  }, [work, refreshWork]);

  const todayCost = useMemo(() => spend.reduce((sum, s) => sum + s.cost, 0), [spend]);
  const spendComplete = useMemo(() => spend.every((s) => s.complete), [spend]);

  const nothingHappening =
    work.length === 0 && approvals.length === 0 && errors.length === 0 && todayCost === 0;

  // Never render an empty shell before the first read — an empty "Running now"
  // is a claim that nothing is running, and until the registry answers, that
  // claim isn't ours to make.
  if (!loaded) return null;

  return (
    <div className="mb-6 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent-primary)] transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          Running now
          {work.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-xs bg-[var(--accent-primary)] text-white">
              {work.length}
            </span>
          )}
        </button>

        <div className="flex items-center gap-3 ml-auto text-xs text-[var(--text-tertiary)]">
          {approvals.length > 0 && (
            <span className="flex items-center gap-1 text-amber-500">
              <ShieldQuestion className="w-3.5 h-3.5" />
              {approvals.length} waiting
            </span>
          )}
          {todayCost > 0 && (
            <span className="flex items-center gap-1" title={spendComplete ? 'Spend today' : 'At least this much — some turns ended before their usage settled'}>
              <Coins className="w-3.5 h-3.5" />
              {spendComplete ? '' : '≥ '}{formatCost(todayCost)} today
            </span>
          )}
          {work.some((w) => w.cancellable) && (
            <button
              type="button"
              onClick={stopAll}
              className="text-[var(--text-secondary)] hover:text-red-400 transition-colors"
            >
              Stop all
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="border-t border-[var(--border-primary)] px-3 py-2 space-y-3">
          {nothingHappening ? (
            <p className="text-xs text-[var(--text-tertiary)] py-1">
              Nothing running. Turns, routines, workflows and code execution show up here while they work.
            </p>
          ) : null}

          {work.length > 0 && (
            <div className="space-y-1">
              {work.map((w) => (
                <div key={w.id} className="flex items-center gap-2 text-sm">
                  <CircleDot className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 animate-pulse" />
                  <span className="font-medium text-[var(--text-primary)] truncate">
                    {w.agentName ?? w.label ?? 'System'}
                  </span>
                  <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
                    {KIND_LABELS[w.kind] ?? w.kind}
                  </span>
                  {w.agentName && w.label && w.label !== w.agentName && (
                    <span className="text-xs text-[var(--text-tertiary)] truncate">{w.label}</span>
                  )}
                  <span className="text-xs text-[var(--text-tertiary)] tabular-nums ml-auto whitespace-nowrap">
                    {elapsed(w.startedAt, now)}
                  </span>
                  <button
                    type="button"
                    disabled={!w.cancellable || stopping[w.id]}
                    onClick={() => stop(w.id)}
                    title={w.cancellable ? 'Stop this work' : 'This work exposes no way to stop it'}
                    className={cn(
                      'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors',
                      w.cancellable
                        ? 'text-[var(--text-secondary)] hover:text-red-400 hover:bg-[var(--bg-tertiary)]'
                        : 'text-[var(--text-tertiary)] opacity-40 cursor-not-allowed',
                    )}
                  >
                    {stopping[w.id] ? <Loader2 className="w-3 h-3 animate-spin" /> : <OctagonX className="w-3 h-3" />}
                    Stop
                  </button>
                </div>
              ))}
            </div>
          )}

          {approvals.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-amber-500">Waiting on you</p>
              {approvals.map((a) => (
                <div key={a.approvalId} className="flex items-center gap-2 text-sm">
                  <ShieldQuestion className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                  <span className="text-[var(--text-primary)] truncate">{a.toolName}</span>
                  <span className="text-xs text-[var(--text-tertiary)] ml-auto whitespace-nowrap">
                    blocked {elapsed(a.createdAt, now)}
                  </span>
                </div>
              ))}
              <p className="text-xs text-[var(--text-tertiary)]">
                Decide these in the conversation they came from.
              </p>
            </div>
          )}

          {spend.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--text-secondary)]">Spend today</p>
              {spend.map((s) => (
                <div key={s.agentId} className="flex items-center gap-2 text-sm">
                  <Coins className="w-3.5 h-3.5 text-[var(--text-tertiary)] flex-shrink-0" />
                  <span className="text-[var(--text-primary)] truncate">{s.agentName}</span>
                  <span className="text-xs text-[var(--text-tertiary)] whitespace-nowrap">
                    {s.turns} {s.turns === 1 ? 'turn' : 'turns'} · {s.tokens.toLocaleString()} tok
                  </span>
                  <span
                    className="text-xs text-[var(--text-secondary)] tabular-nums ml-auto whitespace-nowrap"
                    title={s.complete ? undefined : 'At least this much — some turns ended before their usage settled'}
                  >
                    {s.complete ? '' : '≥ '}{formatCost(s.cost)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {errors.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-red-400">Errors in the last hour</p>
              {errors.map((e) => {
                const { text } = describeActivity(e);
                const reason = readErrorMessage(e.data);
                return (
                  <div key={e.id} className="flex items-center gap-2 text-sm min-w-0">
                    <TriangleAlert className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                    <span className="text-[var(--text-primary)] whitespace-nowrap">{text}</span>
                    {reason && (
                      <span className="text-xs text-[var(--text-secondary)] truncate" title={reason}>
                        {reason}
                      </span>
                    )}
                    <span className="text-xs text-[var(--text-tertiary)] ml-auto whitespace-nowrap">
                      {elapsed(e.timestamp, now)} ago
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
