/**
 * Socket Broker
 *
 * Host-side TCP/TLS sockets for sandboxed plugins, behind the `net:socket`
 * grant. The worker's module policy forbidding `net`/`tls` is advisory (see
 * worker-entry.ts) — this broker is the *contractual* path: consented at
 * install time like every other manifest grant, enforced by PermissionGate on
 * the RPC bridge, owner-checked per socket, and bounded per plugin. The
 * advisory require-shadow behavior is deliberately unchanged; existing
 * plugins that reach `net` directly keep working.
 *
 * Fail-closed properties:
 * - every method resolves the socket through its owning plugin id — a plugin
 *   cannot read, write, or close another plugin's socket
 * - TLS always verifies certificates; there is no rejectUnauthorized opt-out
 * - per-plugin socket cap, bounded write size, bounded connect timeout
 *
 * Incoming bytes are dispatched only to the owning plugin's worker (never the
 * EventBus, which any listener could observe): `net:socket:data` with
 * `{ socketId, data }` (base64), plus `net:socket:close` / `net:socket:error`.
 */

import * as net from 'net';
import * as tls from 'tls';
import { randomUUID } from 'crypto';
import { logger } from '../logger';

const MAX_SOCKETS_PER_PLUGIN = 8;
const MAX_WRITE_BYTES = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_CONNECT_TIMEOUT_MS = 120_000;

export interface SocketConnectOptions {
  host: string;
  port: number;
  /** true = TLS with certificate verification (always on; no opt-out). */
  tls?: boolean;
  connectTimeoutMs?: number;
}

/** Delivers an event to the owning plugin's worker — and only that worker. */
export type SocketDispatch = (eventType: string, data: Record<string, unknown>) => void;

interface BrokeredSocket {
  socketId: string;
  pluginId: string;
  socket: net.Socket | tls.TLSSocket;
}

export class SocketBroker {
  private sockets = new Map<string, BrokeredSocket>();
  private perPlugin = new Map<string, Set<string>>();

  async connect(
    pluginId: string,
    options: SocketConnectOptions | undefined,
    dispatch: SocketDispatch
  ): Promise<{ socketId: string }> {
    const host = options?.host;
    const port = options?.port;
    if (typeof host !== 'string' || host.length === 0 || host.length > 255) {
      throw new Error('connect requires a host string (1-255 chars)');
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('connect requires an integer port in 1-65535');
    }
    const owned = this.perPlugin.get(pluginId);
    if (owned && owned.size >= MAX_SOCKETS_PER_PLUGIN) {
      throw new Error(`Socket limit reached (${MAX_SOCKETS_PER_PLUGIN} per plugin)`);
    }
    const timeoutMs = Math.min(
      typeof options?.connectTimeoutMs === 'number' && options.connectTimeoutMs > 0
        ? options.connectTimeoutMs
        : DEFAULT_CONNECT_TIMEOUT_MS,
      MAX_CONNECT_TIMEOUT_MS
    );

    const socketId = `sock-${randomUUID()}`;
    // Reserve the slot before the async connect so a burst of parallel
    // connects cannot overshoot the cap.
    this.track(pluginId, socketId);

    try {
      const socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(() => {
          settle(() => {
            raw.destroy();
            reject(new Error(`Connect to ${host}:${port} timed out after ${timeoutMs}ms`));
          });
        }, timeoutMs);

        const raw: net.Socket | tls.TLSSocket = options?.tls
          ? tls.connect({ host, port, servername: host }, () => settle(() => resolve(raw)))
          : net.connect({ host, port }, () => settle(() => resolve(raw)));

        raw.once('error', (error) => settle(() => reject(error)));
      });

      this.sockets.set(socketId, { socketId, pluginId, socket });
      this.attachHandlers(socketId, socket, dispatch);
      logger.info(`[SocketBroker] ${pluginId} connected ${options?.tls ? 'tls' : 'tcp'}://${host}:${port}`, { socketId });
      return { socketId };
    } catch (error) {
      this.untrack(pluginId, socketId);
      throw error;
    }
  }

  write(pluginId: string, socketId: string, dataBase64: string): { bytesWritten: number } {
    const entry = this.owned(pluginId, socketId);
    if (typeof dataBase64 !== 'string') {
      throw new Error('write expects base64-encoded data');
    }
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > MAX_WRITE_BYTES) {
      throw new Error(`write exceeds ${MAX_WRITE_BYTES} bytes`);
    }
    entry.socket.write(buffer);
    return { bytesWritten: buffer.length };
  }

  /** Half-close: flush pending writes, then FIN. The read side stays open. */
  end(pluginId: string, socketId: string): void {
    this.owned(pluginId, socketId).socket.end();
  }

  close(pluginId: string, socketId: string): void {
    this.owned(pluginId, socketId).socket.destroy();
    // 'close' fires asynchronously and cleans the registry; do it eagerly too
    // so the slot frees for an immediate reconnect.
    this.untrack(pluginId, socketId);
    this.sockets.delete(socketId);
  }

  /** Destroy every socket a plugin holds — worker teardown path. */
  unregisterWorker(pluginId: string): void {
    const owned = this.perPlugin.get(pluginId);
    if (!owned) return;
    for (const socketId of Array.from(owned)) {
      this.sockets.get(socketId)?.socket.destroy();
      this.sockets.delete(socketId);
    }
    this.perPlugin.delete(pluginId);
    logger.info(`[SocketBroker] Closed all sockets for ${pluginId}`);
  }

  socketCount(pluginId: string): number {
    return this.perPlugin.get(pluginId)?.size ?? 0;
  }

  private attachHandlers(
    socketId: string,
    socket: net.Socket | tls.TLSSocket,
    dispatch: SocketDispatch
  ): void {
    socket.on('data', (chunk: Buffer) => {
      dispatch('net:socket:data', { socketId, data: chunk.toString('base64') });
    });
    socket.on('error', (error: Error) => {
      dispatch('net:socket:error', { socketId, message: error.message });
    });
    socket.on('close', (hadError: boolean) => {
      const entry = this.sockets.get(socketId);
      if (entry) {
        this.untrack(entry.pluginId, socketId);
        this.sockets.delete(socketId);
      }
      dispatch('net:socket:close', { socketId, hadError });
    });
  }

  /** Resolve a socket through its owner, or throw — the per-plugin boundary. */
  private owned(pluginId: string, socketId: string): BrokeredSocket {
    const entry = this.sockets.get(socketId);
    if (!entry || entry.pluginId !== pluginId) {
      // One message for both cases: confirming a foreign socket id exists
      // would leak which ids are live.
      throw new Error(`No such socket: ${socketId}`);
    }
    return entry;
  }

  private track(pluginId: string, socketId: string): void {
    if (!this.perPlugin.has(pluginId)) this.perPlugin.set(pluginId, new Set());
    this.perPlugin.get(pluginId)!.add(socketId);
  }

  private untrack(pluginId: string, socketId: string): void {
    const owned = this.perPlugin.get(pluginId);
    if (!owned) return;
    owned.delete(socketId);
    if (owned.size === 0) this.perPlugin.delete(pluginId);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: SocketBroker | null = null;

export function getSocketBroker(): SocketBroker {
  if (!instance) {
    instance = new SocketBroker();
  }
  return instance;
}

export function resetSocketBroker(): void {
  instance = null;
}
