import { create } from 'zustand';
import { Chat, Channel, ToolCallState, ContentBlock } from '@/types';
import { useToastStore } from './useToastStore';
import { useAgentStore } from './useAgentStore';
import { useSettingsStore } from './useSettingsStore';

export type { ToolCallState };

/** Pre-existing key — renaming it would silently reset everyone's choice. */
const SHOW_AGENT_ROOMS_KEY = 'show-agent-rooms';

function readShowAgentRooms(): boolean {
  try {
    return localStorage.getItem(SHOW_AGENT_ROOMS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * The single conversation store.
 *
 * Chats and channels are one storage substrate (a "chat" IS a channels row
 * with type='direct'); this store is the one renderer surface over both. The
 * conversation list arrives as two IPC projections — `channels` via getMemory
 * and `chats` via the chat IPC domain (which adds tags/archive/branch
 * columns) — so it is held as two arrays: one per projection shape, not one
 * per storage table.
 *
 * Layout:
 *   1. Conversation lists + current pointers (shared substrate state).
 *   2. Shared message-edit state — one edit at a time app-wide; the save
 *      actions stay per-surface because the IPC surfaces differ.
 *   3. Channel-surface state/actions — `channel`-prefixed, because the names
 *      would otherwise collide with the chat-surface fields below.
 *   4. Direct-channel (chat) slice — tags/archive filters, branch/swipe UI
 *      state, and the chat-surface streaming lifecycle. Its unprefixed names
 *      are load-bearing: ChatsView and the plugin API (`stores.useChatsStore`)
 *      read them, so renaming is a breaking change for plugins.
 */
interface ConversationsState {
  // ── 1. Conversation lists (two projections of the one channels table) ──
  channels: Channel[];
  currentChannelId: string | null;
  chats: Chat[];
  currentChatId: string | null;
  setChannels: (channels: Channel[]) => void;
  setCurrentChannelId: (id: string | null) => void;
  setChats: (chats: Chat[]) => void;
  setCurrentChatId: (id: string | null) => void;

  // ── 2. Shared message-edit state ──
  editingMessageId: string | null;
  editingMessageContent: string;
  startEditingMessage: (messageId: string, content: string) => void;
  setEditingMessageContent: (content: string) => void;
  cancelEditingMessage: () => void;

  // ── 3. Channel-surface state ──
  channelSelectedAgents: Map<string, string>;
  channelInput: string;
  channelIsLoading: boolean;
  /** Trailing text of the current channel's live draft preview — written by
   *  the app-lifetime stream consumer (useChatStream); drives autoscroll. */
  channelStreamingContent: string;
  showChannelModal: boolean;
  showAddAgentModal: boolean;
  renamingChannelId: string | null;
  channelSearchQuery: string;

  setChannelSelectedAgent: (channelId: string, agentId: string) => void;
  initChannelSelectedAgents: (channels: Channel[]) => void;
  setChannelInput: (input: string) => void;
  setChannelIsLoading: (isLoading: boolean) => void;
  setChannelStreamingContent: (content: string) => void;
  setChannelSearchQuery: (query: string) => void;
  clearChannelSearch: () => void;

  createChannel: (name: string) => Promise<void>;
  updateChannel: (channelId: string, updates: { name?: string; pinned?: boolean; tags?: string[] | null }) => Promise<void>;
  /** Reload the channel list via get-channels, honoring showArchived. */
  loadChannels: () => Promise<void>;
  /** IPC-backed tag filter over channels (get-channels-by-tags). */
  filterChannelsByTags: (tags: string[]) => Promise<void>;
  archiveChannel: (channelId: string) => Promise<void>;
  unarchiveChannel: (channelId: string) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  switchChannel: (channelId: string) => Promise<void>;
  addAgentToChannel: (agentId: string, channelId: string) => Promise<void>;
  saveChannelMessage: () => Promise<void>;
  deleteChannelMessage: (messageId: string) => Promise<void>;

  openChannelModal: () => void;
  closeChannelModal: () => void;
  openAddAgentModal: () => void;
  closeAddAgentModal: () => void;
  setRenamingChannelId: (channelId: string | null) => void;
  getCurrentChannel: () => Channel | undefined;

  // ── 4. Direct-channel (chat) slice ──
  input: string;
  isLoading: boolean;
  isCompacting: boolean;
  switchingChat: boolean;
  streamingContent: string;
  streamingContentBlocks: ContentBlock[];
  activeToolCalls: ToolCallState[];
  /**
   * Id of an agent message that's currently being regenerated. Set when
   * the user invokes regenerate and cleared on stream:end after the chat
   * reload. The view hides this id so the user sees the streaming bubble
   * appear in place of the original instead of waiting for the new reply
   * to render below the soon-to-be-archived original.
   */
  regeneratingMessageId: string | null;
  showArchived: boolean;
  /**
   * Whether agent-to-agent rooms are listed. Purely client-side, unlike
   * showArchived — the rooms are already loaded, so flipping this filters the
   * list in place and must never trigger a reload.
   */
  showAgentRooms: boolean;
  showChatModal: boolean;
  renamingChatId: string | null;
  searchQuery: string;
  selectedTags: string[];

  setInput: (input: string) => void;
  setIsLoading: (isLoading: boolean) => void;
  setStreamingContent: (content: string) => void;
  setStreamingContentBlocks: (blocks: ContentBlock[]) => void;
  setActiveToolCalls: (toolCalls: ToolCallState[]) => void;
  setSearchQuery: (query: string) => void;
  setShowArchived: (show: boolean) => void;
  setShowAgentRooms: (show: boolean) => void;
  toggleShowAgentRooms: () => void;
  setSelectedTags: (tags: string[]) => void;

  createChat: (name: string, agentId: string, tags?: string) => Promise<void>;
  createBlankChat: () => Promise<void>;
  updateChat: (chatId: string, updates: { name?: string; tags?: string; userPersona?: string }, options?: { silent?: boolean }) => Promise<void>;
  duplicateChat: (chatId: string) => Promise<void>;
  exportChatAsMarkdown: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  archiveChat: (chatId: string) => Promise<void>;
  unarchiveChat: (chatId: string) => Promise<void>;
  switchChat: (chatId: string) => Promise<void>;
  loadChats: () => Promise<void>;
  searchChats: (query: string) => Promise<void>;
  filterByTags: (tags: string[]) => Promise<void>;
  saveMessage: () => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;

  openChatModal: () => void;
  closeChatModal: () => void;
  setRenamingChatId: (chatId: string | null) => void;

  getCurrentChat: () => Chat | undefined;
  clearSearch: () => void;
  getAllTags: () => string[];
}

export const useConversationsStore = create<ConversationsState>((set, get) => ({
  // ── 1. Conversation lists ──
  channels: [],
  currentChannelId: null,
  chats: [],
  currentChatId: null,
  setChannels: (channels) => set({ channels }),
  setCurrentChannelId: (id) => set({ currentChannelId: id }),
  setChats: (chats) => set({ chats }),
  setCurrentChatId: (id) => set({ currentChatId: id }),

  // ── 2. Shared message-edit state ──
  editingMessageId: null,
  editingMessageContent: '',
  startEditingMessage: (messageId, content) => {
    set({
      editingMessageId: messageId,
      editingMessageContent: content,
    });
  },
  setEditingMessageContent: (content) => set({ editingMessageContent: content }),
  cancelEditingMessage: () => {
    set({
      editingMessageId: null,
      editingMessageContent: '',
    });
  },

  // ── 3. Channel-surface state ──
  channelSelectedAgents: new Map(),
  channelInput: '',
  channelIsLoading: false,
  channelStreamingContent: '',
  showChannelModal: false,
  showAddAgentModal: false,
  renamingChannelId: null,
  channelSearchQuery: '',

  setChannelSelectedAgent: (channelId, agentId) => set((state) => {
    const next = new Map(state.channelSelectedAgents);
    next.set(channelId, agentId);
    return { channelSelectedAgents: next };
  }),
  initChannelSelectedAgents: (channels) => {
    const map = new Map<string, string>();
    channels.forEach(channel => {
      const firstAgent = channel.participants.find(p => p.type === 'agent');
      if (firstAgent) {
        map.set(channel.id, firstAgent.id);
      }
    });
    set({ channelSelectedAgents: map });
  },
  setChannelInput: (input) => set({ channelInput: input }),
  setChannelIsLoading: (isLoading) => set({ channelIsLoading: isLoading }),
  setChannelStreamingContent: (content) => set({ channelStreamingContent: content }),
  setChannelSearchQuery: (query) => set({ channelSearchQuery: query }),
  clearChannelSearch: () => set({ channelSearchQuery: '' }),

  createChannel: async (name) => {
    if (!name.trim()) {
      useToastStore.getState().showToast('Please enter a channel name', 'warning');
      return;
    }
    try {
      await window.electron.createChannel({
        name: name,
        type: 'public',
      });
    } catch (error) {
      console.error('Failed to create channel:', error);
      useToastStore.getState().showToast('Failed to create channel', 'error');
    }
  },

  updateChannel: async (channelId, updates) => {
    try {
      // update-channel returns the bare channel object on success (pre-existing
      // quirk) or a { success:false, error } envelope on validation failure.
      const updated = await window.electron.updateChannel(channelId, updates);
      if (!updated || updated.id !== channelId) {
        useToastStore.getState().showToast((updated as unknown as { error?: string })?.error || 'Failed to update channel', 'error');
        return;
      }
      set((state) => ({
        channels: state.channels.map((c) =>
          c.id === channelId
            // Prefer the server's row (tags come back parsed/normalized);
            // preserve locally-loaded messages the projection may omit.
            ? { ...c, ...updated, messages: c.messages, participants: updated.participants?.length ? updated.participants : c.participants }
            : c
        ),
      }));
    } catch (error) {
      console.error('Failed to update channel:', error);
      useToastStore.getState().showToast('Failed to update channel', 'error');
    }
  },

  loadChannels: async () => {
    try {
      const { showArchived } = get();
      const result = await window.electron.getChannels({ includeArchived: showArchived });
      if (result.success && result.channels) {
        set((state) => {
          // get-channels omits messages for performance — keep any channel
          // that already has them loaded (typically the current one) so the
          // open view doesn't blank and re-fetch.
          const existingWithMessages = new Map(
            state.channels
              .filter((c) => c.messages && c.messages.length > 0)
              .map((c) => [c.id, c]),
          );
          return {
            channels: result.channels!.map((c) => {
              const existing = existingWithMessages.get(c.id);
              return existing ? { ...c, messages: existing.messages } : c;
            }),
          };
        });
      }
    } catch (error) {
      console.error('Error loading channels:', error);
      useToastStore.getState().showToast('Failed to load channels', 'error');
    }
  },

  filterChannelsByTags: async (tags) => {
    try {
      const { showArchived } = get();
      const result = await window.electron.getChannelsByTags({ tags, includeArchived: showArchived });
      if (result.success && result.channels) {
        set({ channels: result.channels });
      }
    } catch (error) {
      console.error('Error filtering channels by tags:', error);
      useToastStore.getState().showToast('Failed to filter channels', 'error');
    }
  },

  archiveChannel: async (channelId) => {
    try {
      const result = await window.electron.archiveChannel(channelId);
      if (result.success && result.channel) {
        set((state) => {
          const updatedChannels = state.showArchived
            ? state.channels.map((c) => (c.id === channelId ? { ...c, archivedAt: result.channel!.archivedAt } : c))
            : state.channels.filter((c) => c.id !== channelId);
          return {
            channels: updatedChannels,
            currentChannelId: state.currentChannelId === channelId && !state.showArchived ? null : state.currentChannelId,
          };
        });
        useToastStore.getState().showToast('Channel archived', 'success');
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to archive channel', 'error');
      }
    } catch (error) {
      console.error('Error archiving channel:', error);
      useToastStore.getState().showToast('Failed to archive channel', 'error');
    }
  },

  unarchiveChannel: async (channelId) => {
    try {
      const result = await window.electron.unarchiveChannel(channelId);
      if (result.success && result.channel) {
        set((state) => ({
          channels: state.channels.some((c) => c.id === channelId)
            ? state.channels.map((c) => (c.id === channelId ? { ...c, archivedAt: undefined } : c))
            : [...state.channels, result.channel!],
        }));
        useToastStore.getState().showToast('Channel unarchived', 'success');
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to unarchive channel', 'error');
      }
    } catch (error) {
      console.error('Error unarchiving channel:', error);
      useToastStore.getState().showToast('Failed to unarchive channel', 'error');
    }
  },

  deleteChannel: async (channelId) => {
    try {
      await window.electron.deleteChannel(channelId);
      set((state) => ({
        channels: state.channels.filter((c) => c.id !== channelId),
        currentChannelId: state.currentChannelId === channelId ? null : state.currentChannelId,
      }));
    } catch (error) {
      console.error('Failed to delete channel:', error);
      useToastStore.getState().showToast('Failed to delete channel', 'error');
    }
  },

  switchChannel: async (channelId) => {
    try {
      // Paint immediately with whatever is cached, then hydrate: history is not
      // part of the channel-list projection, so without this the view is empty
      // for any channel that wasn't the current one at boot (agent-to-agent
      // channels especially — nothing there reloads memory the way a send does).
      set({ currentChannelId: channelId });
      const result = await window.electron.switchChannel(channelId);
      const loaded = result.success ? result.channel : undefined;
      if (!loaded) return;
      set((state) => ({
        channels: state.channels.map((c) => {
          if (c.id !== channelId) return c;
          // A channel-message-added push can land while the fetch is in flight;
          // keep anything the server snapshot predates.
          const known = new Set(loaded.messages.map((m) => m.id));
          const localOnly = c.messages.filter((m) => !known.has(m.id));
          return { ...c, ...loaded, messages: [...loaded.messages, ...localOnly] };
        }),
        // Channels joined after boot never went through initChannelSelectedAgents,
        // which would leave the composer refusing to send with an agent visibly
        // selected in the header.
        channelSelectedAgents: state.channelSelectedAgents.has(channelId)
          ? state.channelSelectedAgents
          : (() => {
              const firstAgent = loaded.participants.find((p) => p.type === 'agent');
              if (!firstAgent) return state.channelSelectedAgents;
              return new Map(state.channelSelectedAgents).set(channelId, firstAgent.id);
            })(),
      }));
    } catch (error) {
      console.error('Failed to switch channel:', error);
      useToastStore.getState().showToast('Failed to switch channel', 'error');
    }
  },

  addAgentToChannel: async (agentId, channelId) => {
    try {
      await window.electron.addChannelParticipant({
        channelId,
        participantId: agentId,
      });
    } catch (error) {
      console.error('Failed to add agent to channel:', error);
      useToastStore.getState().showToast('Failed to add agent to channel', 'error');
    }
  },

  saveChannelMessage: async () => {
    const { editingMessageId, editingMessageContent } = get();
    if (!editingMessageId || !editingMessageContent.trim()) return;

    try {
      // Local message state is patched by the message-updated broadcast the
      // main process sends after a successful edit.
      const result = await window.electron.updateMessage(editingMessageId, editingMessageContent);
      if (!result.success) {
        useToastStore.getState().showToast('Failed to save message', 'error');
        return;
      }
      set({
        editingMessageId: null,
        editingMessageContent: '',
      });
    } catch (error) {
      console.error('Failed to save message:', error);
      useToastStore.getState().showToast('Failed to save message', 'error');
    }
  },

  deleteChannelMessage: async (messageId) => {
    try {
      await window.electron.deleteMessage(messageId);
    } catch (error) {
      console.error('Failed to delete message:', error);
      useToastStore.getState().showToast('Failed to delete message', 'error');
    }
  },

  openChannelModal: () => set({ showChannelModal: true }),
  closeChannelModal: () => set({ showChannelModal: false }),
  openAddAgentModal: () => set({ showAddAgentModal: true }),
  closeAddAgentModal: () => set({ showAddAgentModal: false }),
  setRenamingChannelId: (channelId) => set({ renamingChannelId: channelId }),

  getCurrentChannel: () => {
    const state = get();
    return state.channels.find((c) => c.id === state.currentChannelId);
  },

  // ── 4. Direct-channel (chat) slice ──
  input: '',
  isLoading: false,
  isCompacting: false,
  switchingChat: false,
  streamingContent: '',
  streamingContentBlocks: [],
  activeToolCalls: [],
  regeneratingMessageId: null,
  showArchived: false,
  showAgentRooms: readShowAgentRooms(),
  showChatModal: false,
  renamingChatId: null,
  searchQuery: '',
  selectedTags: [],

  setInput: (input) => set({ input }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setStreamingContent: (content) => set({ streamingContent: content }),
  setStreamingContentBlocks: (blocks) => set({ streamingContentBlocks: blocks }),
  setActiveToolCalls: (toolCalls) => set({ activeToolCalls: toolCalls }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setShowArchived: (show) => set({ showArchived: show }),
  setShowAgentRooms: (show) => {
    try {
      localStorage.setItem(SHOW_AGENT_ROOMS_KEY, String(show));
    } catch {
      // Non-fatal: preference just won't persist across restarts.
    }
    set({ showAgentRooms: show });
  },
  toggleShowAgentRooms: () => get().setShowAgentRooms(!get().showAgentRooms),
  setSelectedTags: (tags) => set({ selectedTags: tags }),

  createChat: async (name, agentId, tags) => {
    if (!name.trim()) {
      useToastStore.getState().showToast('Please enter a chat name', 'warning');
      return;
    }
    if (!agentId) {
      useToastStore.getState().showToast('Please select an agent', 'warning');
      return;
    }

    try {
      const result = await window.electron.createChat({
        name: name.trim(),
        agentId,
        tags,
      });

      if (result.success && result.chat) {
        const chat = result.chat;
        set((state) => ({
          chats: [chat, ...state.chats],
          currentChatId: chat.id,
          // Clear streaming state when creating new chat
          streamingContent: '',
          streamingContentBlocks: [],
          activeToolCalls: [],
          isLoading: false,
        }));
        useToastStore.getState().showToast('Chat created successfully', 'success');
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to create chat', 'error');
      }
    } catch (error) {
      console.error('Error creating chat:', error);
      useToastStore.getState().showToast('Failed to create chat', 'error');
    }
  },

  createBlankChat: async () => {
    // Get agents and default agent setting
    const agents = useAgentStore.getState().agents;
    if (agents.length === 0) {
      useToastStore.getState().showToast('Please create an agent first', 'warning');
      return;
    }

    // Use default agent if set and valid, otherwise fall back to first agent
    const defaultAgentId = useSettingsStore.getState().settings.defaultAgentId;
    const defaultAgent = defaultAgentId ? agents.find(a => a.id === defaultAgentId) : null;
    const agentId = defaultAgent?.id || agents[0].id;
    const name = 'New Chat';

    try {
      const result = await window.electron.createChat({
        name,
        agentId,
      });

      if (result.success && result.chat) {
        const chat = result.chat;
        set((state) => ({
          chats: [chat, ...state.chats],
          currentChatId: chat.id,
          // Clear streaming state when creating new chat
          streamingContent: '',
          streamingContentBlocks: [],
          activeToolCalls: [],
          isLoading: false,
          input: '',
        }));
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to create chat', 'error');
      }
    } catch (error) {
      console.error('Error creating blank chat:', error);
      useToastStore.getState().showToast('Failed to create chat', 'error');
    }
  },

  updateChat: async (chatId, updates, options = {}) => {
    try {
      const result = await window.electron.updateChat(chatId, updates);

      if (result.success && result.chat) {
        const chat = result.chat;
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId ? chat : c
          ),
        }));

        // Only show toast if not silent
        if (!options.silent) {
          useToastStore.getState().showToast('Chat updated successfully', 'success');
        }
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to update chat', 'error');
      }
    } catch (error) {
      console.error('Error updating chat:', error);
      useToastStore.getState().showToast('Failed to update chat', 'error');
    }
  },

  duplicateChat: async (chatId) => {
    try {
      const result = await window.electron.duplicateChat(chatId);
      if (result.success && result.chat) {
        const chat = result.chat;
        set((state) => ({
          chats: [chat, ...state.chats],
          currentChatId: chat.id,
        }));
        useToastStore.getState().showToast('Chat duplicated', 'success');
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to duplicate chat', 'error');
      }
    } catch (error) {
      console.error('Error duplicating chat:', error);
      useToastStore.getState().showToast('Failed to duplicate chat', 'error');
    }
  },

  exportChatAsMarkdown: async (chatId) => {
    try {
      const result = await window.electron.exportChatMarkdown(chatId);
      if (result.success) {
        useToastStore.getState().showToast('Chat exported', 'success');
      } else if (result.error !== 'Cancelled') {
        useToastStore.getState().showToast(result.error || 'Failed to export chat', 'error');
      }
    } catch (error) {
      console.error('Error exporting chat:', error);
      useToastStore.getState().showToast('Failed to export chat', 'error');
    }
  },

  deleteChat: async (chatId) => {
    try {
      const result = await window.electron.deleteChat(chatId);

      if (result.success) {
        set((state) => ({
          chats: state.chats.filter((c) => c.id !== chatId),
          currentChatId: state.currentChatId === chatId ? null : state.currentChatId,
        }));
        useToastStore.getState().showToast('Chat deleted successfully', 'success');
      } else {
        useToastStore.getState().showToast('Failed to delete chat', 'error');
      }
    } catch (error) {
      console.error('Error deleting chat:', error);
      useToastStore.getState().showToast('Failed to delete chat', 'error');
    }
  },

  archiveChat: async (chatId) => {
    try {
      const result = await window.electron.archiveChat(chatId);

      if (result.success && result.chat) {
        const chat = result.chat;
        set((state) => {
          const updatedChats = state.showArchived
            ? state.chats.map((c) => c.id === chatId ? chat : c)
            : state.chats.filter((c) => c.id !== chatId);

          return {
            chats: updatedChats,
            currentChatId: state.currentChatId === chatId ? null : state.currentChatId,
          };
        });
        useToastStore.getState().showToast('Chat archived', 'success');
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to archive chat', 'error');
      }
    } catch (error) {
      console.error('Error archiving chat:', error);
      useToastStore.getState().showToast('Failed to archive chat', 'error');
    }
  },

  unarchiveChat: async (chatId) => {
    try {
      const result = await window.electron.unarchiveChat(chatId);

      if (result.success && result.chat) {
        const chat = result.chat;
        set((state) => ({
          chats: state.chats.map((c) => c.id === chatId ? chat : c),
        }));
        useToastStore.getState().showToast('Chat unarchived', 'success');
      } else {
        useToastStore.getState().showToast(result.error || 'Failed to unarchive chat', 'error');
      }
    } catch (error) {
      console.error('Error unarchiving chat:', error);
      useToastStore.getState().showToast('Failed to unarchive chat', 'error');
    }
  },

  switchChat: async (chatId) => {
    const state = get();

    // Skip if already on this chat
    if (state.currentChatId === chatId) {
      return;
    }

    // Check if we already have the chat with messages loaded
    const existingChat = state.chats.find((c) => c.id === chatId);
    const hasMessages = existingChat?.messages && existingChat.messages.length > 0;

    // Immediately update UI with what we have
    set({
      currentChatId: chatId,
      streamingContent: '',
      streamingContentBlocks: [],
      activeToolCalls: [],
      isLoading: false,
      switchingChat: !hasMessages, // Only show switching state if we need to fetch
    });

    // Fire and forget - update settings in background
    window.electron.switchChat(chatId);

    // If we don't have messages, fetch the full chat data
    if (!hasMessages) {
      try {
        const chatResult = await window.electron.getChat(chatId);

        if (chatResult.success && chatResult.chat) {
          const chat = chatResult.chat;
          set((state) => ({
            chats: state.chats.map((c) => (c.id === chatId ? chat : c)),
            switchingChat: false,
          }));
        } else {
          set({ switchingChat: false });
          useToastStore.getState().showToast('Failed to load chat messages', 'error');
        }
      } catch (error) {
        console.error('Error fetching chat:', error);
        set({ switchingChat: false });
        useToastStore.getState().showToast('Failed to load chat', 'error');
      }
    }
  },

  loadChats: async () => {
    try {
      const { showArchived } = get();
      const result = await window.electron.getChats({ includeArchived: showArchived });

      if (result.success && result.chats) {
        // currentChatId is set by useAppInit at boot from memory.settings.
        // Don't fire another getMemory IPC here — it's the heaviest IPC in
        // the codebase (it synchronously walks every project's tasks/notes/
        // events) and a duplicate call at boot leaves the chat bar disabled
        // for noticeably longer.
        set((state) => {
          // Preserve any chat that already has messages loaded (typically
          // the boot-time currentChat populated by useAppInit) so the list
          // refresh doesn't drop them and force a re-fetch on next render.
          const existingWithMessages = new Map(
            state.chats
              .filter((c) => c.messages && c.messages.length > 0)
              .map((c) => [c.id, c]),
          );
          return {
            chats: result.chats!.map((c) => existingWithMessages.get(c.id) ?? c),
          };
        });
      }
    } catch (error) {
      console.error('Error loading chats:', error);
      useToastStore.getState().showToast('Failed to load chats', 'error');
    }
  },

  searchChats: async (query) => {
    try {
      const { showArchived } = get();
      const result = await window.electron.searchChats({
        query,
        includeArchived: showArchived
      });

      if (result.success && result.chats) {
        set({ chats: result.chats, searchQuery: query });
      }
    } catch (error) {
      console.error('Error searching chats:', error);
      useToastStore.getState().showToast('Failed to search chats', 'error');
    }
  },

  filterByTags: async (tags) => {
    try {
      const { showArchived } = get();
      const result = await window.electron.getChatsByTags({
        tags,
        includeArchived: showArchived
      });

      if (result.success && result.chats) {
        set({ chats: result.chats, selectedTags: tags });
      }
    } catch (error) {
      console.error('Error filtering chats by tags:', error);
      useToastStore.getState().showToast('Failed to filter chats', 'error');
    }
  },

  saveMessage: async () => {
    const { editingMessageId, editingMessageContent } = get();
    if (!editingMessageId || !editingMessageContent.trim()) return;

    try {
      const result = await window.electron.updateChatMessage(editingMessageId, editingMessageContent);
      if (!result.success) {
        useToastStore.getState().showToast('Failed to update message', 'error');
        return;
      }
      // Reflect the edit locally — nothing refetches chat history after this.
      set((state) => ({
        editingMessageId: null,
        editingMessageContent: '',
        chats: state.chats.map((chat) => {
          if (!chat.messages?.some((m) => m.id === editingMessageId)) return chat;
          return {
            ...chat,
            messages: chat.messages.map((m) =>
              m.id === editingMessageId
                ? {
                    ...m,
                    content: editingMessageContent,
                    contentBlocks: result.contentBlocks ?? m.contentBlocks,
                  }
                : m
            ),
          };
        }),
      }));
      useToastStore.getState().showToast('Message updated', 'success');
    } catch (error) {
      console.error('Error updating message:', error);
      useToastStore.getState().showToast('Failed to update message', 'error');
    }
  },

  deleteMessage: async (messageId) => {
    try {
      const result = await window.electron.deleteChatMessage(messageId);

      if (result.success) {
        // Remove the message from local state immediately
        set((state) => ({
          chats: state.chats.map((chat) => {
            if (!chat.messages?.some((m) => m.id === messageId)) return chat;
            return {
              ...chat,
              messages: chat.messages.filter((m) => m.id !== messageId),
            };
          }),
        }));
        useToastStore.getState().showToast('Message deleted', 'success');
      } else {
        useToastStore.getState().showToast('Failed to delete message', 'error');
      }
    } catch (error) {
      console.error('Error deleting message:', error);
      useToastStore.getState().showToast('Failed to delete message', 'error');
    }
  },

  openChatModal: () => set({ showChatModal: true }),
  closeChatModal: () => set({ showChatModal: false }),
  setRenamingChatId: (chatId) => set({ renamingChatId: chatId }),

  getCurrentChat: () => {
    const state = get();
    return state.chats.find((c) => c.id === state.currentChatId);
  },

  clearSearch: () => {
    set({ searchQuery: '', selectedTags: [] });
    get().loadChats();
  },

  getAllTags: () => {
    // Most-used first (ties alphabetical), so the visible slice of the
    // filter row surfaces the tags that actually organize things instead
    // of alphabetical accidents. Spans both surfaces, which disagree on
    // shape: chat tags are a comma-delimited string, channel tags a string[].
    const state = get();
    const counts = new Map<string, number>();
    const count = (tag: string) => {
      const trimmed = tag.trim();
      if (trimmed) counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
    };

    state.chats.forEach((chat) => {
      if (chat.tags) chat.tags.split(',').forEach(count);
    });
    state.channels.forEach((channel) => {
      channel.tags?.forEach(count);
    });

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  },
}));
