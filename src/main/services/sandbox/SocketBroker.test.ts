/**
 * Tests for the host-side TCP/TLS socket broker.
 *
 * What matters: the per-plugin ownership boundary (a plugin can never touch
 * another plugin's socket), the per-plugin cap, data flowing back only
 * through the owner's dispatch, and teardown actually closing sockets. All
 * against a real loopback TCP server — no network mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import * as tls from 'tls';
import { SocketBroker } from './SocketBroker';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('SocketBroker', () => {
  let broker: SocketBroker;
  let server: net.Server;
  let port: number;
  let serverSockets: net.Socket[];

  beforeEach(async () => {
    broker = new SocketBroker();
    serverSockets = [];
    server = net.createServer((socket) => {
      serverSockets.push(socket);
      socket.on('data', (chunk) => socket.write(chunk)); // echo
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    for (const socket of serverSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects, writes, and receives echoed data through dispatch', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { socketId } = await broker.connect(
      'plugin-a',
      { host: '127.0.0.1', port },
      (type, data) => events.push({ type, data })
    );

    const payload = Buffer.from('PING :server\r\n').toString('base64');
    const { bytesWritten } = broker.write('plugin-a', socketId, payload);
    expect(bytesWritten).toBe(14);

    await waitFor(() => events.some((e) => e.type === 'net:socket:data'));
    const dataEvent = events.find((e) => e.type === 'net:socket:data')!;
    expect(dataEvent.data.socketId).toBe(socketId);
    expect(Buffer.from(dataEvent.data.data as string, 'base64').toString()).toBe('PING :server\r\n');
  });

  it('refuses another plugin access to a socket it does not own', async () => {
    const { socketId } = await broker.connect('plugin-a', { host: '127.0.0.1', port }, () => {});

    const payload = Buffer.from('x').toString('base64');
    expect(() => broker.write('plugin-b', socketId, payload)).toThrow(/No such socket/);
    expect(() => broker.end('plugin-b', socketId)).toThrow(/No such socket/);
    expect(() => broker.close('plugin-b', socketId)).toThrow(/No such socket/);

    // The owner still can.
    expect(() => broker.write('plugin-a', socketId, payload)).not.toThrow();
    broker.close('plugin-a', socketId);
  });

  it('enforces the per-plugin socket cap', async () => {
    const opts = { host: '127.0.0.1', port };
    for (let i = 0; i < 8; i++) {
      await broker.connect('plugin-a', opts, () => {});
    }
    await expect(broker.connect('plugin-a', opts, () => {})).rejects.toThrow(/Socket limit/);
    // Another plugin's budget is its own.
    await expect(broker.connect('plugin-b', opts, () => {})).resolves.toBeDefined();
  });

  it('frees the slot when a connect fails', async () => {
    // A port nothing listens on: connection refused.
    const deadServer = net.createServer();
    await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
    const deadPort = (deadServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    await expect(
      broker.connect('plugin-a', { host: '127.0.0.1', port: deadPort }, () => {})
    ).rejects.toThrow();
    expect(broker.socketCount('plugin-a')).toBe(0);
  });

  it('dispatches close to the owner and cleans the registry', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { socketId } = await broker.connect(
      'plugin-a',
      { host: '127.0.0.1', port },
      (type, data) => events.push({ type, data })
    );

    serverSockets[0].destroy(); // remote hangs up

    await waitFor(() => events.some((e) => e.type === 'net:socket:close'));
    expect(broker.socketCount('plugin-a')).toBe(0);
    // A dead socket is gone, not reusable.
    expect(() => broker.write('plugin-a', socketId, Buffer.from('x').toString('base64')))
      .toThrow(/No such socket/);
  });

  it('unregisterWorker destroys every socket the plugin holds', async () => {
    await broker.connect('plugin-a', { host: '127.0.0.1', port }, () => {});
    await broker.connect('plugin-a', { host: '127.0.0.1', port }, () => {});
    const other = await broker.connect('plugin-b', { host: '127.0.0.1', port }, () => {});

    broker.unregisterWorker('plugin-a');

    expect(broker.socketCount('plugin-a')).toBe(0);
    expect(broker.socketCount('plugin-b')).toBe(1);
    broker.close('plugin-b', other.socketId);
  });

  it('validates connect options and bounds writes', async () => {
    await expect(broker.connect('plugin-a', { host: '', port }, () => {})).rejects.toThrow(/host/);
    await expect(
      broker.connect('plugin-a', { host: '127.0.0.1', port: 0 }, () => {})
    ).rejects.toThrow(/port/);
    await expect(
      broker.connect('plugin-a', { host: '127.0.0.1', port: 70000 }, () => {})
    ).rejects.toThrow(/port/);

    const { socketId } = await broker.connect('plugin-a', { host: '127.0.0.1', port }, () => {});
    const oversized = Buffer.alloc(1024 * 1024 + 1).toString('base64');
    expect(() => broker.write('plugin-a', socketId, oversized)).toThrow(/exceeds/);
    broker.close('plugin-a', socketId);
  });
});

/**
 * STARTTLS upgrade tests against a real loopback server that speaks plaintext
 * first and wraps the connection in TLS on command — the IMAP/SMTP/IRC shape.
 *
 * Verification is mandatory with no opt-out, so the trusted fixture cert is
 * appended to the process default CA list for the duration of each test
 * (tls.setDefaultCACertificates, Node >= 22.15) and restored after. The
 * untrusted cert is never added, which is what proves the no-opt-out claim.
 *
 * The keys below are test-only, self-signed, loopback-only (SAN IP:127.0.0.1)
 * EC P-256 material — not secrets.
 */
const TRUSTED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbzSCBucUo8rXj+yy
60QqwLoYZqHEivceDgbUEaHJCrehRANCAARbhufzQdxp7otsYHW4yfZvcCIIkpqM
MJD4vFKKsM52xwBjqGspEfSewlLQzvuctK7xrEBrwy0ASamb/6GvM2rT
-----END PRIVATE KEY-----`;
const TRUSTED_CERT = `-----BEGIN CERTIFICATE-----
MIIBojCCAUigAwIBAgIUMAaTj1GLyO3EYcx6+dnLK26D/JcwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSZWF2ZXMtdGVzdC10cnVzdGVkMCAXDTI2MTAwMTIwNDk1NVoY
DzIxMjYwOTA3MjA0OTU1WjAdMRswGQYDVQQDDBJlYXZlcy10ZXN0LXRydXN0ZWQw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARbhufzQdxp7otsYHW4yfZvcCIIkpqM
MJD4vFKKsM52xwBjqGspEfSewlLQzvuctK7xrEBrwy0ASamb/6GvM2rTo2QwYjAd
BgNVHQ4EFgQUh4fJYFD9b51wnIwts1jvjt5hdq0wHwYDVR0jBBgwFoAUh4fJYFD9
b51wnIwts1jvjt5hdq0wDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAAB
MAoGCCqGSM49BAMCA0gAMEUCIBjPWRUOw2zYnhAdHSTyqHeUh2Q14qYdHF2bgZn9
Sz1aAiEAheMZQ5FjXtHjE1SCxVX+rIzYndj15bXmavZzmo5k/M4=
-----END CERTIFICATE-----`;
const UNTRUSTED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJmKEgUp97QQWkcFi
PSudN029y6QRU9O/zC8r8CGTpsGhRANCAATZL75cwODkFc8XV0jcNMGTsug/L00w
wWNh6TMmuuisUKzwc6yN5SNYLf4EcBIXulA1nQwZ0xKdp6vJPJc/GWDh
-----END PRIVATE KEY-----`;
const UNTRUSTED_CERT = `-----BEGIN CERTIFICATE-----
MIIBpTCCAUygAwIBAgIUCWhiSfYvvkNEAeCkIXwQBOdbPlswCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUZWF2ZXMtdGVzdC11bnRydXN0ZWQwIBcNMjYxMDAxMjA0OTU1
WhgPMjEyNjA5MDcyMDQ5NTVaMB8xHTAbBgNVBAMMFGVhdmVzLXRlc3QtdW50cnVz
dGVkMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2S++XMDg5BXPF1dI3DTBk7Lo
Py9NMMFjYekzJrrorFCs8HOsjeUjWC3+BHASF7pQNZ0MGdMSnaeryTyXPxlg4aNk
MGIwHQYDVR0OBBYEFK17AUfySfP4PiOaf+PZJDqJil6WMB8GA1UdIwQYMBaAFK17
AUfySfP4PiOaf+PZJDqJil6WMA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocE
fwAAATAKBggqhkjOPQQDAgNHADBEAiBqQSbsynfQX1Et1aBt6hLuwzFlufFi0cfo
HE415nN+IAIgQud0JxlK2Z6I90PrPOjQ+vM7JOCbRbpIiv+el06xZAg=
-----END CERTIFICATE-----`;

describe('SocketBroker.upgradeTls (STARTTLS)', () => {
  let broker: SocketBroker;
  let server: net.Server;
  let port: number;
  let serverSockets: net.Socket[];
  let savedCAs: string[];

  beforeEach(() => {
    broker = new SocketBroker();
    serverSockets = [];
    savedCAs = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...savedCAs, TRUSTED_CERT]);
  });

  afterEach(async () => {
    tls.setDefaultCACertificates(savedCAs);
    for (const socket of serverSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Plaintext echo server until a line starting with STARTTLS arrives; then
   * it answers "OK\n" and wraps the connection server-side. 'silent' answers
   * OK but never starts TLS, leaving the client handshake pending forever.
   */
  const startServer = async (mode: 'tls' | 'untrusted-tls' | 'silent'): Promise<void> => {
    server = net.createServer((socket) => {
      serverSockets.push(socket);
      socket.on('data', (chunk) => {
        if (!chunk.toString().startsWith('STARTTLS')) {
          socket.write(chunk); // plaintext echo
          return;
        }
        socket.removeAllListeners('data');
        socket.write('OK\n', () => {
          if (mode === 'silent') return;
          const secure = new tls.TLSSocket(socket, {
            isServer: true,
            secureContext: tls.createSecureContext(
              mode === 'tls'
                ? { key: TRUSTED_KEY, cert: TRUSTED_CERT }
                : { key: UNTRUSTED_KEY, cert: UNTRUSTED_CERT }
            ),
          });
          secure.on('data', (c: Buffer) => secure.write(c)); // echo over TLS
          secure.on('error', () => {});
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  };

  const b64 = (s: string) => Buffer.from(s).toString('base64');

  /** Connect plaintext and drive the STARTTLS exchange up to the server's OK. */
  const connectAndStartTls = async (pluginId = 'plugin-a') => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const dispatch = (type: string, data: Record<string, unknown>) => events.push({ type, data });
    const { socketId } = await broker.connect(pluginId, { host: '127.0.0.1', port }, dispatch);
    broker.write(pluginId, socketId, b64('STARTTLS\n'));
    await waitFor(() => events.some((e) => e.type === 'net:socket:data'));
    return { socketId, events, dispatch };
  };

  it('upgrades in place and keeps data events flowing on the same socketId', async () => {
    await startServer('tls');
    const { socketId, events, dispatch } = await connectAndStartTls();

    await broker.upgradeTls('plugin-a', socketId, dispatch);

    const before = events.filter((e) => e.type === 'net:socket:data').length;
    broker.write('plugin-a', socketId, b64('hello over tls\n'));
    await waitFor(() => events.filter((e) => e.type === 'net:socket:data').length > before);
    const last = events.filter((e) => e.type === 'net:socket:data').pop()!;
    expect(last.data.socketId).toBe(socketId);
    expect(Buffer.from(last.data.data as string, 'base64').toString()).toBe('hello over tls\n');
    broker.close('plugin-a', socketId);
  });

  it('dispatches close to the owner after an upgrade', async () => {
    await startServer('tls');
    const { socketId, events, dispatch } = await connectAndStartTls();
    await broker.upgradeTls('plugin-a', socketId, dispatch);

    serverSockets[0].destroy(); // remote hangs up post-upgrade

    await waitFor(() => events.some((e) => e.type === 'net:socket:close'));
    expect(events.find((e) => e.type === 'net:socket:close')!.data.socketId).toBe(socketId);
    expect(broker.socketCount('plugin-a')).toBe(0);
  });

  it('refuses to upgrade a socket another plugin owns', async () => {
    await startServer('tls');
    const { socketId, dispatch } = await connectAndStartTls();

    await expect(broker.upgradeTls('plugin-b', socketId, () => {})).rejects.toThrow(/No such socket/);

    // The owner still can.
    await expect(broker.upgradeTls('plugin-a', socketId, dispatch)).resolves.toBeUndefined();
    broker.close('plugin-a', socketId);
  });

  it('refuses a double upgrade', async () => {
    await startServer('tls');
    const { socketId, dispatch } = await connectAndStartTls();
    await broker.upgradeTls('plugin-a', socketId, dispatch);

    await expect(broker.upgradeTls('plugin-a', socketId, dispatch)).rejects.toThrow(/already TLS/);
    broker.close('plugin-a', socketId);
  });

  it('rejects writes while the handshake is in flight', async () => {
    await startServer('silent');
    const { socketId, events, dispatch } = await connectAndStartTls();

    const pending = broker.upgradeTls('plugin-a', socketId, dispatch);
    expect(() => broker.write('plugin-a', socketId, b64('x'))).toThrow(/upgrade in progress/);

    // Server drops the connection mid-handshake: the upgrade fails, the
    // socket is gone, and the owner hears about it.
    serverSockets[0].destroy();
    await expect(pending).rejects.toThrow();
    expect(broker.socketCount('plugin-a')).toBe(0);
    expect(events.some((e) => e.type === 'net:socket:close')).toBe(true);
  });

  it('refuses an untrusted certificate — verification has no opt-out', async () => {
    await startServer('untrusted-tls');
    const { socketId, dispatch } = await connectAndStartTls();

    await expect(broker.upgradeTls('plugin-a', socketId, dispatch)).rejects.toThrow(/self.?signed|certificate/i);
    // A failed handshake is terminal: the socket is destroyed and freed.
    expect(broker.socketCount('plugin-a')).toBe(0);
    expect(() => broker.write('plugin-a', socketId, b64('x'))).toThrow(/No such socket/);
  });
});
