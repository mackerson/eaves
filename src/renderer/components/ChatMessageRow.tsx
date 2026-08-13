import { memo, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AvatarPip } from '@/components/AvatarPip';
import { ContentBlock } from '@/components/content/ContentBlock';
import { MessageMenu } from '@/components/MessageMenu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUIPreferencesStore } from '@/stores';
import type { MessageMetrics, ContentBlock as ContentBlockType } from '@/types';

interface ChatMessageRowProps {
  messageId: string;
  content: string;
  senderType: 'human' | 'agent';
  displayName: string;
  nameColor: string;
  /** Sender avatar filename (avatar:// protocol); pip falls back to a colored initial. */
  avatar?: string;
  contentBlocks?: ContentBlockType[];
  metrics?: MessageMetrics;
  /** 0-indexed position among siblings under the same parent_message_id. */
  branchIndex?: number;
  /** Total siblings (incl. archived). When >1, the regenerate carousel renders. */
  branchCount?: number;
  isEditing: boolean;
  editingContent: string;
  /** Approval context plumbed to ContentBlock so tool-approval cards can resume the right stream. */
  approvalContext?: { context: 'chat' | 'channel'; contextId: string; agentId: string };
  onStartEdit: (messageId: string, content: string) => void;
  onSetEditContent: (content: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (messageId: string) => void;
  onRetry: (messageId: string) => void;
  onSwipeBranch?: (messageId: string, direction: 'prev' | 'next') => void;
}

/**
 * Tiny inline `‹ N/M ›` carousel for navigating regenerated variants of an
 * agent message. Only shown when there's more than one sibling. Disabled at
 * the edges of the branch_index range.
 */
const BranchCarousel: React.FC<{
  messageId: string;
  branchIndex: number;
  branchCount: number;
  onSwipe: (messageId: string, direction: 'prev' | 'next') => void;
}> = ({ messageId, branchIndex, branchCount, onSwipe }) => {
  const atStart = branchIndex <= 0;
  const atEnd = branchIndex >= branchCount - 1;
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground select-none">
      <button
        type="button"
        className="p-0.5 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
        disabled={atStart}
        onClick={() => onSwipe(messageId, 'prev')}
        title="Previous variant"
      >
        <ChevronLeft className="h-3 w-3" />
      </button>
      <span className="tabular-nums px-1">{branchIndex + 1}/{branchCount}</span>
      <button
        type="button"
        className="p-0.5 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
        disabled={atEnd}
        onClick={() => onSwipe(messageId, 'next')}
        title="Next variant"
      >
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
};

export const ChatMessageRow = memo(function ChatMessageRow({
  messageId,
  content,
  senderType,
  displayName,
  nameColor,
  avatar,
  contentBlocks,
  metrics,
  branchIndex = 0,
  branchCount = 1,
  isEditing,
  editingContent,
  approvalContext,
  onStartEdit,
  onSetEditContent,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onRetry,
  onSwipeBranch,
}: ChatMessageRowProps) {
  const handleEdit = useCallback(() => onStartEdit(messageId, content), [onStartEdit, messageId, content]);
  const handleDelete = useCallback(() => onDelete(messageId), [onDelete, messageId]);
  const handleRetry = useCallback(() => onRetry(messageId), [onRetry, messageId]);

  const onEditProp = senderType === 'human' ? handleEdit : undefined;
  const onRetryProp = senderType === 'agent' ? handleRetry : undefined;

  // Only agent messages get regenerated, so only they can have meaningful
  // sibling variants to swipe between.
  const showCarousel = senderType === 'agent' && branchCount > 1 && !!onSwipeBranch;

  // Stable single-block wrapper for rows that carry only plain-text `content`
  // and no contentBlocks, so both branches render through ContentBlock.
  // Hint when an agent turn produced neither narration nor tool-call blocks
  // (e.g. model emitted only thinking, or the stream errored before any
  // content). Surfaces a visible-but-dimmed marker instead of an empty bubble.
  const fallbackText = senderType === 'agent' && !content.trim()
    ? '(no response — the model returned without speaking)'
    : content;
  const fallbackBlock = useMemo(
    () => ({ type: 'text' as const, content: fallbackText }),
    [fallbackText],
  );
  const isPlaceholderFallback = senderType === 'agent' && !content.trim() && (!contentBlocks || contentBlocks.length === 0);

  const stacked = useUIPreferencesStore((s) => s.messageLayout) === 'stacked';

  const blockApprovalContext =
    approvalContext && senderType === 'agent' ? { ...approvalContext, messageId } : undefined;

  // Inline-layout name gutter: pip + name, fixed width so block indents line up.
  const nameGutter = (
    <div className="flex items-center gap-2 flex-shrink-0 w-28 self-start" title={displayName}>
      <AvatarPip avatar={avatar} name={displayName} color={nameColor} />
      <span className="text-base font-semibold truncate min-w-0" style={{ color: nameColor }}>
        {displayName}:
      </span>
    </div>
  );

  const menu = (
    <div className="flex items-center gap-2 flex-shrink-0">
      {showCarousel && (
        <BranchCarousel
          messageId={messageId}
          branchIndex={branchIndex}
          branchCount={branchCount}
          onSwipe={onSwipeBranch!}
        />
      )}
      <MessageMenu
        messageId={messageId}
        content={content}
        senderType={senderType}
        metrics={metrics}
        onEdit={onEditProp}
        onDelete={handleDelete}
        onRegenerate={onRetryProp}
      />
    </div>
  );

  const editor = (
    <div className="flex-1 flex gap-2">
      <Input
        autoFocus
        value={editingContent}
        onChange={(e) => onSetEditContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSaveEdit();
          } else if (e.key === 'Escape') {
            onCancelEdit();
          }
        }}
        className="flex-1"
      />
      <Button size="sm" onClick={onSaveEdit}>
        Save
      </Button>
      <Button size="sm" variant="outline" onClick={onCancelEdit}>
        Cancel
      </Button>
    </div>
  );

  // Stacked layout: sender name on its own line above the message, bodies
  // always flush-left. Scales to any name length (no gutter, no truncation).
  if (stacked) {
    return (
      <div className={`w-full group ${isPlaceholderFallback ? 'opacity-60 italic' : ''}`}>
        <div className="flex items-center gap-2 mb-0.5">
          <AvatarPip avatar={avatar} name={displayName} color={nameColor} />
          <div className="text-base font-semibold" style={{ color: nameColor }}>
            {displayName}
          </div>
        </div>
        {isEditing ? (
          editor
        ) : (
          <div className="flex gap-3">
            {/* overflow-y must be pinned: per CSS Overflow, `overflow-x: auto`
                forces a `visible` cross axis to compute to `auto` too, so on
                platforms with classic (space-consuming) scrollbars — Windows —
                every message body paints its own vertical scrollbar over a
                sub-pixel rounding overflow, and swallows wheel events. */}
            <div className="flex-1 overflow-x-auto overflow-y-hidden min-w-0">
              {contentBlocks && contentBlocks.length > 0 ? (
                contentBlocks.map((block, idx) => (
                  <div key={`${messageId}-block-${idx}`} className={idx > 0 ? 'mt-2' : ''}>
                    <ContentBlock block={block} messageId={messageId} approvalContext={blockApprovalContext} />
                  </div>
                ))
              ) : (
                <ContentBlock block={fallbackBlock} messageId={messageId} approvalContext={blockApprovalContext} />
              )}
            </div>
            {menu}
          </div>
        )}
      </div>
    );
  }

  // Inline layout: editing replaces the whole row (name gutter + editor),
  // regardless of whether the message has content blocks.
  if (isEditing) {
    return (
      <div className="w-full group">
        <div className="flex gap-3 w-full">
          {nameGutter}
          {editor}
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full group ${isPlaceholderFallback ? 'opacity-60 italic' : ''}`}>
      {contentBlocks && contentBlocks.length > 0 ? (
        <>
          {contentBlocks.map((block, idx) => (
            <div key={`${messageId}-block-${idx}`} className={idx > 0 ? 'mt-2' : ''}>
              <div className="flex gap-3 w-full">
                {idx === 0 && nameGutter}
                {idx > 0 && <div className="w-28 flex-shrink-0" />}
                <div className="flex-1 overflow-x-auto overflow-y-hidden">
                  <ContentBlock
                    block={block}
                    messageId={messageId}
                    approvalContext={
                      approvalContext && senderType === 'agent'
                        ? { ...approvalContext, messageId }
                        : undefined
                    }
                  />
                </div>
                {idx === (contentBlocks.length || 0) - 1 && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {showCarousel && (
                      <BranchCarousel
                        messageId={messageId}
                        branchIndex={branchIndex}
                        branchCount={branchCount}
                        onSwipe={onSwipeBranch!}
                      />
                    )}
                    <MessageMenu
                      messageId={messageId}
                      content={content}
                      senderType={senderType}
                      metrics={metrics}
                      onEdit={onEditProp}
                      onDelete={handleDelete}
                      onRegenerate={onRetryProp}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      ) : (
        <div className="flex gap-3 w-full">
          {nameGutter}
          <div className="flex-1 overflow-x-auto overflow-y-hidden">
            <ContentBlock
              block={fallbackBlock}
              messageId={messageId}
              approvalContext={
                approvalContext && senderType === 'agent'
                  ? { ...approvalContext, messageId }
                  : undefined
              }
            />
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {showCarousel && (
              <BranchCarousel
                messageId={messageId}
                branchIndex={branchIndex}
                branchCount={branchCount}
                onSwipe={onSwipeBranch!}
              />
            )}
            <MessageMenu
              messageId={messageId}
              content={content}
              senderType={senderType}
              metrics={metrics}
              onEdit={onEditProp}
              onDelete={handleDelete}
              onRegenerate={onRetryProp}
            />
          </div>
        </div>
      )}
    </div>
  );
});
