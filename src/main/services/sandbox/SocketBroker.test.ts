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
