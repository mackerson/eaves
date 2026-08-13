import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import type * as tls from 'tls';
import { logger } from '../logger';
import { eventBus } from '../EventBus';
import { getDatabase } from '../database';
import { resetApplyGuard, pruneChanges } from './changeLog';
import {
  getSyncIdentity,
  setDeviceName,
  setSyncEnabled,
  pairingCode,
  type SyncIdentity,
} from './deviceIdentity';
import { addPeer, getPeerByFingerprint, listPeers, removePeer } from './peerStore';
import type { SyncStateSnapshot } from '../../../shared/ipc-types';
import { DiscoveryService, type DiscoveredDevice } from './DiscoveryService';
import { startTlsServer, connectTls, type TlsPeer } from './tlsTransport';
import { SyncConnection } from './SyncConnection';
import { SyncSession } from './SyncSession';
import { SYNC_PROTOCOL_VERSION, type SyncHello } from './messages';

/**
 * Orchestrates LAN sync: TLS server, mDNS discovery, pairing, and one
 * SyncSession per paired peer.
 *
 * Pairing dance (symmetric; either side may initiate):
 *   1. TLS connect — both certs exchanged, fingerprints extracted
 *   2. hello exchange — versions checked
 *   3. unknown peer + pairing mode on both ends → each shows the same 6-digit
 *      SAS code (derived from the unordered fingerprint pair)
 *   4. user confirms on BOTH devices → pair-confirm crosses both ways →
 *      peer pinned in sync_peers → session starts
 */

interface PendingPair {
  conn: SyncConnection;
  hello: SyncHello;
  fingerprint: string;
  code: string;
  localConfirmed: boolean;
  remoteConfirmed: boolean;
}

interface ActiveSession {
  conn: SyncConnection;
  session: SyncSession;
  deviceName: string;
  /** True when we dialed out (used to tie-break duplicate connections). */
  outbound: boolean;
}

export type { SyncStateSnapshot } from '../../../shared/ipc-types';

const LIVE_POLL_MS = 2_000;

export class SyncService {
  private getMainWindow: () => BrowserWindow | null;
  private db: Database.Database | null = null;
  private identity: SyncIdentity | null = null;
  private server: tls.Server | null = null;
  private port: number | null = null;
  private discovery: DiscoveryService | null = null;
  private sessions = new Map<string, ActiveSession>();
  private pairingMode = false;
  private pending: PendingPair | null = null;
  private livePollTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private lastSeenSeq = 0;
  private eventCleanups: Array<() => void> = [];
  private running = false;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
  }

  /** Called at app startup. Only brings the stack up if the user enabled sync. */
  async start(): Promise<void> {
    this.db = getDatabase();
    resetApplyGuard(this.db);

    // Change-capture triggers fire for every install (gated on applying=0, not
    // enabled), so the oplog grows even for users who never pair a device — and
    // pruneChanges is otherwise reached only from an active peer session. Trim
    // it on startup and daily, regardless of whether sync is on, so a no-peer
    // install never accumulates the oplog without bound.
    this.pruneChangeLog();
    this.pruneTimer = setInterval(() => this.pruneChangeLog(), 24 * 60 * 60 * 1000);
    this.pruneTimer.unref?.();

    const identity = await getSyncIdentity(this.db);
    if (identity.enabled) {
      await this.bringUp();
    }
  }

  private pruneChangeLog(): void {
    try {
      if (!this.db) return;
      const removed = pruneChanges(this.db);
      if (removed > 0) {
        logger.info(`[Sync] Pruned ${removed} change-log rows`);
      }
    } catch (error) {
      logger.warn('[Sync] Failed to prune change log', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const db = this.requireDb();
    setSyncEnabled(db, enabled);
    if (enabled && !this.running) {
      await this.bringUp();
    } else if (!enabled && this.running) {
      this.bringDown();
    }
    this.pushState();
  }

  setDeviceName(name: string): void {
    const db = this.requireDb();
    setDeviceName(db, name);
    if (this.identity) this.identity = { ...this.identity, deviceName: name };
    // Discovery advertises the name; restart it to re-publish.
    if (this.running && this.discovery && this.port) {
      this.discovery.stop();
      this.startDiscovery();
    }
    this.pushState();
  }

  setPairingMode(active: boolean): void {
    this.pairingMode = active;
    if (!active && this.pending) {
      this.pending.conn.close('pairing cancelled');
      this.pending = null;
    }
    this.pushState();
  }

  /** User confirmed the SAS code on this device. */
  confirmPairing(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.localConfirmed = true;
    pending.conn.send({ type: 'pair-confirm' });
    this.maybeFinishPairing();
    this.pushState();
  }

  rejectPairing(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.conn.send({ type: 'pair-reject', reason: 'rejected by user' });
    pending.conn.close('pairing rejected');
    this.pending = null;
    this.pushState();
  }

  /** Dial a discovered (or manually-specified) device to pair or sync. */
  async connectToDevice(host: string, port: number): Promise<void> {
    const identity = await this.requireIdentity();
    const peer = await connectTls(identity, host, port);
    this.adoptConnection(peer, true);
  }

  unpair(deviceId: string): void {
    const db = this.requireDb();
    const active = this.sessions.get(deviceId);
    if (active) {
      active.conn.close('unpaired');
      this.sessions.delete(deviceId);
    }
    removePeer(db, deviceId);
    this.pushState();
  }

  getState(): SyncStateSnapshot {
    const db = this.requireDb();
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    return {
      enabled: this.identity?.enabled ?? isEnabledInDb(db),
      running: this.running,
      deviceId: this.identity?.deviceId ?? '',
      deviceName: this.identity?.deviceName ?? '',
      fingerprint: this.identity?.fingerprint ?? null,
      port: this.port,
      pairingMode: this.pairingMode,
      pendingPair: this.pending
        ? {
            deviceId: this.pending.hello.deviceId,
            deviceName: this.pending.hello.deviceName,
            code: this.pending.code,
            localConfirmed: this.pending.localConfirmed,
          }
        : null,
      peers: listPeers(db).map(p => ({ ...p, online: this.sessions.has(p.deviceId) })),
      discovered: this.discovery?.list() ?? [],
      schemaVersion,
    };
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.bringDown();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  private async bringUp(): Promise<void> {
    const db = this.requireDb();
    this.identity = await getSyncIdentity(db);
    const { server, port } = await startTlsServer(this.identity, 0, (peer) =>
      this.adoptConnection(peer, false),
    );
    this.server = server;
    this.port = port;
    this.running = true;
    this.lastSeenSeq = currentMaxSeq(db);

    this.startDiscovery();

    // Live propagation: poll the oplog tail, with EventBus nudges so chat
    // traffic feels instant instead of waiting out the poll interval.
    this.livePollTimer = setInterval(() => this.checkForLocalChanges(), LIVE_POLL_MS);
    this.livePollTimer.unref?.();
    for (const event of ['message:created', 'message:updated'] as const) {
      this.eventCleanups.push(
        eventBus.onEvent(event, () => this.checkForLocalChanges()),
      );
    }

    logger.info('[sync] Service up', { port, deviceId: this.identity.deviceId });
    this.pushState();
  }

  private bringDown(): void {
    for (const active of this.sessions.values()) {
      active.conn.close('sync disabled');
    }
    this.sessions.clear();
    this.pending?.conn.close('sync disabled');
    this.pending = null;
    this.pairingMode = false;
    this.discovery?.stop();
    this.discovery = null;
    this.server?.close();
    this.server = null;
    this.port = null;
    if (this.livePollTimer) {
      clearInterval(this.livePollTimer);
      this.livePollTimer = null;
    }
    for (const cleanup of this.eventCleanups) cleanup();
    this.eventCleanups = [];
    this.running = false;
    logger.info('[sync] Service down');
    this.pushState();
  }

  private startDiscovery(): void {
    if (!this.identity || !this.port) return;
    this.discovery = new DiscoveryService(this.identity.deviceId);
    this.discovery.on('device-up', (device: DiscoveredDevice) => {
      this.pushState();
      this.autoConnectIfPaired(device);
    });
    this.discovery.on('device-down', () => this.pushState());
    this.discovery.start(this.identity.deviceName, this.port).catch((err) => {
      logger.error('[sync] Discovery failed to start', { error: err?.message });
    });
  }

  private autoConnectIfPaired(device: DiscoveredDevice): void {
    const db = this.requireDb();
    const known = listPeers(db).some(p => p.deviceId === device.deviceId);
    if (!known || this.sessions.has(device.deviceId)) return;
    this.connectToDevice(device.host, device.port).catch((err) => {
      logger.warn('[sync] Auto-connect to paired device failed', {
        device: device.deviceId, error: err?.message,
      });
    });
  }

  // ── connection handling ────────────────────────────────────────────────

  private adoptConnection(peer: TlsPeer, outbound: boolean): void {
    const conn = new SyncConnection(peer.socket, peer.fingerprint);

    conn.on('hello', (hello) => this.onHello(conn, hello, outbound));
    conn.on('close', () => {
      this.dropSessionFor(conn);
      if (this.pending?.conn === conn) {
        this.pending = null;
        this.pushState();
      }
    });

    const identity = this.identity!;
    const db = this.requireDb();
    conn.send({
      type: 'hello',
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
    });
  }

  private onHello(conn: SyncConnection, hello: SyncHello, outbound: boolean): void {
    const db = this.requireDb();

    if (hello.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      conn.close(`protocol version mismatch (ours ${SYNC_PROTOCOL_VERSION}, theirs ${hello.protocolVersion})`);
      return;
    }
    const ourSchema = db.pragma('user_version', { simple: true }) as number;
    if (hello.schemaVersion !== ourSchema) {
      logger.warn('[sync] Schema mismatch, refusing to sync', {
        ours: ourSchema, theirs: hello.schemaVersion, peer: hello.deviceId,
      });
      this.sendToRenderer('sync:schema-mismatch', {
        peerName: hello.deviceName, ours: ourSchema, theirs: hello.schemaVersion,
      });
      conn.close('schema version mismatch — update the older device');
      return;
    }

    const known = getPeerByFingerprint(db, conn.peerFingerprint);
    if (known) {
      // Identity check: the pinned fingerprint must belong to the device id
      // it claimed at pairing time. A paired device presenting a different id
      // is either misconfigured or impersonating — drop it.
      if (known.deviceId !== hello.deviceId) {
        conn.close('device id does not match pinned certificate');
        return;
      }
      this.startSession(conn, hello, outbound);
      return;
    }

    // Unknown device: only entertain it while the user has pairing mode open.
    if (!this.pairingMode || this.pending) {
      conn.close(this.pending ? 'another pairing is in progress' : 'not accepting pairings');
      return;
    }

    const identity = this.identity!;
    this.pending = {
      conn,
      hello,
      fingerprint: conn.peerFingerprint,
      code: pairingCode(identity.fingerprint, conn.peerFingerprint),
      localConfirmed: false,
      remoteConfirmed: false,
    };
    conn.on('message', (message) => {
      if (message.type === 'pair-confirm' && this.pending?.conn === conn) {
        this.pending.remoteConfirmed = true;
        this.maybeFinishPairing();
        this.pushState();
      } else if (message.type === 'pair-reject' && this.pending?.conn === conn) {
        this.pending = null;
        conn.close('peer rejected pairing');
        this.pushState();
      }
    });
    logger.info('[sync] Pairing candidate', {
      device: hello.deviceId, name: hello.deviceName, code: this.pending.code,
    });
    this.pushState();
  }

  private maybeFinishPairing(): void {
    const pending = this.pending;
    if (!pending || !pending.localConfirmed || !pending.remoteConfirmed) return;

    const db = this.requireDb();
    addPeer(db, {
      deviceId: pending.hello.deviceId,
      deviceName: pending.hello.deviceName,
      certFingerprint: pending.fingerprint,
    });
    logger.info('[sync] Paired', { device: pending.hello.deviceId, name: pending.hello.deviceName });
    this.pending = null;
    this.pairingMode = false;
    this.startSession(pending.conn, pending.hello, false);
  }

  private startSession(conn: SyncConnection, hello: SyncHello, outbound: boolean): void {
    const existing = this.sessions.get(hello.deviceId);
    if (existing) {
      // Simultaneous dial-out from both ends → two connections. Keep exactly
      // one, decided identically on both devices: the connection whose CLIENT
      // is the lexically-smaller device id survives.
      const identity = this.identity!;
      const keepNew = (identity.deviceId < hello.deviceId) ? outbound : !outbound;
      if (!keepNew) {
        conn.close('duplicate connection');
        return;
      }
      existing.conn.close('replaced by duplicate tie-break');
      this.sessions.delete(hello.deviceId);
    }

    const db = this.requireDb();
    const identity = this.identity!;
    const session = new SyncSession(db, identity.deviceId, conn);
    session.on('applied', (tables: string[]) => {
      this.sendToRenderer('sync:applied', { tables, from: hello.deviceId });
    });
    this.sessions.set(hello.deviceId, { conn, session, deviceName: hello.deviceName, outbound });
    session.start();
    logger.info('[sync] Session started', { peer: hello.deviceId, outbound });
    this.pushState();
  }

  private dropSessionFor(conn: SyncConnection): void {
    for (const [deviceId, active] of this.sessions) {
      if (active.conn === conn) {
        this.sessions.delete(deviceId);
        logger.info('[sync] Session ended', { peer: deviceId });
        this.pushState();
        return;
      }
    }
  }

  private checkForLocalChanges(): void {
    if (!this.db || this.sessions.size === 0) return;
    const maxSeq = currentMaxSeq(this.db);
    if (maxSeq <= this.lastSeenSeq) return;
    this.lastSeenSeq = maxSeq;
    for (const active of this.sessions.values()) {
      active.session.notifyLocalChanges();
    }
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private requireDb(): Database.Database {
    if (!this.db) this.db = getDatabase();
    return this.db;
  }

  private async requireIdentity(): Promise<SyncIdentity> {
    if (!this.identity) this.identity = await getSyncIdentity(this.requireDb());
    return this.identity;
  }

  private pushState(): void {
    this.sendToRenderer('sync:state', this.getState());
  }

  private sendToRenderer(channel: string, data: unknown): void {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

function currentMaxSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_changes').get() as { m: number };
  return row.m;
}

function isEnabledInDb(db: Database.Database): boolean {
  const row = db.prepare('SELECT enabled FROM sync_meta WHERE id = 1').get() as { enabled: number } | undefined;
  return row?.enabled === 1;
}

// Singleton, matching the codebase's service pattern.
let instance: SyncService | null = null;

export function getSyncService(getMainWindow?: () => BrowserWindow | null): SyncService {
  if (!instance) {
    instance = new SyncService(getMainWindow ?? (() => null));
  }
  return instance;
}
