/**
 * Stored rows → messages. The first stage of replay (see replayHistory.ts for
 * the rest of the pipeline), split out so it can be exercised from fixtures:
 * feed a recorded row sequence in, assert the assembled request is valid.
 *
 * Two projections, because the surfaces genuinely differ:
 *   - chat    → SDK shape, preserving tool_use ids and content parts
 *   - channel → prose, since perspective-shifting many participants into one
 *               thread is a text-flattening operation (see perspectiveShift)
 *
 * The chat projection is where tool structure survives, so it is also where
 * the provider's structural rules can be violated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './logger';
import { getMessageAttachmentRepository } from '../repositories';
import { getImageMimeType } from '../utils/mimeTypes';

/**
 * Cap on inlined attachment text. Large files would otherwise blow the
 * context budget on a single turn.
 */
const MAX_ATTACHMENT_TEXT_CHARS = 40000;

/**
 * Images inlined across the whole thread, newest-first, so an agent can still
 * "see" something shared several turns back; the cap keeps an image-heavy
 * thread from ballooning.
 */
const MAX_IMAGES_IN_CONTEXT = 20;

export interface AttachmentLoaders {
  loadImageAsBase64: (block: any) => { imageData: string; mimeType: string } | null;
  loadAttachmentText: (block: any) => string | null;
}

export type InlineImagePart = { type: 'image'; image: string; mediaType: string };

/**
 * File-loading closures over the attachment repository + store directory.
 * One instance per turn (cheap); both projections resolve `file-service://`
 * block URLs through the same logic.
 */
export function createAttachmentLoaders(): AttachmentLoaders {
  const attachmentRepo = getMessageAttachmentRepository();
  const attachmentsDir = path.join(app.getPath('userData'), 'eaves-data', 'eaves-attachments');

  // Resolve a file-service:// attachment URL to a path on disk. Shared by
  // the image and text-file loaders below.
  const resolveStoredPath = (block: any): { storedPath: string; mimeType?: string } | null => {
    if (!block.url?.startsWith('file-service://')) return null;
    try {
      let urlPath = block.url.replace('file-service://', '');
      const isAssetPath = urlPath.startsWith('asset/');
      if (isAssetPath) {
        urlPath = urlPath.replace('asset/', '');
      }

      let attachment = attachmentRepo.getById(urlPath);
      if (!attachment && isAssetPath) {
        attachment = attachmentRepo.getByAssetPointer(urlPath);
      }

      if (attachment?.storedPath && fs.existsSync(attachment.storedPath)) {
        return { storedPath: attachment.storedPath, mimeType: attachment.mimeType || undefined };
      }

      const directPath = path.join(attachmentsDir, urlPath);
      if (fs.existsSync(directPath)) {
        return { storedPath: directPath };
      }
    } catch (error) {
      logger.error('[replayProjection] Error resolving attachment path:', error);
    }
    return null;
  };

  const loadImageAsBase64 = (block: any): { imageData: string; mimeType: string } | null => {
    const resolved = resolveStoredPath(block);
    if (!resolved) return null;
    try {
      const ext = path.extname(resolved.storedPath).toLowerCase();
      return {
        imageData: fs.readFileSync(resolved.storedPath).toString('base64'),
        mimeType: resolved.mimeType || getImageMimeType(ext, 'image/jpeg'),
      };
    } catch (error) {
      logger.error('[replayProjection] Error loading image:', error);
      return null;
    }
  };

  const loadAttachmentText = (block: any): string | null => {
    const resolved = resolveStoredPath(block);
    if (!resolved) return null;
    try {
      let text = fs.readFileSync(resolved.storedPath, 'utf8');
      if (text.length > MAX_ATTACHMENT_TEXT_CHARS) {
        text = text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) + '\n\n[… file truncated …]';
      }
      return text;
    } catch (error) {
      logger.error('[replayProjection] Error loading attachment text:', error);
      return null;
    }
  };

  return { loadImageAsBase64, loadAttachmentText };
}

/**
 * Expand an image attachment block: a real vision part when `inline` (and the
 * file loads), otherwise a text reference so the model still knows an image
 * was shared at that point in the thread.
 */
export function expandImageBlock(
  block: any,
  loaders: AttachmentLoaders,
  inline: boolean,
): { part: InlineImagePart } | { text: string } {
  if (!inline) {
    return { text: `[Earlier image: ${block.alt || 'image'}]` };
  }
  const imageResult = loaders.loadImageAsBase64(block);
  if (!imageResult) {
    return { text: `[Image: ${block.alt || 'attached image'}]` };
  }
  return {
    part: {
      type: 'image',
      // AI SDK v6 ImagePart carries `mediaType`, NOT `mimeType` — an
      // unrecognized field is silently dropped, leaving the SDK to
      // guess the format ("image/*"), which providers reject.
      // Pass a full data URI (v6 parses the media type out of it)
      // AND set mediaType explicitly for good measure.
      image: `data:${imageResult.mimeType};base64,${imageResult.imageData}`,
      mediaType: imageResult.mimeType,
    },
  };
}

/**
 * Expand a text/document attachment block: inline the full contents when
 * `inline` (the current turn); otherwise a lightweight reference so history
 * doesn't re-send every attached file each turn.
 */
export function expandFileBlock(block: any, loaders: AttachmentLoaders, inline: boolean): string {
  const label = block.filename || 'file';
  if (!inline) {
    return `[Attached file: ${label} — shared earlier]`;
  }
  const text = loaders.loadAttachmentText(block);
  return text !== null
    ? `[Attached file: ${label}]\n\`\`\`\n${text}\n\`\`\``
    : `[Attached file: ${label} — could not be read]`;
}

/**
 * How many unresolved failures to report. A thread that fails repeatedly
 * doesn't need every attempt narrated — the most recent ones carry the signal,
 * and each one costs tokens on every turn until it clears.
 */
const MAX_REPORTED_FAILURES = 3;

export interface FailureScan {
  /** Rows with failure-only turns removed and error text stripped from partial ones. */
  rows: any[];
  /** Failure reasons with no successful agent turn after them, oldest first. */
  unresolved: string[];
}

/**
 * Find the turns that failed and never reached the model.
 *
 * A failed turn persists as a row carrying a system contentBlock of the form
 * "Error: …" — sometimes alongside real partial output the model did produce
 * before the stream died, sometimes alone. Both need handling, differently:
 *
 *  - partial output is genuine model text and stays in history
 *  - the error itself must NOT stay in history as assistant text. Some paths
 *    persist `content: '[Error: …]'`, which replays as though the model said
 *    it, teaching it to narrate infrastructure failures in its own voice.
 *
 * So the error comes out of the message stream entirely and is reported
 * through the system prompt instead. A failure clears as soon as any later
 * agent turn succeeds — by then the model has moved on, and a stale warning
 * only competes for attention.
 */
export function scanTurnFailures(rows: any[], cap = MAX_REPORTED_FAILURES): FailureScan {
  const kept: any[] = [];
  let unresolved: string[] = [];

  for (const row of rows) {
    const reason = failureReason(row);
    if (!reason) {
      // A successful agent turn means everything before it is water under the
      // bridge — the model recovered on its own.
      if (row?.senderType === 'agent' && carriesContent(row)) unresolved = [];
      kept.push(row);
      continue;
    }

    unresolved.push(reason);

    // Keep whatever the model actually produced before it died; drop the row
    // when stripping the error notice leaves nothing behind.
    const remainder = stripErrorNotice(row.content, reason);
    const blocks = Array.isArray(row.contentBlocks)
      ? row.contentBlocks.filter((b: any) => b?.type !== 'system')
      : row.contentBlocks;
    if (remainder || (Array.isArray(blocks) && blocks.length > 0)) {
      kept.push({ ...row, content: remainder, contentBlocks: blocks });
    }
  }

  return { rows: kept, unresolved: unresolved.slice(-cap) };
}

/** The "Error: …" system block both persist paths write, or null for a healthy row. */
function failureReason(row: any): string | null {
  if (row?.senderType !== 'agent' || !Array.isArray(row.contentBlocks)) return null;
  for (const block of row.contentBlocks) {
    if (block?.type === 'system' && typeof block.content === 'string' && block.content.startsWith('Error: ')) {
      return block.content.slice('Error: '.length).trim();
    }
  }
  return null;
}

function carriesContent(row: any): boolean {
  return (typeof row?.content === 'string' && row.content.trim().length > 0) ||
    (Array.isArray(row?.contentBlocks) && row.contentBlocks.length > 0) ||
    (Array.isArray(row?.responseMessages) && row.responseMessages.length > 0);
}

/** Remove the `[Error: …]` marker the throw path appends to content. */
function stripErrorNotice(content: unknown, reason: string): string {
  if (typeof content !== 'string') return '';
  return content
    .replace(`[Error: ${reason}]`, '')
    .trim();
}

/**
 * Render unresolved failures for the system prompt.
 *
 * Appended as a suffix, like the compaction summary — a prefix change would
 * miss the prompt cache on every turn. Says what happened and explicitly does
 * NOT prescribe a retry: the same notice covers a transient overload (retrying
 * is right) and a malformed request (retrying loops forever), and the model is
 * better placed than this function to tell those apart from context.
 */
export function failureSection(unresolved: string[]): string {
  if (unresolved.length === 0) return '';
  const lines = unresolved.map(r => `- ${r}`).join('\n');
  return `\n\n## Interrupted turns\nOne or more of your recent replies failed before reaching the conversation. The user did not see them, and no tools ran as part of them:\n${lines}\nPick up from where the conversation actually stands. Do not assume earlier work landed, and do not apologize at length — say what you're doing and continue.`;
}

export interface ProjectedChatHistory {
  messages: any[];
  /** Whether the latest user turn carried an inlined image — drives the describe-first nudge. */
  lastUserMessageHasImages: boolean;
}

/**
 * Project chat rows to SDK-shape messages. Two sources, in priority:
 *   1. msg.responseMessages — AI SDK ResponseMessage[] persisted from a prior
 *      turn. Authoritative; preserves tool_use_ids and the exact shape
 *      Anthropic prompt caching keys on. Expanded inline, one row to many.
 *   2. msg.contentBlocks — UI shape, used for human turns and for any agent
 *      turn with no persisted responseMessages (an older row, or a turn whose
 *      capture failed).
 *
 * Deliberately does NOT repair anything: a tool-call on one row may have its
 * result on a later row (a resume continuation persists results separately),
 * so balance and adjacency are only decidable once the whole array exists.
 * That is assembleReplayHistory's job.
 */
export function projectChatHistory(
  rows: any[],
  loaders: AttachmentLoaders,
): ProjectedChatHistory {
  let lastUserMessageIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].senderType === 'human') {
      lastUserMessageIndex = i;
      break;
    }
  }
  let lastUserMessageHasImages = false;

  // Decide which image blocks to inline, scanning newest-first so the most
  // recent images win the budget. Rows that expand from persisted SDK
  // responseMessages never reach the image code, so they're skipped here
  // rather than spending budget.
  const includableImages = new Set<unknown>();
  let imageBudget = MAX_IMAGES_IN_CONTEXT;
  for (let i = rows.length - 1; i >= 0 && imageBudget > 0; i--) {
    const m = rows[i];
    const usesResponseMessages =
      m.senderType === 'agent' &&
      Array.isArray(m.responseMessages) &&
      m.responseMessages.length > 0;
    if (usesResponseMessages || !Array.isArray(m.contentBlocks)) continue;
    for (let j = m.contentBlocks.length - 1; j >= 0 && imageBudget > 0; j--) {
      const b = m.contentBlocks[j];
      if (b?.type === 'image' && b.url) {
        includableImages.add(b);
        imageBudget--;
      }
    }
  }

  const messages: any[] = [];
  rows.forEach((msg, index) => {
    const isLastUserMessage = index === lastUserMessageIndex;

    // Path 1: agent turn with persisted SDK shape — expand directly.
    if (
      msg.senderType === 'agent' &&
      Array.isArray(msg.responseMessages) &&
      msg.responseMessages.length > 0
    ) {
      for (const m of msg.responseMessages) {
        messages.push(m);
      }
      return;
    }

    // Path 2: human turn, or an agent turn with no responseMessages —
    // synthesize from contentBlocks/text.
    const messageObj: any = {
      role: msg.senderType === 'human' ? 'user' : 'assistant',
    };

    if (msg.contentBlocks && Array.isArray(msg.contentBlocks)) {
      const contentParts: any[] = [];
      // Collect tool-call summaries to append after text/image parts.
      // Only fires for agent turns that lost responseMessages (legacy rows
      // or capture failure). Without it, a tools-only turn would synthesize
      // as just an empty assistant message, and the model would have no
      // record that it ran tools.
      const toolLines: string[] = [];

      for (const block of msg.contentBlocks) {
        if (block.type === 'text' && block.content) {
          contentParts.push({ type: 'text', text: block.content });
        } else if (block.type === 'image' && block.url) {
          const expanded = expandImageBlock(block, loaders, includableImages.has(block));
          if ('part' in expanded) {
            contentParts.push(expanded.part);
            if (isLastUserMessage) lastUserMessageHasImages = true;
          } else {
            contentParts.push({ type: 'text', text: expanded.text });
          }
        } else if (block.type === 'file' && block.url) {
          contentParts.push({ type: 'text', text: expandFileBlock(block, loaders, isLastUserMessage) });
        } else if (block.type === 'tool-call' && block.toolCall) {
          const argsStr = (() => { try { return JSON.stringify(block.toolCall.args); } catch { return '{}'; } })();
          const resultStr = block.toolCall.result !== undefined
            ? (() => { try { return JSON.stringify(block.toolCall.result); } catch { return String(block.toolCall.result); } })()
            : block.toolCall.error !== undefined
              ? `error: ${typeof block.toolCall.error === 'string' ? block.toolCall.error : JSON.stringify(block.toolCall.error)}`
              : '(pending)';
          const truncated = resultStr.length > 800 ? resultStr.slice(0, 800) + '…' : resultStr;
          toolLines.push(`[tool ${block.toolCall.toolName}(${argsStr}) → ${truncated}]`);
        }
      }

      if (toolLines.length > 0 && msg.senderType === 'agent') {
        const toolSummary = `\n\n[Prior tool use this turn:\n${toolLines.join('\n')}\n]`;
        // Merge into the trailing text part if any, else create one. Manual
        // reverse walk — findLast was added in ES2023 and our tsconfig
        // target is older.
        let lastText: { type: 'text'; text: string } | undefined;
        for (let i = contentParts.length - 1; i >= 0; i--) {
          if (contentParts[i]?.type === 'text') {
            lastText = contentParts[i];
            break;
          }
        }
        if (lastText) {
          lastText.text = lastText.text + toolSummary;
        } else {
          contentParts.push({ type: 'text', text: toolSummary.trimStart() });
        }
      }

      messageObj.content = contentParts.length > 0 ? contentParts : (msg.content || '');
    } else {
      messageObj.content = msg.content || '';
    }

    messageObj.name = msg.senderType === 'human' ? `human_${msg.senderId}` : `agent_${msg.senderId}`;

    if (msg.metadata) {
      messageObj.metadata = msg.metadata;
    }

    messages.push(messageObj);
  });

  return { messages, lastUserMessageHasImages };
}
