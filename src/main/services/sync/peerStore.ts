import type Database from 'better-sqlite3';

/** CRUD over sync_peers — paired devices and their replication watermarks. */

export interface SyncPeer {
  deviceId: string;
  deviceName: string;
  certFingerprint: string;
  pairedAt: number;
  lastSeenAt: number | null;
  /** Their oplog seq we have applied (we request > this). */
  lastAppliedSeq: number;
  /** Our oplog seq they have acked (safe to prune ≤ this). */
  lastAckedSeq: number;
}

interface PeerRow {
  device_id: string;
  device_name: string;
  cert_fingerprint: string;
  paired_at: number;
  last_seen_at: number | null;
  last_applied_seq: number;
  last_acked_seq: number;
}

function toPeer(row: PeerRow): SyncPeer {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    certFingerprint: row.cert_fingerprint,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    lastAppliedSeq: row.last_applied_seq,
    lastAckedSeq: row.last_acked_seq,
  };
}

export function getPeer(db: Database.Database, deviceId: string): SyncPeer | undefined {
  const row = db.prepare('SELECT * FROM sync_peers WHERE device_id = ?').get(deviceId) as PeerRow | undefined;
  return row ? toPeer(row) : undefined;
}

export function getPeerByFingerprint(db: Database.Database, fingerprint: string): SyncPeer | undefined {
  const row = db.prepare('SELECT * FROM sync_peers WHERE cert_fingerprint = ?').get(fingerprint) as PeerRow | undefined;
  return row ? toPeer(row) : undefined;
}

export function listPeers(db: Database.Database): SyncPeer[] {
  const rows = db.prepare('SELECT * FROM sync_peers ORDER BY paired_at').all() as PeerRow[];
  return rows.map(toPeer);
}

export function addPeer(
  db: Database.Database,
  peer: { deviceId: string; deviceName: string; certFingerprint: string },
): void {
  db.prepare(`
    INSERT INTO sync_peers (device_id, device_name, cert_fingerprint, paired_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      device_name = excluded.device_name,
      cert_fingerprint = excluded.cert_fingerprint
  `).run(peer.deviceId, peer.deviceName, peer.certFingerprint, Date.now(), Date.now());
}

export function removePeer(db: Database.Database, deviceId: string): void {
  db.prepare('DELETE FROM sync_peers WHERE device_id = ?').run(deviceId);
}

export function updateAppliedSeq(db: Database.Database, deviceId: string, seq: number): void {
  db.prepare(`
    UPDATE sync_peers SET last_applied_seq = MAX(last_applied_seq, ?), last_seen_at = ?
    WHERE device_id = ?
  `).run(seq, Date.now(), deviceId);
}

export function updateAckedSeq(db: Database.Database, deviceId: string, seq: number): void {
  db.prepare(`
    UPDATE sync_peers SET last_acked_seq = MAX(last_acked_seq, ?), last_seen_at = ?
    WHERE device_id = ?
  `).run(seq, Date.now(), deviceId);
}
