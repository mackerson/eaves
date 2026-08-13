import { ContentBlock, ToolCall } from '../types';
import { StreamEvent } from './ai';
import { logger } from './logger';

/**
 * ContentBlocksBuilder handles the conversion of AI streaming events
 * into structured contentBlocks for database storage and UI rendering.
 *
 * This ensures tool calls, text, and other content types are properly
 * interleaved in the order they occur during streaming.
 */
export class ContentBlocksBuilder {
  private contentBlocks: ContentBlock[] = [];
  private currentTextBuffer = '';
  private toolCallsMap = new Map<string, ToolCall>();

  handleEvent(event: string | StreamEvent): void {
    if (typeof event === 'string') {
      this.currentTextBuffer += event;
      return;
    }

    switch (event.type) {
      case 'tool-call-start':
        this.flushTextBuffer();
        if (!event.toolName) {
          logger.warn('[ContentBlocksBuilder] Tool call start event missing toolName', { event });
          return;
        }
        this.toolCallsMap.set(event.toolName, {
          toolName: event.toolName,
          args: event.args,
          status: 'running'
        });
        break;

      case 'tool-call-result': {
        if (!event.toolName) {
          logger.warn('[ContentBlocksBuilder] Tool call result event missing toolName', { event });
          return;
        }
        const resultToolCall = this.toolCallsMap.get(event.toolName);
        if (!resultToolCall) {
          logger.warn(`[ContentBlocksBuilder] No matching tool call found for result: ${event.toolName}`);
          return;
        }
        resultToolCall.result = event.result;
        // A tool that resolves (rather than throwing) but reports its own
        // failure — e.g. bash/execute_code returning `{ success: false }` on a
        // non-zero exit — must not render as "completed", or the failure is
        // invisible until the model narrates it. Surface it via the same
        // error path a thrown tool uses.
        const failed =
          event.result != null &&
          typeof event.result === 'object' &&
          (event.result as { success?: unknown }).success === false;
        resultToolCall.status = failed ? 'error' : 'completed';
        if (failed && !resultToolCall.error) {
          const r = event.result as { error?: unknown; stderr?: unknown };
          const detail =
            (typeof r.error === 'string' && r.error) ||
            (typeof r.stderr === 'string' && r.stderr.trim()) ||
            'Tool reported failure';
          resultToolCall.error = detail;
        }
        this.contentBlocks.push({
          type: 'tool-call',
          toolCall: { ...resultToolCall },
          timestamp: Date.now()
        });
        this.toolCallsMap.delete(event.toolName);
        break;
      }

      case 'tool-approval-request': {
        // Pending approval — surface as its own block so the renderer can
        // render an inline approval card. Don't drop the matching tool-call
        // entry from `toolCallsMap`: if the user later approves and the
        // resume stream emits a tool-result, we still want to coalesce it
        // into a tool-call block (handled by tool-call-result above).
        this.flushTextBuffer();
        this.contentBlocks.push({
          type: 'tool-approval',
          approval: {
            approvalId: event.approvalId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            status: 'pending',
          },
          timestamp: Date.now(),
        });
        break;
      }

      case 'tool-output-denied': {
        // Resume turn after a deny — drop the in-flight tool-call so it
        // doesn't get rendered as a completed call. The original approval
        // contentBlock (status='denied') is the user-facing record.
        this.toolCallsMap.delete(event.toolName);
        break;
      }

      case 'error': {
        // Terminal stream failure (connection refused, overloaded…) — persist
        // as a system block so the turn shows why it produced nothing instead
        // of a bare "(no response)" placeholder.
        this.flushTextBuffer();
        const message = typeof event.error === 'string'
          ? event.error
          : event.error?.message || 'Unknown error occurred';
        this.contentBlocks.push({
          type: 'system',
          content: `Error: ${message}`,
          timestamp: Date.now(),
        });
        break;
      }

      case 'tool-call-error': {
        if (!event.toolName) {
          logger.warn('[ContentBlocksBuilder] Tool call error event missing toolName', { event });
          return;
        }
        const errorToolCall = this.toolCallsMap.get(event.toolName);
        if (!errorToolCall) {
          logger.warn(`[ContentBlocksBuilder] No matching tool call found for error: ${event.toolName}`);
          return;
        }
        errorToolCall.error = event.error;
        errorToolCall.status = 'error';
        this.contentBlocks.push({
          type: 'tool-call',
          toolCall: { ...errorToolCall },
          timestamp: Date.now()
        });
        this.toolCallsMap.delete(event.toolName);
        break;
      }

      default:
        break;
    }
  }

  private flushTextBuffer(): void {
    if (this.currentTextBuffer.trim()) {
      this.contentBlocks.push({
        type: 'text',
        content: this.currentTextBuffer,
        timestamp: Date.now()
      });
      this.currentTextBuffer = '';
    }
  }

  /**
   * Append a system note after the model's content — e.g. a truncation warning
   * when the turn was cut off at the output-token limit.
   */
  addSystemNote(content: string): void {
    this.flushTextBuffer();
    this.contentBlocks.push({ type: 'system', content, timestamp: Date.now() });
  }

  /** Flushes remaining text and returns all content blocks. */
  getContentBlocks(): ContentBlock[] {
    this.flushTextBuffer();
    return this.contentBlocks;
  }

  getFullText(): string {
    const textParts = this.contentBlocks
      .filter(b => b.type === 'text')
      .map(b => b.content || '')
      .join('');
    return textParts + this.currentTextBuffer;
  }

  getLegacyToolCalls(): ToolCall[] {
    return this.contentBlocks
      .filter(b => b.type === 'tool-call')
      .map(b => b.toolCall!)
      .filter(Boolean);
  }
}
