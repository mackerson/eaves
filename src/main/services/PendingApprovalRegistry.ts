import { logger } from './logger';
import { eventBus } from './EventBus';
import { randomUUID } from 'crypto';

/**
 * Registry of in-flight tool approval requests.
 *
 * The AI SDK v6 emits a `tool-approval-request` part when a tool's
 * `needsApproval` predicate returns true. The stream then ends without
 * running execute. We persist the approval as a contentBlock on the
 * assistant message and register a fast-path entry here keyed by
 * `approvalId` so the resume IPC handler can dispatch.
 *
 * The registry is in-memory: on app restart, persisted contentBlocks
 * still carry enough state (approvalId + toolCallId + chatId/channelId
 * + agentId + messageId) for the resume handler to reconstruct without
 * a registry hit. The registry is a fast path, not authoritative state.
 */

export interface PendingApprovalEntry {
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

/**
 * How long an unresolved entry stays in the fast path.
 *
 * Nothing ever removed an entry except `resolve`, so an approval the user
 * simply never answered — a chat they abandoned, a channel turn that errored
 * out — stayed in the map for the lifetime of the process, along with its
 * `input`, which is whole tool arguments. `createdAt` was already recorded and
 * never read.
 *
 * Dropping one is safe precisely because this registry is not authoritative:
 * the persisted contentBlock still carries approvalId, toolCallId, context id,
 * agentId and messageId, which is everything the resume handler needs to
 * reconstruct without a registry hit.
 */
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;

export class PendingApprovalRegistry {
  private entries = new Map<string, PendingApprovalEntry>();

  generateApprovalId(): string {
    return `appr_${randomUUID()}`;
  }

  /**
   * Drop entries past MAX_ENTRY_AGE_MS. Swept on write rather than on a timer:
   * the map is small, and a registry that only grows when something is added
   * needs no background work to stay bounded.
   */
  private pruneStale(now: number): void {
    for (const [approvalId, entry] of this.entries) {
      if (now - entry.createdAt > MAX_ENTRY_AGE_MS) {
        this.entries.delete(approvalId);
        logger.debug('[PendingApprovalRegistry] pruned stale entry', { approvalId });
      }
    }
  }

  register(entry: Omit<PendingApprovalEntry, 'createdAt'>): PendingApprovalEntry {
    const now = Date.now();
    this.pruneStale(now);
    const full: PendingApprovalEntry = { ...entry, createdAt: now };
    this.entries.set(entry.approvalId, full);
    logger.info('[PendingApprovalRegistry] registered', {
      approvalId: entry.approvalId,
      toolName: entry.toolName,
      context: entry.context,
      contextId: entry.contextId,
      messageId: entry.messageId,
    });
    eventBus.emitEvent('approval:requested', { ...full });
    return full;
  }

  get(approvalId: string): PendingApprovalEntry | undefined {
    return this.entries.get(approvalId);
  }

  resolve(approvalId: string): PendingApprovalEntry | undefined {
    const entry = this.entries.get(approvalId);
    this.entries.delete(approvalId);
    if (entry) {
      logger.info('[PendingApprovalRegistry] resolved', { approvalId });
      eventBus.emitEvent('approval:resolved', { approvalId });
    }
    return entry;
  }

  listForContext(context: 'chat' | 'channel', contextId: string): PendingApprovalEntry[] {
    return Array.from(this.entries.values()).filter(
      e => e.context === context && e.contextId === contextId,
    );
  }

  listAll(): PendingApprovalEntry[] {
    return Array.from(this.entries.values());
  }

  clear(): void {
    this.entries.clear();
  }
}

let instance: PendingApprovalRegistry | null = null;

export function getPendingApprovalRegistry(): PendingApprovalRegistry {
  if (!instance) instance = new PendingApprovalRegistry();
  return instance;
}
