/**
 * Length-prefixed JSON framing for the sync TLS stream: 4-byte big-endian
 * payload length, then UTF-8 JSON. Dependency-free and boring on purpose.
 */

/** Hard ceiling per frame. A 500-row change batch of chatty messages is well
 *  under 8 MB; anything bigger is a bug or an attack, not data. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame exceeds ${MAX_FRAME_BYTES} bytes (${payload.length})`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Incremental decoder: feed it socket chunks, get back complete parsed
 * messages. Throws on oversized or non-JSON frames — callers treat that as a
 * protocol violation and drop the connection.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`Incoming frame of ${length} bytes exceeds limit`);
      }
      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(payload.toString('utf8')));
    }

    return messages;
  }

  /** Bytes sitting in the buffer awaiting the rest of a frame. */
  pending(): number {
    return this.buffer.length;
  }
}
