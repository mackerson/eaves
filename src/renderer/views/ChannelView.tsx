import React, { memo, useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { Hash, Folder, Pin, Archive, ArchiveRestore, Paperclip, X, Maximize2 } from 'lucide-react';
import { AvatarPip } from '@/components/AvatarPip';
import { ConversationListPanel } from '@/components/ConversationListPanel';
import { ContentBlock } from '@/components/content/ContentBlock';
import { MessageMenu } from '@/components/MessageMenu';
import { ChatInput } from '@/components/ChatInput';
import { PendingAttachmentsStrip, pickPendingAttachments, type PendingAttachment } from '@/components/PendingAttachmentsStrip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAgentStore } from '@/stores/useAgentStore';
import { useConversationsStore, useSettingsStore, useUIPreferencesStore } from '@/stores';
import { useChannelActions } from '@/hooks/useChannelActions';
import { useCompactMode } from '@/hooks/useCompactMode';

/** Thin wrapper that isolates input state from the rest of ChannelView */
const ConnectedChannelInput: React.FC<{ onSend: () => void; disabled: boolean; placeholder: string; disabledReason?: string }> = (props) => {
  const input = useConversationsStore((s) => s.channelInput);
  const setInput = useConversationsStore((s) => s.setChannelInput);
  return <ChatInput {...props} value={input} onChange={setInput} />;
};

/**
 * Editable tag chips for the channel header: existing tags render as chips
 * with a remove button; the trailing input adds a tag on Enter. Writes go
 * through update-channel — tags are a first-class column on every channel,
 * so there is no chat-only tag path to special-case here.
 */
const ChannelTagsRow: React.FC<{
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}> = ({ tags, onAdd, onRemove }) => {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    onAdd(value);
    setDraft('');
  };

  return (
    <div className="flex gap-1 mt-2 flex-wrap items-center" data-testid="channel-tags">
      {tags.map((tag) => (
        <span
          key={tag}
          data-testid="channel-tag-chip"
          className="px-2 py-0.5 text-xs bg-accent rounded-md flex items-center gap-1"
        >
          {tag}
          <button
            data-testid={`channel-tag-remove-${tag}`}
            onClick={() => onRemove(tag)}
            className="opacity-50 hover:opacity-100"
            title={`Remove tag "${tag}"`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        data-testid="channel-tag-input"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder="+ tag"
        maxLength={50}
        className="w-20 px-2 py-0.5 text-xs bg-transparent border border-transparent rounded-md focus:border-border focus:outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
};

export const ChannelView = memo(function ChannelView() {
  // Granular selectors — avoid re-rendering on unrelated state changes
  const channels = useConversationsStore((s) => s.channels);
  const currentChannelId = useConversationsStore((s) => s.currentChannelId);
  const channelSelectedAgents = useConversationsStore((s) => s.channelSelectedAgents);
  const isLoading = useConversationsStore((s) => s.channelIsLoading);
  const streamingContent = useConversationsStore((s) => s.channelStreamingContent);
  const editingMessageId = useConversationsStore((s) => s.editingMessageId);
  const editingMessageContent = useConversationsStore((s) => s.editingMessageContent);
  const searchQuery = useConversationsStore((s) => s.channelSearchQuery);
  const { setChannelSearchQuery, setEditingMessageContent } = useConversationsStore.getState();

  const agents = useAgentStore((s) => s.agents);
  const userAvatar = useSettingsStore((s) => s.settings.userAvatar);

  // Compact mode reduces this view to transcript + composer. The channel
  // header goes with it — the compact header in the title bar carries the
  // channel name and the "Ask:" agent choice, which is the only part of the
  // header a message actually needs.
  const isCompact = useCompactMode();
  const setCompactMode = useUIPreferencesStore((s) => s.setCompactMode);

  const {
    handleSend,
    handleStopStream,
    handleToggleChannelPin,
    handleAddChannelTag,
    handleRemoveChannelTag,
    handleToggleChannelArchive,
    handleAgentChange,
    handleEditMessage,
    handleSaveMessage,
    handleCancelEditMessage,
    handleDeleteMessage,
    openAddAgentModal,
    openChannelModal,
  } = useChannelActions();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Attachments staged in the composer, not yet attached to any message —
  // they only become rows once the send succeeds.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const handleAttachClick = useCallback(async () => {
    const picked = await pickPendingAttachments();
    if (picked.length > 0) {
      setPendingAttachments((prev) => [...prev, ...picked]);
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setPendingAttachments((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  }, []);

  // Attachments clear only when the send actually dispatched — a validation
  // early-out (empty input, no channel/agent) keeps them staged.
  const handleSendWithAttachments = useCallback(async () => {
    const paths = pendingAttachments.map((a) => a.path);
    const sent = await handleSend(paths.length > 0 ? paths : undefined);
    if (sent) setPendingAttachments([]);
  }, [handleSend, pendingAttachments]);

  const currentChannel = useMemo(
    () => channels.find(c => c.id === currentChannelId),
    [channels, currentChannelId]
  );

  const currentAgentId = currentChannelId ? channelSelectedAgents.get(currentChannelId) || null : null;

  const filteredMessages = useMemo(
    () => currentChannel?.messages.filter(msg =>
      !searchQuery || msg.content.toLowerCase().includes(searchQuery.toLowerCase())
    ) ?? [],
    [currentChannel?.messages, searchQuery]
  );

  const channelAgents = useMemo(
    () => agents.filter(agent =>
      currentChannel?.participants.some(p => p.id === agent.id && p.type === 'agent')
    ),
    [agents, currentChannel?.participants]
  );

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredMessages.length, streamingContent]);

  return (
    <div className="flex h-full">
      {/* Unified conversations panel */}
      {!isCompact && <ConversationListPanel />}
      <div className="flex-1 flex flex-col min-w-0">
        {currentChannelId && currentChannel ? (
          <>
          {/* Channel header */}
          {!isCompact && (
          <div className="p-4 border-b border-border" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <div className="mb-2">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold flex items-center gap-1.5">
                    {currentChannel.type === 'project'
                      ? <Folder className="h-5 w-5 text-muted-foreground" />
                      : <Hash className="h-5 w-5 text-muted-foreground" />}
                    {currentChannel.name}
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 ${currentChannel.pinned ? 'text-foreground' : 'text-muted-foreground opacity-50 hover:opacity-100'}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleToggleChannelPin(currentChannel.id, !currentChannel.pinned);
                    }}
                    title={currentChannel.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                  >
                    <Pin className={`h-4 w-4 ${currentChannel.pinned ? 'fill-current' : ''}`} />
                  </Button>
                  {/* #general is the built-in home channel — not archivable,
                      matching the conversation-list menu's protection. */}
                  {currentChannel.name !== 'general' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground opacity-50 hover:opacity-100"
                      data-testid="channel-archive-toggle"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleToggleChannelArchive(currentChannel.id, !!currentChannel.archivedAt);
                      }}
                      title={currentChannel.archivedAt ? 'Unarchive channel' : 'Archive channel'}
                    >
                      {currentChannel.archivedAt
                        ? <ArchiveRestore className="h-4 w-4" />
                        : <Archive className="h-4 w-4" />}
                    </Button>
                  )}
                  {/* Entering compact mode; the compact header owns leaving it,
                      since this header is one of the things it hides. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground opacity-50 hover:opacity-100"
                    onClick={() => setCompactMode(true)}
                    title="Compact conversation"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </Button>
                </div>
                {channelAgents.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Ask:</span>
                    <select
                      value={currentAgentId || ''}
                      onChange={(e) => handleAgentChange(e.target.value)}
                      className="px-3 py-1.5 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      {channelAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex gap-1.5 items-center">
                {currentChannel.participants.map((participant) => {
                  const displayName = (participant.displayName && participant.displayName.trim()) || participant.id;
                  const initials = displayName
                    .split(/\s+/)
                    .filter(Boolean)
                    .map(part => part[0] || '')
                    .join('')
                    .substring(0, 2)
                    .toUpperCase();
                  // channel_participants stores no avatar of its own: agents
                  // keep theirs on the agents record, the human's lives in
                  // settings (single-human today — participant avatars would
                  // need to move onto the participant row for synced peers).
                  const avatar = participant.type === 'agent'
                    ? agents.find(a => a.id === participant.id)?.avatar
                    : userAvatar;
                  const title = `${displayName} • ${participant.type === 'agent' ? 'Agent' : 'Human'}`;

                  if (avatar) {
                    return (
                      <img
                        key={`${participant.id}-${participant.joinedAt}`}
                        src={`avatar://${avatar}`}
                        alt={displayName}
                        className="w-7 h-7 rounded-full object-cover cursor-default"
                        title={title}
                      />
                    );
                  }
                  return (
                    <span
                      key={`${participant.id}-${participant.joinedAt}`}
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold cursor-default text-white"
                      style={{ backgroundColor: participant.color || '#4f46e5' }}
                      title={title}
                    >
                      {initials || displayName.substring(0, 2).toUpperCase()}
                    </span>
                  );
                })}
                <button
                  className="w-7 h-7 rounded-full border border-dashed border-muted-foreground text-muted-foreground hover:bg-accent hover:border-primary hover:text-foreground transition-all flex items-center justify-center text-base cursor-pointer"
                  onClick={openAddAgentModal}
                >
                  +
                </button>
              </div>
            </div>
            <ChannelTagsRow
              tags={currentChannel.tags ?? []}
              onAdd={(tag) => handleAddChannelTag(currentChannel.id, tag)}
              onRemove={(tag) => handleRemoveChannelTag(currentChannel.id, tag)}
            />
            <Input
              type="text"
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setChannelSearchQuery(e.target.value)}
              className="mt-2"
              // Edit ▸ Find in Conversation focuses this rather than opening a
              // second search surface over the same messages.
              data-search="conversation"
            />
          </div>
          )}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4" ref={chatContainerRef}>
          {filteredMessages.map((msg) => {
            const displayName = msg.senderDisplayName || (msg.senderType === 'human' ? 'You' : 'Agent');
            const nameColor = msg.senderColor || (msg.senderType === 'human' ? '#60a5fa' : '#c084fc');
            const senderAvatar = msg.senderType === 'agent'
              ? agents.find(a => a.id === msg.senderId)?.avatar
              : userAvatar;
            const nameGutter = (
              <div className="flex items-center gap-2 flex-shrink-0 min-w-[60px] self-start">
                <AvatarPip avatar={senderAvatar} name={displayName} color={nameColor} />
                <span className="text-base font-semibold" style={{ color: nameColor }}>
                  {displayName}:
                </span>
              </div>
            );
            return (
              <div key={msg.id} className="w-full group">
                {/* Special case: Draft message with no content yet - show loading indicator */}
                {msg.isDraft && (!msg.contentBlocks || msg.contentBlocks.length === 0) && !msg.content.trim() ? (
                  <div className="flex gap-3 w-full">
                    {nameGutter}
                    <div className="flex-1 flex items-center gap-1 text-gray-400">
                      <span className="animate-pulse">●</span>
                      <span className="animate-pulse delay-100">●</span>
                      <span className="animate-pulse delay-200">●</span>
                    </div>
                  </div>
                ) : msg.contentBlocks && msg.contentBlocks.length > 0 ? (
                  /* Render content blocks if available */
                  <>
                    {msg.contentBlocks.map((block, idx) => (
                      <div key={`${msg.id}-block-${idx}`} className={idx > 0 ? 'mt-2' : ''}>
                        <div className="flex gap-3 w-full">
                          {/* Show sender name only on first block */}
                          {idx === 0 && nameGutter}
                          {/* Indent subsequent blocks */}
                          {idx > 0 && <div className="min-w-[60px]" />}

                          {/* Render the content block */}
                          <div className="flex-1 overflow-x-auto overflow-y-hidden">
                            <ContentBlock
                              block={block}
                              approvalContext={
                                currentChannelId && msg.senderType === 'agent'
                                  ? { context: 'channel', contextId: currentChannelId, agentId: msg.senderId, messageId: msg.id }
                                  : undefined
                              }
                            />
                          </div>

                          {/* Show message menu on last block, or draft indicator */}
                          {idx === (msg.contentBlocks?.length || 0) - 1 && (
                            <>
                              {msg.isDraft ? (
                                <div className="flex items-center gap-1 text-sm text-gray-400">
                                  <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-sm"></span>
                                </div>
                              ) : (
                                <MessageMenu
                                  messageId={msg.id}
                                  content={msg.content}
                                  senderType={msg.senderType as 'human' | 'agent'}
                                  metrics={msg.metrics}
                                  onEdit={msg.senderType === 'human' ? () => handleEditMessage(msg.id, msg.content) : undefined}
                                  onDelete={() => handleDeleteMessage(msg.id)}
                                />
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  /* No contentBlocks on the row — render its plain-text `content` */
                  <div className="flex gap-3 w-full">
                    {nameGutter}
                    {editingMessageId === msg.id ? (
                      <div className="flex-1 flex gap-2">
                        <Input
                          autoFocus
                          value={editingMessageContent}
                          onChange={(e) => setEditingMessageContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSaveMessage();
                            } else if (e.key === 'Escape') {
                              handleCancelEditMessage();
                            }
                          }}
                          className="flex-1"
                        />
                        <Button size="sm" onClick={handleSaveMessage}>Save</Button>
                        <Button size="sm" variant="outline" onClick={handleCancelEditMessage}>Cancel</Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex-1 overflow-x-auto overflow-y-hidden">
                          <ContentBlock block={{ type: 'text', content: msg.content }} />
                        </div>
                        <MessageMenu
                          messageId={msg.id}
                          content={msg.content}
                          senderType={msg.senderType as 'human' | 'agent'}
                          metrics={msg.metrics}
                          onEdit={msg.senderType === 'human' ? () => handleEditMessage(msg.id, msg.content) : undefined}
                          onDelete={() => handleDeleteMessage(msg.id)}
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
        <div className="p-5 border-t border-border" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
          {/* Pending attachments preview — same strip the chat composer uses */}
          <PendingAttachmentsStrip attachments={pendingAttachments} onRemove={removeAttachment} />
          <div className="flex gap-3 items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleAttachClick}
              disabled={isLoading}
              title="Attach file"
              className="h-8 w-8 flex-shrink-0"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <ConnectedChannelInput
              onSend={handleSendWithAttachments}
              placeholder={`Message #${currentChannel.name}...`}
              disabled={isLoading}
              disabledReason={
                isLoading
                  ? 'Waiting for an agent to reply… click Stop to cancel.'
                  : undefined
              }
            />
            {isLoading ? (
              <Button onClick={handleStopStream} variant="destructive">
                Stop
              </Button>
            ) : (
              <Button variant="outline" style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }} onClick={handleSendWithAttachments}>
                Send
              </Button>
            )}
          </div>
        </div>
        </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-lg mb-4">Select a channel or create a new one</p>
              <Button onClick={openChannelModal}>New Channel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
