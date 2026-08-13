import * as tls from 'tls';
import { createHash } from 'crypto';
import { logger } from '../logger';
import type { SyncIdentity } from './deviceIdentity';

/**
 * TLS transport for sync. Both sides present self-signed certs; X.509 chain
 * validation is deliberately OFF (`rejectUnauthorized: false`) because trust
 * is by certificate PINNING, not PKI: callers receive the peer's cert
 * fingerprint and decide — paired (fingerprint matches sync_peers), pairable
 * (pairing mode active), or dropped. A connection with no client cert yields
 * an empty fingerprint and is always dropped.
 */

export interface TlsPeer {
  socket: tls.TLSSocket;
  /** Lowercase hex sha256 of the peer cert DER; '' if absent. */
  fingerprint: string;
}

function peerFingerprint(socket: tls.TLSSocket): string {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.raw) return '';
  return createHash('sha256').update(cert.raw).digest('hex');
}

export function startTlsServer(
  identity: SyncIdentity,
  port: number,
  onConnection: (peer: TlsPeer) => void,
): Promise<{ server: tls.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = tls.createServer(
      {
        key: identity.keyPem,
        cert: identity.certPem,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (socket) => {
        const fingerprint = peerFingerprint(socket);
        if (!fingerprint) {
          logger.warn('[sync] Dropping connection without client certificate');
          socket.destroy();
          return;
        }
        onConnection({ socket, fingerprint });
      },
    );
    server.on('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      logger.info('[sync] TLS server listening', { port: boundPort });
      resolve({ server, port: boundPort });
    });
  });
}

export function connectTls(
  identity: SyncIdentity,
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<TlsPeer> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        key: identity.keyPem,
        cert: identity.certPem,
        rejectUnauthorized: false,
      },
      () => {
        clearTimeout(timer);
        const fingerprint = peerFingerprint(socket);
        if (!fingerprint) {
          socket.destroy();
          reject(new Error('Peer presented no certificate'));
          return;
        }
        resolve({ socket, fingerprint });
      },
    );
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    }, timeoutMs);
    timer.unref?.();
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
