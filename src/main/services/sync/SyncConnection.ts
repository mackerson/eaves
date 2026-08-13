import { EventEmitter } from 'events';
import type { Duplex } from 'stream';
import { logger } from '../logger';
import { FrameDecoder, encodeFrame } from './framing';
import { parseSyncMessage, type SyncHello, type SyncMessage } from './messages';

/**
 * One live sync link, either direction. Wraps any Duplex (a TLSSocket in
 * production, an in-memory pair in tests) and enforces the protocol floor:
 * frames decode, messages validate, the first message is a `hello`, and a
 * peer that violates any of that gets dropped.
 *
 * Pairing/authorization decisions live above this class — the caller supplies
 * the TLS-derived peer fingerprint and decides what an unknown peer may do.
 */

export interface SyncConnectionEvents {
  hello: (hello: SyncHello) => void;
  message: (message: SyncMessage) => void;
  close: (reason: string) => void;
}

const HELLO_TIMEOUT_MS = 10_000;

export class SyncConnection extends EventEmitter {
  readonly peerFingerprint: string;
  private socket: Duplex;
  private decoder = new FrameDecoder();
  private remoteHello: SyncHello | null = null;
  private closed = false;
  private helloTimer: NodeJS.Timeout | null = null;

  constructor(socket: Duplex, peerFingerprint: string) {
    super();
    this.socket = socket;
    this.peerFingerprint = peerFingerprint;

    this.helloTimer = setTimeout(() => {
      this.drop('hello timeout');
    }, HELLO_TIMEOUT_MS);
    // Don't let the handshake timer hold the process open.
    this.helloTimer.unref?.();

    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) => {
      logger.warn('[sync] Connection error', { error: err.message });
      this.finish(`socket error: ${err.message}`);
    });
    socket.on('close', () => this.finish('socket closed'));
  }

  get hello(): SyncHello | null {
    return this.remoteHello;
  }

  send(message: SyncMessage): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(message));
    } catch (err) {
      this.drop(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(reason: string = 'closing'): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame({ type: 'bye', reason }));
    } catch {
      // Already broken — nothing to say goodbye through.
    }
    this.drop(reason);
  }

  private onData(chunk: Buffer): void {
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.drop(`framing violation: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const raw of frames) {
      if (this.closed) return;
      const parsed = parseSyncMessage(raw);
      if (!parsed.ok) {
        this.drop(`invalid message: ${parsed.error}`);
        return;
      }
      this.dispatch(parsed.message);
    }
  }

  private dispatch(message: SyncMessage): void {
    if (!this.remoteHello) {
      if (message.type !== 'hello') {
        this.drop(`expected hello, got ${message.type}`);
        return;
      }
      this.remoteHello = message;
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }
      this.emit('hello', message);
      return;
    }

    if (message.type === 'hello') {
      this.drop('duplicate hello');
      return;
    }
    if (message.type === 'bye') {
      this.finish(`peer said bye${message.reason ? `: ${message.reason}` : ''}`);
      return;
    }
    this.emit('message', message);
  }

  /** Tear down without courtesy — protocol violations and local shutdown. */
  private drop(reason: string): void {
    if (this.closed) return;
    try {
      this.socket.destroy();
    } catch {
      // best effort
    }
    this.finish(reason);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    this.emit('close', reason);
  }
}
