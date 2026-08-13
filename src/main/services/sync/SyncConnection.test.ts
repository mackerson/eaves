import { describe, it, expect, vi } from 'vitest';
import { PassThrough, type Duplex } from 'stream';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from './framing';
import { SyncConnection } from './SyncConnection';
import type { SyncMessage } from './messages';

/** Two duplex streams cross-wired like a socket pair. */
function socketPair(): [Duplex, Duplex] {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new (require('stream').Duplex)({
    write(chunk: Buffer, _enc: string, cb: () => void) { aToB.write(chunk); cb(); },
    read() { /* pushed below */ },
  });
  const b = new (require('stream').Duplex)({
    write(chunk: Buffer, _enc: string, cb: () => void) { bToA.write(chunk); cb(); },
    read() { /* pushed below */ },
  });
  aToB.on('data', (c) => b.push(c));
  bToA.on('data', (c) => a.push(c));
  return [a, b];
}

const helloA: SyncMessage = {
  type: 'hello', deviceId: 'dev-a', deviceName: 'A', protocolVersion: 1, schemaVersion: 51,
};
const helloB: SyncMessage = {
  type: 'hello', deviceId: 'dev-b', deviceName: 'B', protocolVersion: 1, schemaVersion: 51,
};

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('framing', () => {
  it('round-trips messages across chunk boundaries', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ hello: 'world', n: 42 });

    // Deliver one byte at a time — worst-case TCP fragmentation.
    const collected: unknown[] = [];
    for (const byte of frame) {
      collected.push(...decoder.push(Buffer.from([byte])));
    }
    expect(collected).toEqual([{ hello: 'world', n: 42 }]);
    expect(decoder.pending()).toBe(0);
  });

  it('decodes multiple frames from a single chunk', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
    expect(decoder.push(chunk)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('rejects oversized frames', () => {
    const decoder = new FrameDecoder();
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(evil)).toThrow(/exceeds limit/);
  });
});

describe('SyncConnection', () => {
  it('exchanges hellos and routes subsequent messages', async () => {
    const [sockA, sockB] = socketPair();
    const a = new SyncConnection(sockA, 'fp-b');
    const b = new SyncConnection(sockB, 'fp-a');

    const aHello = vi.fn();
    const bMessages: SyncMessage[] = [];
    a.on('hello', aHello);
    b.on('message', (m) => bMessages.push(m));

    a.send(helloA);
    b.send(helloB);
    await flush();

    expect(aHello).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-b' }));
    expect(a.hello?.deviceId).toBe('dev-b');

    a.send({ type: 'sync-request', sinceSeq: 0 });
    await flush();
    expect(bMessages).toEqual([{ type: 'sync-request', sinceSeq: 0 }]);
  });

  it('drops peers whose first message is not hello', async () => {
    const [sockA, sockB] = socketPair();
    const a = new SyncConnection(sockA, '');
    new SyncConnection(sockB, '');

    const closed = vi.fn();
    a.on('close', closed);

    // Write a valid message type, but before hello.
    sockB.push(encodeFrame({ type: 'sync-request', sinceSeq: 0 }));
    sockA.push(encodeFrame({ type: 'sync-request', sinceSeq: 0 }));
    await flush();

    expect(closed).toHaveBeenCalledWith(expect.stringContaining('expected hello'));
  });

  it('drops peers that send invalid messages', async () => {
    const [sockA] = socketPair();
    const a = new SyncConnection(sockA, '');
    const closed = vi.fn();
    a.on('close', closed);

    sockA.push(encodeFrame({ type: 'not-a-real-type' }));
    await flush();

    expect(closed).toHaveBeenCalledWith(expect.stringContaining('invalid message'));
  });

  it('drops peers that send garbage bytes', async () => {
    const [sockA] = socketPair();
    const a = new SyncConnection(sockA, '');
    const closed = vi.fn();
    a.on('close', closed);

    const evil = Buffer.alloc(8);
    evil.writeUInt32BE(MAX_FRAME_BYTES * 2, 0);
    sockA.push(evil);
    await flush();

    expect(closed).toHaveBeenCalledWith(expect.stringContaining('framing violation'));
  });

  it('treats bye as a graceful close', async () => {
    const [sockA, sockB] = socketPair();
    const a = new SyncConnection(sockA, '');
    const b = new SyncConnection(sockB, '');

    const aClosed = vi.fn();
    a.on('close', aClosed);

    a.send(helloA);
    b.send(helloB);
    await flush();

    b.close('done syncing');
    await flush();

    expect(aClosed).toHaveBeenCalledWith(expect.stringContaining('done syncing'));
  });

  it('send after close is a no-op rather than a crash', async () => {
    const [sockA] = socketPair();
    const a = new SyncConnection(sockA, '');
    a.close();
    expect(() => a.send(helloA)).not.toThrow();
  });
});
