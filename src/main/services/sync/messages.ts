import { z } from 'zod';

/**
 * Sync wire protocol messages. Every inbound frame is validated against this
 * schema before touching any state — peers are authenticated but still remote
 * input. Version gates:
 *  - protocolVersion: wire-format compatibility (bump on breaking changes)
 *  - schemaVersion: SQLite user_version; rows only flow between identical
 *    schemas (refuse and tell the user to update the older device)
 */

export const SYNC_PROTOCOL_VERSION = 1;

const SyncChangeSchema = z.object({
  seq: z.number().int().nonnegative(),
  table: z.string().min(1).max(64),
  rowId: z.string().min(1).max(512),
  op: z.enum(['insert', 'update', 'delete']),
  changedAt: z.number().int().nonnegative(),
  row: z.record(z.string(), z.unknown()).optional(),
});

export const SyncMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    deviceId: z.string().min(1).max(128),
    deviceName: z.string().min(1).max(256),
    protocolVersion: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
  }),
  z.object({ type: z.literal('pair-request') }),
  z.object({ type: z.literal('pair-confirm') }),
  z.object({ type: z.literal('pair-reject'), reason: z.string().max(512).optional() }),
  z.object({
    type: z.literal('sync-request'),
    sinceSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('changes'),
    changes: z.array(SyncChangeSchema).max(2000),
    upToSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('changes-ack'),
    upToSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('bye'),
    reason: z.string().max(512).optional(),
  }),
]);

export type SyncMessage = z.infer<typeof SyncMessageSchema>;
export type SyncHello = Extract<SyncMessage, { type: 'hello' }>;

export function parseSyncMessage(raw: unknown):
  | { ok: true; message: SyncMessage }
  | { ok: false; error: string } {
  const result = SyncMessageSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map(i => i.message).join('; ') };
  }
  return { ok: true, message: result.data };
}
