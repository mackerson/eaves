import { useCallback, useEffect } from 'react';
import { useConversationsStore, useToastStore } from '@/stores';
import { useUIStore } from '@/stores/useUIStore';
import { MessageContentSchema, validateWithSchema } from '@shared/validation';

/**
 * The in-flight selected-agent turn, shared between handleSend and
 * handleStopStream. An aborted turn deletes its draft server-side without
 * any push, so stop must settle the pending send and drop the draft locally.
 */
let activeTurn: { channelId: string; draftId: string | null; settle: () => void } | null = null;

function removeChannelMessage(channelId: string, messageId: string) {
  const state = useConversationsStore.getState();
  state.setChannels(state.channels.map(channel => {
    if (channel.id !== channelId) return channel;
    return { ...channel, messages: channel.messages.filter(m => m.id !== messageId) };
  }));
}

/**
 * Hook encapsulating all channel-related actions:
 * sending messages, streaming, editing, renaming, pinning, deleting.
 *
 * Keeps ChannelView free of business logic.
 */
export function useChannelActions() {
  const {
    setChannels,
    setRenamingChannelId,
    startEditingMessage,
    cancelEditingMessage,
    saveChannelMessage,
    openAddAgentModal,
    closeAddAgentModal,
    addAgentToChannel,
    openChannelModal,
  } = useConversationsStore();

  const showConfirmation = useUIStore((s) => s.showConfirmation);
  const showToast = useToastStore((s) => s.showToast);

  // Listen for real-time message updates
  useEffect(() => {
    const cleanup = window.electron.onMessageUpdated(({ messageId, contentBlocks, content, isDraft, metrics }) => {
      const state = useConversationsStore.getState();
      // Empty-turn finalize (ADR-001): the server deleted the draft and
      // pushed a finalize-shaped signal (empty content, isDraft:false) as
      // the terminal marker. Remove the local draft row instead of leaving
      // a ghost until the next reload.
      if (isDraft === false && !content?.trim() && (!contentBlocks || contentBlocks.length === 0)) {
        const holder = state.channels.find(c => c.messages.some(m => m.id === messageId && m.isDraft));
        if (holder) {
          removeChannelMessage(holder.id, messageId);
          return;
        }
      }
      const updatedChannels = state.channels.map(channel => {
        const messageIndex = channel.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          const updatedMessages = [...channel.messages];
          updatedMessages[messageIndex] = {
            ...updatedMessages[messageIndex],
            contentBlocks: contentBlocks || updatedMessages[messageIndex].contentBlocks,
            content: content !== undefined ? content : updatedMessages[messageIndex].content,
            isDraft: isDraft !== undefined ? isDraft : updatedMessages[messageIndex].isDraft,
            metrics: metrics !== undefined ? metrics : updatedMessages[messageIndex].metrics,
          };
          return { ...channel, messages: updatedMessages };
        }
        return channel;
      });
      state.setChannels(updatedChannels);
    });
    return cleanup;
  }, []);

  // Listen for dispatcher-triggered agent messages (e.g. @mention responses)
  useEffect(() => {
    const cleanup = window.electron.onChannelMessageAdded(({ channelId, message }) => {
      const state = useConversationsStore.getState();
      const updatedChannels = state.channels.map(channel => {
        if (channel.id !== channelId) return channel;
        // Avoid duplicate if message already exists (e.g. from streaming)
        if (channel.messages.some(m => m.id === message.id)) return channel;
        return { ...channel, messages: [...channel.messages, message] };
      });
      state.setChannels(updatedChannels);
    });
    return cleanup;
  }, []);

  // Reload channels when agents create/modify channels via tools
  useEffect(() => {
    const cleanup = window.electron.onChannelsChanged(async () => {
      const memory = await window.electron.getMemory();
      useConversationsStore.getState().setChannels(memory.channels || []);
    });
    return cleanup;
  }, []);

  const loadMemory = useCallback(async () => {
    const memory = await window.electron.getMemory();
    setChannels(memory.channels || []);
    useConversationsStore.getState().setCurrentChannelId(memory.currentChannelId);
    useConversationsStore.getState().initChannelSelectedAgents(memory.channels || []);
    return memory;
  }, [setChannels]);

  /**
   * Send the composed message (optionally with staged attachment file paths).
   * Returns true when the send was dispatched — the composer uses this to
   * know whether to clear its staged attachments.
   */
  const handleSend = useCallback(async (attachments?: string[]): Promise<boolean> => {
    const state = useConversationsStore.getState();
    if (state.channelIsLoading) return false;

    const validation = validateWithSchema(MessageContentSchema, state.channelInput);
    if (!validation.success) {
      if (state.channelInput.trim().length === 0) {
        // Channel sends require text (send-message pins MessageContentSchema);
        // surface why an attachment-only send goes nowhere.
        if (attachments && attachments.length > 0) {
          showToast('Add a message to send with the attachment', 'warning');
        }
        return false;
      }
      showToast(validation.error, 'warning');
      return false;
    }

    if (!state.currentChannelId) {
      showToast('Please select a channel first', 'warning');
      return false;
    }

    const selectedAgentId = state.channelSelectedAgents.get(state.currentChannelId);
    if (!selectedAgentId) {
      showToast('Please select an agent for this channel', 'warning');
      return false;
    }

    const channelId = state.currentChannelId;
    const content = validation.data;
    state.setChannelInput('');
    state.setChannelIsLoading(true);
    state.setChannelStreamingContent('');

    const cleanups: Array<() => void> = [];

    try {
      // The whole turn runs server-side: send-message with an agentId both
      // persists and dispatches, so this hook never drives the turn itself.
      // The live preview is rendered by the app-lifetime stream consumer
      // (useChatStream, envelope-filtered);
      // the persisted reply arrives via the channel-message-added (draft) and
      // message-updated (finalize) pushes the listeners above already handle.
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const turn = { channelId, draftId: null as string | null, settle };
      activeTurn = turn;

      // Bound the turn: the server announces the agent's draft, then
      // finalizes it. A non-draft push from the addressed agent is terminal.
      cleanups.push(window.electron.onChannelMessageAdded(({ channelId: eventChannelId, message }) => {
        if (eventChannelId !== channelId || message.senderId !== selectedAgentId) return;
        if (message.isDraft) {
          turn.draftId = message.id;
        } else {
          settle();
        }
      }));
      cleanups.push(window.electron.onMessageUpdated(({ messageId, isDraft }) => {
        if (turn.draftId && messageId === turn.draftId && isDraft === false) settle();
      }));

      const userResult = await window.electron.sendMessage({
        channelId,
        content,
        agentId: selectedAgentId,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      });
      if (!userResult.success) {
        settle();
        showToast(userResult.error || 'Failed to send message', 'error');
        return false;
      }

      // No push exists for human sends — reload to pick up the new message.
      const updatedMemory = await window.electron.getMemory();
      useConversationsStore.getState().setChannels(updatedMemory.channels);

      await settled;

      // In-band stream errors finalize server-side (the error lives in a
      // system contentBlock); the app-lifetime consumer toasts them as they
      // stream, so nothing further to surface here.
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      showToast(`Error: ${errorMessage}`, 'error');
      window.electron.logError({ message: 'Channel send exception', error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      activeTurn = null;
      const s = useConversationsStore.getState();
      s.setChannelIsLoading(false);
      s.setChannelStreamingContent('');
    }
  }, [showToast]);

  const handleStopStream = useCallback(async () => {
    try {
      const state = useConversationsStore.getState();
      const selectedAgentId = state.currentChannelId
        ? state.channelSelectedAgents.get(state.currentChannelId)
        : undefined;
      await window.electron.stopStream({
        channelId: state.currentChannelId || undefined,
        agentId: selectedAgentId || undefined,
      });
    } catch (error) {
      window.electron.logError({
        message: 'Failed to stop stream',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // An aborted turn deletes its draft server-side with no push — drop it
      // locally and settle the pending send so its cleanup runs.
      const turn = activeTurn;
      if (turn) {
        if (turn.draftId) removeChannelMessage(turn.channelId, turn.draftId);
        turn.settle();
      }
      const state = useConversationsStore.getState();
      state.setChannelIsLoading(false);
      state.setChannelStreamingContent('');
    }
  }, []);

  const handleChannelSelect = useCallback(async (channelId: string) => {
    await window.electron.switchChannel(channelId);
    await loadMemory();
  }, [loadMemory]);

  const handleRenameChannel = useCallback(async (channelId: string, newName: string) => {
    setRenamingChannelId(null);
    if (!newName.trim()) return;
    await window.electron.updateChannel(channelId, { name: newName });
    await loadMemory();
  }, [setRenamingChannelId, loadMemory]);

  const handleDeleteChannel = useCallback((channelId: string) => {
    showConfirmation('Are you sure you want to delete this channel? All messages will be deleted.', async () => {
      await window.electron.deleteChannel(channelId);
      await loadMemory();
    });
  }, [showConfirmation, loadMemory]);

  const handleToggleChannelPin = useCallback(async (channelId: string, pinned: boolean) => {
    await window.electron.updateChannel(channelId, { pinned });
    await loadMemory();
  }, [loadMemory]);

  // ── Tags / archive (first-class columns on every channel, not chat-only) ──

  const handleAddChannelTag = useCallback(async (channelId: string, tag: string) => {
    const state = useConversationsStore.getState();
    const channel = state.channels.find((c) => c.id === channelId);
    const trimmed = tag.trim();
    if (!channel || !trimmed) return;
    const existing = channel.tags ?? [];
    if (existing.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return;
    await state.updateChannel(channelId, { tags: [...existing, trimmed] });
  }, []);

  const handleRemoveChannelTag = useCallback(async (channelId: string, tag: string) => {
    const state = useConversationsStore.getState();
    const channel = state.channels.find((c) => c.id === channelId);
    if (!channel) return;
    const next = (channel.tags ?? []).filter((t) => t !== tag);
    // Empty list clears the column (null), mirroring the repository contract.
    await state.updateChannel(channelId, { tags: next.length > 0 ? next : null });
  }, []);

  const handleToggleChannelArchive = useCallback(async (channelId: string, currentlyArchived: boolean) => {
    const state = useConversationsStore.getState();
    if (currentlyArchived) {
      await state.unarchiveChannel(channelId);
    } else {
      await state.archiveChannel(channelId);
    }
  }, []);

  const handleAgentChange = useCallback((agentId: string) => {
    const state = useConversationsStore.getState();
    if (!state.currentChannelId) return;
    state.setChannelSelectedAgent(state.currentChannelId, agentId);
  }, []);

  const handleAddAgentToChannel = useCallback(async (agentId: string) => {
    const state = useConversationsStore.getState();
    if (!state.currentChannelId) return;
    await addAgentToChannel(agentId, state.currentChannelId);
    closeAddAgentModal();
    await loadMemory();
  }, [addAgentToChannel, closeAddAgentModal, loadMemory]);

  const handleEditMessage = useCallback((messageId: string, content: string) => {
    startEditingMessage(messageId, content);
  }, [startEditingMessage]);

  const handleSaveMessage = useCallback(async () => {
    await saveChannelMessage();
    await loadMemory();
  }, [saveChannelMessage, loadMemory]);

  const handleDeleteMessage = useCallback((messageId: string) => {
    showConfirmation('Are you sure you want to delete this message?', async () => {
      await window.electron.deleteMessage(messageId);
      await loadMemory();
    });
  }, [showConfirmation, loadMemory]);

  return {
    loadMemory,
    handleSend,
    handleStopStream,
    handleChannelSelect,
    handleRenameChannel,
    handleDeleteChannel,
    handleToggleChannelPin,
    handleAddChannelTag,
    handleRemoveChannelTag,
    handleToggleChannelArchive,
    handleAgentChange,
    handleAddAgentToChannel,
    handleEditMessage,
    handleSaveMessage,
    handleCancelEditMessage: cancelEditingMessage,
    handleDeleteMessage,
    openAddAgentModal,
    openChannelModal,
  };
}
