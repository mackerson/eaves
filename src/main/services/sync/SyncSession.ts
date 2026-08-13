import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import { logger } from '../logger';
import { applyRemoteChanges, getChangesSince, pruneChanges } from './changeLog';
import { updateAppliedSeq, updateAckedSeq, getPeer } from './peerStore';
import type { SyncConnection } from './SyncConnection';
import type { SyncMessage } from './messages';

/**
 * Drives one paired, authenticated connection through the sync protocol.
 * Fully symmetric — both ends run the same code:
 *
 *   A → sync-request{sinceSeq: watermark}     B → sync-request{...}
 *   B → changes{...}                           A → changes{...}
 *   A → apply + changes-ack                    B → apply + changes-ack
 *   B → next batch if any                      ...
 *
 * Watermarks only advance on apply (theirs) and ack (ours), so a dropped
 * connection re-sends at worst one batch, and apply is idempotent.
 *
 * Events:
 *   'applied'  (tables: string[])  — remote changes landed; UI should refresh
 *   'caught-up'                    — peer acked everything we have
 */
export class SyncSession extends EventEmitter {
  private db: Database.Database;
  private ourDeviceId: string;
  private peerDeviceId: string;
  private conn: SyncConnection;
  /** One outstanding batch at a time; seq the in-flight batch covers up to. */
  private inFlightUpTo: number | null = null;
  /** Set when local changes appear while a batch is already in flight. */
  private moreQueued = false;

  constructor(db: Database.Database, ourDeviceId: string, conn: SyncConnection) {
    super();
    this.db = db;
    this.ourDeviceId = ourDeviceId;
    this.conn = conn;
    const hello = conn.hello;
    if (!hello) throw new Error('SyncSession requires a completed hello exchange');
    this.peerDeviceId = hello.deviceId;

    conn.on('message', (message) => {
      try {
        this.onMessage(message);
      } catch (err) {
        logger.error('[sync] Session error, closing connection', {
          peer: this.peerDeviceId,
          error: err instanceof Error ? err.message : String(err),
        });
        conn.close('session error');
      }
    });
  }

  /** Kick off: ask the peer for everything after our stored watermark. */
  start(): void {
    const peer = getPeer(this.db, this.peerDeviceId);
    this.conn.send({ type: 'sync-request', sinceSeq: peer?.lastAppliedSeq ?? 0 });
  }

  /**
   * Local data changed (oplog grew). Sends immediately when idle; otherwise
   * marks a follow-up batch to send after the in-flight one is acked.
   */
  notifyLocalChanges(): void {
    if (this.inFlightUpTo !== null) {
      this.moreQueued = true;
      return;
    }
    const peer = getPeer(this.db, this.peerDeviceId);
    this.sendBatch(peer?.lastAckedSeq ?? 0);
  }

  private onMessage(message: SyncMessage): void {
    switch (message.type) {
      case 'sync-request':
        this.sendBatch(message.sinceSeq);
        break;

      case 'changes': {
        const result = applyRemoteChanges(
          this.db,
          this.ourDeviceId,
          this.peerDeviceId,
          message.changes,
        );
        updateAppliedSeq(this.db, this.peerDeviceId, message.upToSeq);
        this.conn.send({ type: 'changes-ack', upToSeq: message.upToSeq });
        if (result.applied > 0) {
          const tables = [...new Set(message.changes.map(c => c.table))];
          this.emit('applied', tables);
        }
        logger.info('[sync] Applied batch', {
          peer: this.peerDeviceId,
          ...result,
          upToSeq: message.upToSeq,
        });
        break;
      }

      case 'changes-ack': {
        updateAckedSeq(this.db, this.peerDeviceId, message.upToSeq);
        pruneChanges(this.db);
        this.inFlightUpTo = null;
        // Anything new since this ack (concurrent writes, queued notify)?
        const next = getChangesSince(this.db, message.upToSeq, 1);
        if (this.moreQueued || next.changes.length > 0) {
          this.moreQueued = false;
          this.sendBatch(message.upToSeq);
        } else {
          this.emit('caught-up');
        }
        break;
      }

      default:
        // pair-* messages are handled before a session exists; hello/bye are
        // consumed by SyncConnection. Anything else here is unexpected but
        // harmless — log and move on.
        logger.warn('[sync] Unexpected message in session', { type: message.type });
    }
  }

  private sendBatch(sinceSeq: number): void {
    if (this.inFlightUpTo !== null) {
      this.moreQueued = true;
      return;
    }
    const batch = getChangesSince(this.db, sinceSeq);
    if (batch.changes.length === 0) {
      // Nothing to send — tell the peer they're caught up at their watermark.
      this.conn.send({ type: 'changes', changes: [], upToSeq: batch.upToSeq });
      return;
    }
    this.inFlightUpTo = batch.upToSeq;
    this.conn.send({ type: 'changes', changes: batch.changes, upToSeq: batch.upToSeq });
  }
}
