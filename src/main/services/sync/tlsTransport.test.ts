import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../migrations';
import { getSyncIdentity, type SyncIdentity } from './deviceIdentity';
import { startTlsServer, connectTls } from './tlsTransport';
import { SyncConnection } from './SyncConnection';

async function makeIdentity(): Promise<SyncIdentity> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, 0);
  const identity = await getSyncIdentity(db);
  db.close();
  return identity;
}

describe('tlsTransport', () => {
  it('mutually authenticates by certificate fingerprint over real TLS', async () => {
    const serverIdentity = await makeIdentity();
    const clientIdentity = await makeIdentity();

    const seen: string[] = [];
    const { server, port } = await startTlsServer(serverIdentity, 0, (peer) => {
      seen.push(peer.fingerprint);
      peer.socket.destroy();
    });

    try {
      const client = await connectTls(clientIdentity, '127.0.0.1', port);
      // Each side sees exactly the other's published fingerprint.
      expect(client.fingerprint).toBe(serverIdentity.fingerprint);
      await new Promise(r => setTimeout(r, 50));
      expect(seen).toEqual([clientIdentity.fingerprint]);
      client.socket.destroy();
    } finally {
      server.close();
    }
  }, 60_000);

  it('carries SyncConnection traffic end to end', async () => {
    const serverIdentity = await makeIdentity();
    const clientIdentity = await makeIdentity();

    let serverConn: SyncConnection | null = null;
    const { server, port } = await startTlsServer(serverIdentity, 0, (peer) => {
      serverConn = new SyncConnection(peer.socket, peer.fingerprint);
      serverConn.send({
        type: 'hello', deviceId: 'srv', deviceName: 'Server',
        protocolVersion: 1, schemaVersion: 51,
      });
    });

    try {
      const client = await connectTls(clientIdentity, '127.0.0.1', port);
      const clientConn = new SyncConnection(client.socket, client.fingerprint);
      clientConn.send({
        type: 'hello', deviceId: 'cli', deviceName: 'Client',
        protocolVersion: 1, schemaVersion: 51,
      });

      const deadline = Date.now() + 5000;
      while (!(clientConn.hello && serverConn && (serverConn as SyncConnection).hello)) {
        if (Date.now() > deadline) throw new Error('hello exchange timed out');
        await new Promise(r => setTimeout(r, 10));
      }
      expect(clientConn.hello!.deviceId).toBe('srv');
      expect((serverConn as unknown as SyncConnection).hello!.deviceId).toBe('cli');
      clientConn.close();
    } finally {
      server.close();
    }
  }, 60_000);
});
