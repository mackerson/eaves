import type Database from 'better-sqlite3';
import { X509Certificate, createHash } from 'crypto';
import * as os from 'os';
import { logger } from '../logger';

/**
 * This device's sync identity: a stable UUID (seeded into `sync_meta` when the
 * schema is created) plus a lazily-generated self-signed TLS certificate. Trust
 * is by certificate pinning (Syncthing model): pairing records the peer's cert
 * fingerprint, and every later connection must present exactly that cert. The
 * CN carries the device id; no PKI, no expiry-based trust (10-year validity,
 * fingerprint is the actual credential).
 *
 * The private key lives in the DB next to the (encrypted) API keys — same
 * machine, same trust domain. It never leaves the device; pairing only ever
 * exchanges certificates.
 */

export interface SyncIdentity {
  deviceId: string;
  deviceName: string;
  certPem: string;
  keyPem: string;
  /** Lowercase hex sha256 of the certificate DER, no separators. */
  fingerprint: string;
  enabled: boolean;
}

interface SyncMetaRow {
  device_id: string;
  device_name: string;
  cert_pem: string | null;
  key_pem: string | null;
  enabled: number;
}

export function certFingerprint(certPem: string): string {
  const cert = new X509Certificate(certPem);
  return cert.fingerprint256.replace(/:/g, '').toLowerCase();
}

function readMeta(db: Database.Database): SyncMetaRow {
  const row = db.prepare(
    'SELECT device_id, device_name, cert_pem, key_pem, enabled FROM sync_meta WHERE id = 1',
  ).get() as SyncMetaRow | undefined;
  if (!row) {
    throw new Error('sync_meta row missing — the baseline schema did not seed it');
  }
  return row;
}

/**
 * Load the identity, generating the certificate on first use. Safe to call
 * repeatedly; generation happens at most once per database.
 */
export async function getSyncIdentity(db: Database.Database): Promise<SyncIdentity> {
  let meta = readMeta(db);

  // Migration seeds a placeholder name; upgrade it to the hostname once.
  if (meta.device_name === 'This device') {
    const name = os.hostname() || 'This device';
    db.prepare('UPDATE sync_meta SET device_name = ? WHERE id = 1').run(name);
    meta = { ...meta, device_name: name };
  }

  if (!meta.cert_pem || !meta.key_pem) {
    // Dynamic import keeps node-forge (selfsigned's engine) off the startup
    // path — it only loads the first time a device actually uses sync.
    const selfsigned = await import('selfsigned');
    // v5 returns a Promise when called without a callback. Validity is set
    // far out on purpose — the fingerprint pin is the credential, not expiry.
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: meta.device_id }],
      {
        keySize: 2048,
        algorithm: 'sha256',
        notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
      },
    );
    db.prepare('UPDATE sync_meta SET cert_pem = ?, key_pem = ? WHERE id = 1')
      .run(generated.cert, generated.private);
    meta = { ...meta, cert_pem: generated.cert, key_pem: generated.private };
    logger.info('[sync] Generated device certificate', {
      deviceId: meta.device_id,
      fingerprint: certFingerprint(generated.cert),
    });
  }

  return {
    deviceId: meta.device_id,
    deviceName: meta.device_name,
    certPem: meta.cert_pem!,
    keyPem: meta.key_pem!,
    fingerprint: certFingerprint(meta.cert_pem!),
    enabled: meta.enabled === 1,
  };
}

export function setDeviceName(db: Database.Database, name: string): void {
  db.prepare('UPDATE sync_meta SET device_name = ? WHERE id = 1').run(name);
}

export function setSyncEnabled(db: Database.Database, enabled: boolean): void {
  db.prepare('UPDATE sync_meta SET enabled = ? WHERE id = 1').run(enabled ? 1 : 0);
}

/**
 * Short authentication string for pairing: both devices derive the same
 * 6-digit code from the unordered pair of cert fingerprints. A MITM that
 * substitutes either certificate changes the code on exactly one screen,
 * which the user-confirms-on-both-devices step catches.
 */
export function pairingCode(fingerprintA: string, fingerprintB: string): string {
  const sorted = [fingerprintA, fingerprintB].sort().join('|');
  const digest = createHash('sha256').update(sorted).digest();
  const num = digest.readUIntBE(0, 4) % 1_000_000;
  return num.toString().padStart(6, '0');
}
