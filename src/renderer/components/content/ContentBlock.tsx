import { memo } from 'react';
import { FileText } from 'lucide-react';
import { MarkdownBlock } from './MarkdownBlock';
import { CodeBlock } from './CodeBlock';
import { ImageBlock } from './ImageBlock';
import { SystemMessageBlock } from './SystemMessageBlock';
import { ToolCallDisplay } from '../ToolCallDisplay';
import { ApprovalCard } from '../ApprovalCard';
import type { ContentBlock as ContentBlockType } from '@/types';

interface ApprovalContext {
  context: 'chat' | 'channel';
  contextId: string;
  agentId: string;
  messageId: string;
}

interface ContentBlockProps {
  block: ContentBlockType;
  className?: string;
  messageId?: string; // For attachment operations like uploading missing images
  /** Required for tool-approval blocks. Identifies where the approval lives so
   *  the approval IPC can resume the right stream. */
  approvalContext?: ApprovalContext;
}

/**
 * Router component that renders the appropriate content block based on type
 * Shared by both ChatView (Channels) and ChatsView (1-1 Chats)
 */
export const ContentBlock = memo(function ContentBlock({ block, className = '', messageId, approvalContext }: ContentBlockProps) {
  // Handle text blocks with markdown
  if (block.type === 'text') {
    return (
      <MarkdownBlock
        content={block.content}
        className={className}
      />
    );
  }

  // Handle code blocks with syntax highlighting
  if (block.type === 'code') {
    return (
      <CodeBlock
        code={block.code || ''}
        language={block.language}
        metadata={block.metadata}
        className={className}
      />
    );
  }

  // Handle image blocks
  if (block.type === 'image') {
    return (
      <ImageBlock
        url={block.url || ''}
        alt={block.alt}
        metadata={block.metadata}
        className={className}
        messageId={messageId}
      />
    );
  }

  // Handle non-image file attachments (text/markdown/documents) — a chip; the
  // contents are inlined into the model context separately by ChatService.
  if (block.type === 'file') {
    return (
      <div className={`inline-flex items-center gap-2 px-3 py-2 my-1 rounded border border-border bg-muted/40 text-sm ${className}`}>
        <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="truncate max-w-[240px]">{block.filename}</span>
        {typeof block.size === 'number' && block.size > 0 && (
          <span className="text-xs text-muted-foreground">{(block.size / 1024).toFixed(1)} KB</span>
        )}
      </div>
    );
  }

  // Handle system messages
  if (block.type === 'system') {
    return (
      <SystemMessageBlock
        content={block.content}
        metadata={block.metadata}
        className={className}
      />
    );
  }

  // Handle tool calls (existing ToolCallDisplay component)
  if (block.type === 'tool-call' && block.toolCall) {
    return (
      <ToolCallDisplay
        toolName={block.toolCall.toolName}
        args={block.toolCall.args}
        result={block.toolCall.result}
        error={block.toolCall.error}
        status={block.toolCall.status}
      />
    );
  }

  // Inline approval card for HITL tool gating
  if (block.type === 'tool-approval' && block.approval) {
    if (!approvalContext) {
      // Render-only fallback when the caller supplied no context — a block
      // rendered outside a live conversation surface (e.g. a thread preview)
      // has nothing to respond into, so it shows without actionable buttons.
      return (
        <div className="border rounded-lg p-3 my-2 bg-yellow-500/5 border-yellow-500/30 text-xs text-muted-foreground">
          Approval pending for <code className="app-text-primary">{block.approval.toolName}</code>
        </div>
      );
    }
    return (
      <ApprovalCard
        approval={block.approval}
        context={approvalContext.context}
        contextId={approvalContext.contextId}
        agentId={approvalContext.agentId}
        messageId={approvalContext.messageId}
      />
    );
  }

  // Fallback for unknown block types
  return (
    <div className={`p-3 bg-bg-tertiary border border-border-secondary rounded text-text-tertiary text-sm ${className}`}>
      <div className="font-semibold mb-1">Unknown content type: {block.type}</div>
      <pre className="text-xs overflow-x-auto overflow-y-hidden">{JSON.stringify(block, null, 2)}</pre>
    </div>
  );
});
