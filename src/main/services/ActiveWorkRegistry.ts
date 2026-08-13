import { randomUUID } from 'crypto';
import { logger } from './logger';

/**
 * ActiveWorkRegistry — what is running right now, across every agent.
 *
 * The activity log answers "what happened"; nothing answered "what is
 * happening". Live state was spread across five private maps that never left
 * their owning service — ChatService.activeStreamControllers,
 * ChannelDispatcher.activeDispatches, CodeExecutor.activeExecutions,
 * MessagingBridgeService.inFlightRequests, SyncService.sessions — so no
 * surface could show, or stop, work in flight.
 *
 * Deliberately NOT a second source of truth. Each service still owns its own
 * abort controller and lifecycle; this holds a description of the work plus an
 * optional cancel hook, and entries are removed by the same `finally` that
 * cleans up the owner's state. If the two ever disagree, the owner wins — see
 * `sweepStale`, which exists because a leaked entry here would otherwise be
 * indistinguishable from real work and would show a phantom "running" forever.
 */

export type WorkKind =
  | 'chat-turn'
  | 'channel-turn'
  | 'routine'
  | 'workflow'
  | 'workflow-node'
  | 'code-execution'
  | 'bridge-turn'
  | 'compaction';

export interface ActiveWorkInput {
  kind: WorkKind;
  /** The agent doing the work, when one is. Routines and workflows often have none. */
  agentId?: string;
  agentName?: string;
  /** Conversation, workflow or execution this belongs to. */
  containerId?: string;
  /** Short human-readable subject: routine name, tool name, channel name. */
  label?: string;
  /** Invoked by `cancel()`. Absent means the work is running but not stoppable. */
  onCancel?: () => void;
}

export interface ActiveWork extends Omit<ActiveWorkInput, 'onCancel'> {
  id: string;
  startedAt: number;
  cancellable: boolean;
}

/**
 * Nothing legitimately runs this long. A turn is bounded by the provider, a
 * routine by the workflow timeout; an entry older than this is a leak from a
 * path that threw somewhere without its `finally`, and reporting it as live
 * work is worse than dropping it.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

interface Entry extends ActiveWork {
  onCancel?: () => void;
}

export class ActiveWorkRegistry {
  private entries = new Map<string, Entry>();

  /** Returns a handle whose `done()` must be called from the owner's `finally`. */
  start(input: ActiveWorkInput): { id: string; done: () => void } {
    const id = randomUUID();
    this.entries.set(id, {
      id,
      kind: input.kind,
      agentId: input.agentId,
      agentName: input.agentName,
      containerId: input.containerId,
      label: input.label,
      startedAt: Date.now(),
      cancellable: typeof input.onCancel === 'function',
      onCancel: input.onCancel,
    });
    return { id, done: () => { this.entries.delete(id); } };
  }

  /** Live work, newest first. Stale entries are swept on read. */
  list(): ActiveWork[] {
    this.sweepStale();
    return [...this.entries.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ onCancel: _onCancel, ...work }) => work);
  }

  /**
   * Ask the owning service to stop one unit of work. Returns false when the id
   * is unknown or the work exposed no cancel hook — the caller must not report
   * a stop it did not get. The entry is left in place: it is the owner's
   * `finally` that removes it, once the work has actually wound down.
   */
  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.onCancel) return false;
    try {
      entry.onCancel();
      return true;
    } catch (error) {
      logger.error('[ActiveWork] Cancel hook threw', { id, kind: entry.kind, error });
      return false;
    }
  }

  private sweepStale(): void {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [id, entry] of this.entries) {
      if (entry.startedAt < cutoff) {
        logger.warn('[ActiveWork] Dropping stale entry — owner never called done()', {
          id, kind: entry.kind, ageMs: Date.now() - entry.startedAt,
        });
        this.entries.delete(id);
      }
    }
  }

  /** Test seam. */
  clear(): void {
    this.entries.clear();
  }
}

let instance: ActiveWorkRegistry | null = null;

export function getActiveWorkRegistry(): ActiveWorkRegistry {
  if (!instance) instance = new ActiveWorkRegistry();
  return instance;
}
