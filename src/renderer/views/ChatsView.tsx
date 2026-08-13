import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Paperclip, X, PanelTop, BarChart3, Wrench, RotateCcw, Settings2, CornerDownRight, Maximize2 } from 'lucide-react';
import { useConversationsStore, useToastStore, useSettingsStore, useUIPreferencesStore } from '@/stores';
import { useAgentStore } from '@/stores/useAgentStore';
import { ConversationListPanel } from '@/components/ConversationListPanel';
import { ChatInput } from '@/components/ChatInput';
import { AvatarPip } from '@/components/AvatarPip';
import { ChatMessageRow } from '@/components/ChatMessageRow';
import { ContentBlock } from '@/components/content/ContentBlock';
import { ChatStatusBar } from '@/components/ChatStatusBar';
import { ToolPanel } from '@/components/ToolPanel';
import { Button } from '@/components/ui/button'
import { ChatPersonaModal } from '@/components/modals/ChatPersonaModal';
import { PendingAttachmentsStrip, pickPendingAttachments, type PendingAttachment } from '@/components/PendingAttachmentsStrip';
import { useCompactMode } from '@/hooks/useCompactMode';

interface Tool {
  name: string;
  label: string;
  category: 'discovery' | 'builtin' | 'plugin' | 'mcp';
  enabled: boolean;
}

// A message typed while the agent was mid-turn. Queued lines are held until the
// turn ends, then flushed as a single combined message (one agent response).
interface QueuedMessage {
  id: string;
  text: string;
  attachments: PendingAttachment[];
}

/** Thin wrapper that isolates input state from the rest of ChatsView */
const ConnectedChatInput: React.FC<{ onSend: () => void; disabled: boolean; placeholder: string; disabledReason?: string }> = (props) => {
  const input = useConversationsStore((s) => s.input);
  const setInput = useConversationsStore((s) => s.setInput);
  return <ChatInput {...props} value={input} onChange={setInput} />;
};

function usePanelToggle(key: string, defaultValue = true): [boolean, () => void] {
  const [visible, setVisible] = useState(() => {
    const stored = localStorage.getItem(`chat-panel-${key}`);
    return stored !== null ? stored === 'true' : defaultValue;
  });
  const toggle = () => {
    setVisible(prev => {
      localStorage.setItem(`chat-panel-${key}`, String(!prev));
      return !prev;
    });
  };
  return [visible, toggle];
}

export const ChatsView: React.FC = () => {
  const [tools, setTools] = useState<Tool[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  const [showHeader, toggleHeader] = usePanelToggle('header', true);
  const [showStatusBar, toggleStatusBar] = usePanelToggle('statusbar', true);
  const [showToolPanel, toggleToolPanel] = usePanelToggle('toolpanel', true);

  // Compact mode strips this view to transcript + composer: the conversation
  // list, this view's own header (the compact header in the title bar replaces
  // it), the metrics bar, the tool panel and the panel-toggle row all go. The
  // stored per-panel toggles above are untouched, so leaving compact restores
  // exactly the layout the user had.
  const isCompact = useCompactMode();
  const setCompactMode = useUIPreferencesStore((s) => s.setCompactMode);

  // Granular selectors — only re-render when the specific value changes
  const currentChatId = useConversationsStore((s) => s.currentChatId);
  const isLoading = useConversationsStore((s) => s.isLoading);
  const streamingContent = useConversationsStore((s) => s.streamingContent);
  const streamingContentBlocks = useConversationsStore((s) => s.streamingContentBlocks);
  const editingMessageId = useConversationsStore((s) => s.editingMessageId);
  const editingMessageContent = useConversationsStore((s) => s.editingMessageContent);
  const regeneratingMessageId = useConversationsStore((s) => s.regeneratingMessageId);
  const hasInput = useConversationsStore((s) => s.input.trim().length > 0);
  // Something worth queueing while the agent is mid-turn (typed text or a
  // staged attachment).
  const canQueue = hasInput || pendingAttachments.length > 0;

  // Actions are stable — grab once via getState
  const {
    createBlankChat, startEditingMessage, setEditingMessageContent,
    saveMessage, cancelEditingMessage, deleteMessage, loadChats,
  } = useConversationsStore.getState();

  const { agents } = useAgentStore();

  // Use reactive selector for currentChat to avoid stale data
  const currentChat = useConversationsStore((state) =>
    state.chats.find((c) => c.id === state.currentChatId)
  );

  // Load chats on mount. (The chat-stream consumer is app-lifetime now —
  // mounted once in App — so no per-view stream state reset: clearing here
  // would wrongly re-enable the composer when navigating back mid-turn.)
  useEffect(() => {
    loadChats();
  }, [loadChats]);

  // Load tools when chat changes
  useEffect(() => {
    if (currentChatId) {
      loadTools();
    }
  }, [currentChatId]);

  const loadTools = async () => {
    if (!currentChatId) return;

    try {
      const result = await window.electron.getChatTools(currentChatId);
      if (result.success && result.tools) {
        setTools(result.tools);
      }
    } catch (error) {
      console.error('Failed to load tools:', error);
    }
  };

  const handleToggleTool = useCallback(async (toolName: string, enabled: boolean) => {
    if (!currentChatId) return;

    try {
      const result = await window.electron.toggleChatTool(currentChatId, toolName, enabled);
      if (result.success) {
        setTools(prev => prev.map(t => t.name === toolName ? { ...t, enabled } : t));
      }
    } catch (error) {
      console.error('Failed to toggle tool:', error);
    }
  }, [currentChatId]);

  const currentAgent = currentChat ? agents.find((a) => a.id === currentChat.agentId) : null;
  const userAvatar = useSettingsStore((s) => s.settings.userAvatar);
  const stacked = useUIPreferencesStore((s) => s.messageLayout) === 'stacked';

  // Streaming-row sender headers, mirroring ChatMessageRow's inline gutter
  // (same w-28) and stacked name line so the finalized message lands with
  // zero layout shift.
  const streamingAgentName = currentAgent?.name || 'AI';
  const streamingAgentColor = currentAgent?.color || '#c084fc';
  const streamingNameGutter = (
    <div className="flex items-center gap-2 flex-shrink-0 w-28 self-start" title={streamingAgentName}>
      <AvatarPip avatar={currentAgent?.avatar} name={streamingAgentName} color={streamingAgentColor} />
      <span className="text-base font-semibold truncate min-w-0" style={{ color: streamingAgentColor }}>
        {streamingAgentName}:
      </span>
    </div>
  );
  const streamingNameLine = (
    <div className="flex items-center gap-2 mb-0.5">
      <AvatarPip avatar={currentAgent?.avatar} name={streamingAgentName} color={streamingAgentColor} />
      <div className="text-base font-semibold" style={{ color: streamingAgentColor }}>
        {streamingAgentName}
      </div>
    </div>
  );

  // Stable callbacks for ChatMessageRow
  const handleStartEdit = useCallback((id: string, content: string) => startEditingMessage(id, content), [startEditingMessage]);
  const handleDeleteMsg = useCallback((id: string) => deleteMessage(id), [deleteMessage]);

  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentChat?.messages?.length, streamingContent]);


  // Send one or more composed lines as a SINGLE combined turn (blank-line
  // separated), then trigger the agent's reply. isLoading is set synchronously
  // up front so a rapid follow-up Enter queues instead of starting a second
  // turn — consecutive user messages would break the Claude API's alternating
  // user/assistant requirement.
  const dispatchSend = async (items: QueuedMessage[]) => {
    if (!currentChatId) return;
    const content = items.map((i) => i.text.trim()).filter(Boolean).join('\n\n');
    const attachmentPaths = items.flatMap((i) => i.attachments.map((a) => a.path));
    if (!content && attachmentPaths.length === 0) return;

    useConversationsStore.setState({ isLoading: true, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [] });

    try {
      const sendResult = await window.electron.sendChatMessage({
        chatId: currentChatId,
        content,
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      });

      // The handler returns a {success:false,error} envelope (e.g. a message
      // over the 50k-char limit) rather than throwing, so the catch below never
      // fires — surface it and stop instead of silently proceeding to start a
      // turn on a message that was never stored.
      if (sendResult && sendResult.success === false) {
        useToastStore.getState().showToast(sendResult.error || 'Message could not be sent', 'error');
        useConversationsStore.setState({ isLoading: false, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [] });
        return;
      }

      // Reload the specific chat to get updated messages
      const result = await window.electron.getChat(currentChatId);
      if (result.success && result.chat) {
        const chat = result.chat;
        useConversationsStore.setState((state) => ({
          chats: state.chats.map((c) => (c.id === currentChatId ? chat : c)),
        }));
      }

      if (currentAgent && currentChat) {
        await window.electron.chatWithAgent({ chatId: currentChatId, agentId: currentAgent.id });
      } else {
        // No agent to respond — release the busy state ourselves so the
        // composer (and any queue) doesn't stay stuck waiting for a stream:end
        // that will never come.
        useConversationsStore.setState({ isLoading: false, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [] });
      }
    } catch (error) {
      console.error('Error sending message:', error);
      useConversationsStore.setState({ isLoading: false, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [] });
    }
  };

  const handleSend = async () => {
    // Read isLoading from the store (not the render closure) so a fast burst
    // can't slip a second real send through before the first marked us busy.
    const { input, setInput, isLoading: busy } = useConversationsStore.getState();
    if ((!input.trim() && pendingAttachments.length === 0) || !currentChatId) return;

    const item: QueuedMessage = {
      id: crypto.randomUUID(),
      text: input,
      attachments: pendingAttachments,
    };
    setInput('');
    setPendingAttachments([]);

    // Agent mid-turn → queue; the flush effect sends it when the turn ends.
    if (busy) {
      setQueuedMessages((prev) => [...prev, item]);
      return;
    }

    await dispatchSend([item]);
  };

  // Flush the queued burst as one combined turn when the agent's turn ends.
  // Guarded on the isLoading true→false edge so it fires exactly once per turn.
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;
    if (wasLoading && !isLoading && queuedMessages.length > 0 && currentChatId) {
      const items = queuedMessages;
      setQueuedMessages([]);
      void dispatchSend(items);
    }
    // dispatchSend omitted from deps on purpose — the effect fires on the
    // loading edge and closes over the current render (fresh agent/chat).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, queuedMessages, currentChatId]);

  // Regenerate an agent message: archives the original (and any active
  // descendants) and streams a sibling reply. The errored message — if any —
  // is preserved on the archived branch so the user can swipe back to it.
  const handleRegenerate = useCallback(async (messageId: string) => {
    if (!currentChatId || isLoading) return;
    // regeneratingMessageId hides the row immediately so the user sees the
    // streaming bubble appear in place of the original. Cleared in the
    // stream:end branch of the chat-stream listener (alongside the chat
    // reload that surfaces the freshly-archived state).
    useConversationsStore.setState({
      isLoading: true,
      streamingContent: '',
      streamingContentBlocks: [],
      activeToolCalls: [],
      regeneratingMessageId: messageId,
    });
    try {
      const result = await window.electron.regenerateChatMessage({ messageId });
      if (!result.success && !result.aborted && result.error) {
        useToastStore.getState().showToast(result.error, 'error');
      }
    } catch (error) {
      console.error('Error regenerating message:', error);
      useConversationsStore.setState({
        isLoading: false,
        streamingContent: '',
        streamingContentBlocks: [],
        activeToolCalls: [],
        regeneratingMessageId: null,
      });
    }
  }, [currentChatId, isLoading]);

  // Generate the next agent reply when the user has sent something but no
  // agent message exists yet (e.g. after sending a message that didn't auto-
  // dispatch). Distinct from regenerate: nothing to archive.
  const handleGenerateResponse = useCallback(async () => {
    if (!currentChatId || !currentAgent || isLoading) return;
    useConversationsStore.setState({ isLoading: true, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [] });
    try {
      await window.electron.chatWithAgent({ chatId: currentChatId, agentId: currentAgent.id });
    } catch (error) {
      console.error('Error generating response:', error);
      useConversationsStore.setState({ isLoading: false, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [] });
    }
  }, [currentChatId, currentAgent, isLoading]);

  // Swipe through regeneration variants: activates the prev/next sibling and
  // reloads so the conversation reflects the new active path.
  const handleSwipeBranch = useCallback(async (messageId: string, direction: 'prev' | 'next') => {
    if (!currentChatId) return;
    const result = await window.electron.swipeChatMessageBranch({ messageId, direction });
    if (!result.success) {
      if (result.error) useToastStore.getState().showToast(result.error, 'error');
      return;
    }
    const reloaded = await window.electron.getChat(currentChatId);
    if (reloaded.success && reloaded.chat) {
      useConversationsStore.setState((state) => ({
        chats: state.chats.map((c) => (c.id === currentChatId ? reloaded.chat! : c)),
      }));
    }
  }, [currentChatId]);

  const handleAttachClick = async () => {
    const newAttachments = await pickPendingAttachments();
    if (newAttachments.length > 0) {
      setPendingAttachments((prev) => [...prev, ...newAttachments]);
    }
  };

  const removeAttachment = (index: number) => {
    setPendingAttachments((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  };

  return (
    <div className="flex h-full">
      {/* Unified conversations panel */}
      {!isCompact && <ConversationListPanel />}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {currentChatId && currentChat ? (
          <>
            {/* Chat header */}
            {showHeader && !isCompact && (
              <div className="p-4 border-b border-border" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-lg font-semibold">{currentChat.name}</h2>
                  {currentAgent && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: currentAgent.color }}
                      />
                      <span>{currentAgent.name}</span>
                      {currentAgent.archetype?.type === 'roleplay' && (
                        <button
                          type="button"
                          onClick={() => setPersonaModalOpen(true)}
                          className="ml-1 p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                          title={currentChat.userPersona ? `Playing as: ${currentChat.userPersona}` : 'Set your character'}
                        >
                          <Settings2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {currentChat.tags && (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {currentChat.tags.split(',').map((tag) => (
                      <span
                        key={tag.trim()}
                        className="px-2 py-0.5 text-xs bg-accent rounded-md"
                      >
                        {tag.trim()}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-5">
              <div className="flex flex-col gap-4">
              {currentChat.messages.filter(msg => msg.id !== regeneratingMessageId).map((msg) => (
                <ChatMessageRow
                  key={msg.id}
                  messageId={msg.id}
                  content={msg.content}
                  senderType={msg.senderType}
                  displayName={msg.senderDisplayName || (msg.senderType === 'human' ? 'You' : currentAgent?.name || 'Agent')}
                  nameColor={msg.senderColor || (msg.senderType === 'human' ? '#60a5fa' : currentAgent?.color || '#c084fc')}
                  avatar={msg.senderType === 'human' ? userAvatar : currentAgent?.avatar}
                  contentBlocks={msg.contentBlocks}
                  metrics={msg.metrics}
                  branchIndex={msg.branchIndex ?? 0}
                  branchCount={msg.branchCount ?? 1}
                  isEditing={editingMessageId === msg.id}
                  editingContent={editingMessageContent}
                  approvalContext={
                    currentChatId && msg.senderType === 'agent'
                      ? { context: 'chat', contextId: currentChatId, agentId: msg.senderId }
                      : undefined
                  }
                  onStartEdit={handleStartEdit}
                  onSetEditContent={setEditingMessageContent}
                  onSaveEdit={saveMessage}
                  onCancelEdit={cancelEditingMessage}
                  onDelete={handleDeleteMsg}
                  onRetry={handleRegenerate}
                  onSwipeBranch={handleSwipeBranch}
                />
              ))}

              {/* Streaming content - rendered as incremental content blocks.
                  Mirrors ChatMessageRow's layouts (same gutter width, same
                  stacked structure) so nothing jumps when the message
                  finalizes into a real row. */}
              {isLoading && (streamingContentBlocks.length > 0 || streamingContent) && (() => {
                // Compute display blocks: committed blocks + trailing text buffer
                const displayBlocks = [
                  ...streamingContentBlocks,
                  ...(streamingContent ? [{ type: 'text' as const, content: streamingContent, timestamp: Date.now() }] : []),
                ];
                const cursor = (
                  <div className="flex items-center gap-1 text-sm text-gray-400">
                    <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-sm"></span>
                  </div>
                );
                if (stacked) {
                  return (
                    <div className="w-full group">
                      {streamingNameLine}
                      <div className="flex gap-3">
                        <div className="flex-1 overflow-x-auto overflow-y-hidden min-w-0">
                          {displayBlocks.map((block, idx) => (
                            <div key={`streaming-block-${idx}`} className={idx > 0 ? 'mt-2' : ''}>
                              <ContentBlock block={block} />
                            </div>
                          ))}
                        </div>
                        {cursor}
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="w-full group">
                    {displayBlocks.map((block, idx) => (
                      <div key={`streaming-block-${idx}`} className={idx > 0 ? 'mt-2' : ''}>
                        <div className="flex gap-3 w-full">
                          {idx === 0 && streamingNameGutter}
                          {idx > 0 && <div className="w-28 flex-shrink-0" />}
                          <div className="flex-1 overflow-x-auto overflow-y-hidden">
                            <ContentBlock block={block} />
                          </div>
                          {idx === displayBlocks.length - 1 && cursor}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              {/* Loading indicator when stream started but no content yet */}
              {isLoading && streamingContentBlocks.length === 0 && !streamingContent && (
                stacked ? (
                  <div className="w-full">
                    {streamingNameLine}
                    <div className="flex items-center gap-1 text-gray-400">
                      <span className="animate-pulse">●</span>
                      <span className="animate-pulse delay-100">●</span>
                      <span className="animate-pulse delay-200">●</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-3 w-full">
                    {streamingNameGutter}
                    <div className="flex-1 flex items-center gap-1 text-gray-400">
                      <span className="animate-pulse">●</span>
                      <span className="animate-pulse delay-100">●</span>
                      <span className="animate-pulse delay-200">●</span>
                    </div>
                  </div>
                )
              )}

              {/* Bottom retry/generate-response button.
                  - Last message is errored agent → regenerate (archives the
                    error message; user can swipe back if they want).
                  - Last message is human with no agent reply yet → generate
                    a response (no archive). */}
              {!isLoading && currentChat.messages.length > 0 && (() => {
                const msgs = currentChat.messages;
                const lastMsg = msgs[msgs.length - 1];
                const lastIsUser = lastMsg.senderType === 'human';
                const lastAgentHasError = lastMsg.senderType === 'agent'
                  && lastMsg.contentBlocks?.some(b =>
                    (b.type === 'system' && b.content?.startsWith('Error:'))
                    || (b.type === 'tool-call' && b.toolCall?.status === 'error')
                  );

                if (!lastIsUser && !lastAgentHasError) return null;

                return (
                  <div className="flex items-center gap-2 pt-2">
                    <div className="min-w-[60px]" />
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => lastAgentHasError ? handleRegenerate(lastMsg.id) : handleGenerateResponse()}
                    >
                      <RotateCcw className="h-3 w-3" />
                      {lastAgentHasError ? 'Retry' : 'Generate response'}
                    </Button>
                  </div>
                );
              })()}

              <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Status bar + Tool Panel + Panel toggles */}
            {showStatusBar && !isCompact && (
              <ChatStatusBar
                messages={currentChat.messages}
                provider={currentAgent?.provider}
                model={currentAgent?.model}
                isStreaming={isLoading}
              />
            )}
            {showToolPanel && !isCompact && tools.length > 0 && (
              <ToolPanel tools={tools} onToggleTool={handleToggleTool} />
            )}

            {/* Input area */}
            <div className="p-4 border-t border-border" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
              {/* Queued messages typed while the agent was mid-reply */}
              {queuedMessages.length > 0 && (
                <div className="mb-2 space-y-1">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-xs text-muted-foreground">
                      Queued — {queuedMessages.length} message{queuedMessages.length > 1 ? 's' : ''} · sends when the agent finishes
                    </span>
                    <button
                      onClick={() => setQueuedMessages([])}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </button>
                  </div>
                  {queuedMessages.map((q) => (
                    <div
                      key={q.id}
                      className="flex items-center gap-2 px-2 py-1 rounded border border-border bg-background/60 text-sm"
                    >
                      <CornerDownRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">
                        {q.text.trim() || `${q.attachments.length} attachment${q.attachments.length > 1 ? 's' : ''}`}
                      </span>
                      {q.attachments.length > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
                          <Paperclip className="h-3 w-3" />
                          {q.attachments.length}
                        </span>
                      )}
                      <button
                        onClick={() => setQueuedMessages((prev) => prev.filter((m) => m.id !== q.id))}
                        className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                        title="Remove from queue"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Pending attachments preview */}
              <PendingAttachmentsStrip attachments={pendingAttachments} onRemove={removeAttachment} />
              <div className="flex gap-2 items-center">
                {/* Panel toggles + Attach button */}
                <div className="flex items-center flex-shrink-0">
                  {!isCompact && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleHeader}
                        title={showHeader ? 'Hide header' : 'Show header'}
                        className={`h-8 w-8 ${showHeader ? '' : 'opacity-40'}`}
                      >
                        <PanelTop className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleStatusBar}
                        title={showStatusBar ? 'Hide metrics' : 'Show metrics'}
                        className={`h-8 w-8 ${showStatusBar ? '' : 'opacity-40'}`}
                      >
                        <BarChart3 className="h-4 w-4" />
                      </Button>
                      {tools.length > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={toggleToolPanel}
                          title={showToolPanel ? 'Hide tools' : 'Show tools'}
                          className={`h-8 w-8 ${showToolPanel ? '' : 'opacity-40'}`}
                        >
                          <Wrench className="h-4 w-4" />
                        </Button>
                      )}
                      {/* Entering compact mode from the surface it applies to.
                          Leaving it is the compact header's job — this row is
                          one of the things compact mode hides. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCompactMode(true)}
                        title="Compact conversation"
                        className="h-8 w-8"
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                      <div className="w-px h-5 bg-border mx-1" />
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleAttachClick}
                    disabled={!currentChatId}
                    title="Attach file"
                    className="h-8 w-8"
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                </div>
                <ConnectedChatInput
                  placeholder={
                    isLoading
                      ? `${currentAgent?.name ?? 'Agent'} is replying — type to queue, sends when it finishes…`
                      : `Message ${currentAgent?.name || 'agent'}...`
                  }
                  onSend={handleSend}
                  disabled={!currentAgent}
                  disabledReason={
                    !currentChat
                      ? 'This chat is no longer available.'
                      : !currentChat.agentId
                        ? 'No agent assigned to this chat.'
                        : !currentAgent
                          ? 'Loading agent…'
                          : undefined
                  }
                />
                {/* Stop is the safety control, so it stays put for as long as
                    the turn is running — it must never become Queue under the
                    cursor just because the user started typing. */}
                {isLoading && (
                  <Button
                    variant="outline"
                    style={{ borderColor: 'var(--status-error)', color: 'var(--status-error)' }}
                    onClick={() => window.electron.stopChatStream(currentChatId)}
                    title="Stop the current turn"
                  >
                    Stop
                  </Button>
                )}
                {(!isLoading || canQueue) && (
                  <Button
                    variant="outline"
                    style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}
                    onClick={handleSend}
                    disabled={!isLoading && !hasInput && pendingAttachments.length === 0}
                    title={isLoading ? 'Send as soon as the current turn finishes' : undefined}
                  >
                    {isLoading ? 'Queue' : 'Send'}
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-lg mb-4">Select a chat or create a new one</p>
              <Button onClick={createBlankChat}>New Chat</Button>
            </div>
          </div>
        )}
      </div>

      {/* Persona modal — only mounts when needed (roleplay chat + open). */}
      {currentChatId && currentChat && currentAgent?.archetype?.type === 'roleplay' && (
        <ChatPersonaModal
          open={personaModalOpen}
          onOpenChange={setPersonaModalOpen}
          chatId={currentChatId}
          initialPersona={currentChat.userPersona ?? ''}
        />
      )}
    </div>
  );
};
