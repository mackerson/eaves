import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConversationsStore } from './useConversationsStore';
import { useToastStore } from './useToastStore';
import { useAgentStore } from './useAgentStore';
import { useSettingsStore } from './useSettingsStore';

const SHOW_AGENT_ROOMS_KEY = 'show-agent-rooms';

function resetConversations() {
  useConversationsStore.setState({
    channels: [],
    currentChannelId: null,
    chats: [],
    currentChatId: null,
    editingMessageId: null,
    editingMessageContent: '',
    channelSelectedAgents: new Map(),
    channelInput: '',
    channelIsLoading: false,
    channelStreamingContent: '',
    showChannelModal: false,
    showAddAgentModal: false,
    renamingChannelId: null,
    channelSearchQuery: '',
    input: '',
    isLoading: false,
    isCompacting: false,
    switchingChat: false,
    streamingContent: '',
    streamingContentBlocks: [],
    activeToolCalls: [],
    regeneratingMessageId: null,
    showArchived: false,
    showAgentRooms: false,
    showChatModal: false,
    renamingChatId: null,
    searchQuery: '',
    selectedTags: [],
  });
  useToastStore.setState({ toasts: [] });
}

describe('useConversationsStore — showAgentRooms', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConversations();
  });

  it('hides agent-to-agent rooms by default', () => {
    expect(useConversationsStore.getState().showAgentRooms).toBe(false);
  });

  it('setShowAgentRooms persists under the pre-existing key', () => {
    useConversationsStore.getState().setShowAgentRooms(true);
    expect(useConversationsStore.getState().showAgentRooms).toBe(true);
    expect(localStorage.getItem(SHOW_AGENT_ROOMS_KEY)).toBe('true');
  });

  it('toggleShowAgentRooms flips the current value', () => {
    useConversationsStore.getState().toggleShowAgentRooms();
    expect(useConversationsStore.getState().showAgentRooms).toBe(true);
    useConversationsStore.getState().toggleShowAgentRooms();
    expect(useConversationsStore.getState().showAgentRooms).toBe(false);
    expect(localStorage.getItem(SHOW_AGENT_ROOMS_KEY)).toBe('false');
  });

  it('is a pure client-side filter — never reloads over IPC', () => {
    const getChats = vi.fn();
    const getChannels = vi.fn();
    (window.electron as any).getChats = getChats;
    (window.electron as any).getChannels = getChannels;

    useConversationsStore.getState().setShowAgentRooms(true);
    useConversationsStore.getState().toggleShowAgentRooms();

    expect(getChats).not.toHaveBeenCalled();
    expect(getChannels).not.toHaveBeenCalled();
  });

  it('restores the persisted value on load', async () => {
    localStorage.setItem(SHOW_AGENT_ROOMS_KEY, 'true');
    vi.resetModules();
    const { useConversationsStore: freshStore } = await import('./useConversationsStore');
    expect(freshStore.getState().showAgentRooms).toBe(true);
  });
});

describe('useConversationsStore — lists, edit, streaming setters', () => {
  beforeEach(resetConversations);

  it('setters update lists and current pointers', () => {
    const chats = [{ id: 'c1', name: 'A', messages: [] }] as any;
    const channels = [{ id: 'ch1', name: 'Room', participants: [], messages: [] }] as any;
    useConversationsStore.getState().setChats(chats);
    useConversationsStore.getState().setChannels(channels);
    useConversationsStore.getState().setCurrentChatId('c1');
    useConversationsStore.getState().setCurrentChannelId('ch1');
    expect(useConversationsStore.getState().getCurrentChat()?.id).toBe('c1');
    expect(useConversationsStore.getState().getCurrentChannel()?.id).toBe('ch1');
  });

  it('message edit lifecycle and streaming state', () => {
    useConversationsStore.getState().startEditingMessage('m1', 'hi');
    useConversationsStore.getState().setEditingMessageContent('hi!');
    expect(useConversationsStore.getState()).toMatchObject({
      editingMessageId: 'm1',
      editingMessageContent: 'hi!',
    });
    useConversationsStore.getState().cancelEditingMessage();
    expect(useConversationsStore.getState().editingMessageId).toBeNull();

    useConversationsStore.getState().setStreamingContent('partial');
    useConversationsStore.getState().setStreamingContentBlocks([{ type: 'text', content: 'x' } as any]);
    useConversationsStore.getState().setActiveToolCalls([{ toolName: 'bash', status: 'running' } as any]);
    useConversationsStore.getState().setIsLoading(true);
    expect(useConversationsStore.getState().streamingContent).toBe('partial');
    expect(useConversationsStore.getState().activeToolCalls).toHaveLength(1);
  });

  it('initChannelSelectedAgents picks the first agent participant', () => {
    useConversationsStore.getState().initChannelSelectedAgents([
      {
        id: 'ch1',
        participants: [
          { id: 'u1', type: 'human' },
          { id: 'a1', type: 'agent' },
        ],
      },
      { id: 'ch2', participants: [{ id: 'u1', type: 'human' }] },
    ] as any);
    expect(useConversationsStore.getState().channelSelectedAgents.get('ch1')).toBe('a1');
    expect(useConversationsStore.getState().channelSelectedAgents.has('ch2')).toBe(false);
  });
});

describe('useConversationsStore — chat CRUD / list', () => {
  beforeEach(() => {
    resetConversations();
    useAgentStore.setState({ agents: [{ id: 'a1', name: 'Ada' } as any] });
    useSettingsStore.setState({
      settings: { userName: 'U', apiKeys: {}, defaultAgentId: 'a1' } as any,
      settingsHydrated: true,
    });
  });

  it('createChat validates name/agent and prepends on success', async () => {
    await useConversationsStore.getState().createChat('  ', 'a1');
    expect(useToastStore.getState().toasts.some((t) => t.type === 'warning')).toBe(true);

    (window.electron as any).createChat = vi.fn().mockResolvedValue({
      success: true,
      chat: { id: 'c-new', name: 'Hello', messages: [] },
    });
    await useConversationsStore.getState().createChat('Hello', 'a1', 'tag');
    expect(useConversationsStore.getState().chats[0].id).toBe('c-new');
    expect(useConversationsStore.getState().currentChatId).toBe('c-new');
    expect(useConversationsStore.getState().streamingContent).toBe('');
  });

  it('createChat surfaces envelope errors', async () => {
    (window.electron as any).createChat = vi.fn().mockResolvedValue({
      success: false,
      error: 'nope',
    });
    await useConversationsStore.getState().createChat('X', 'a1');
    expect(useToastStore.getState().toasts.some((t) => t.message === 'nope')).toBe(true);
  });

  it('createBlankChat uses default agent', async () => {
    (window.electron as any).createChat = vi.fn().mockResolvedValue({
      success: true,
      chat: { id: 'blank', name: 'New Chat', messages: [] },
    });
    await useConversationsStore.getState().createBlankChat();
    expect((window.electron as any).createChat).toHaveBeenCalledWith({
      name: 'New Chat',
      agentId: 'a1',
    });
    expect(useConversationsStore.getState().currentChatId).toBe('blank');
  });

  it('createBlankChat warns when no agents exist', async () => {
    useAgentStore.setState({ agents: [] });
    await useConversationsStore.getState().createBlankChat();
    expect(useToastStore.getState().toasts.some((t) => t.type === 'warning')).toBe(true);
  });

  it('loadChats keeps message-bearing chats whole; honors showArchived', async () => {
    useConversationsStore.setState({
      showArchived: true,
      chats: [{ id: 'c1', name: 'Old', messages: [{ id: 'm1' }] } as any],
    });
    (window.electron as any).getChats = vi.fn().mockResolvedValue({
      success: true,
      chats: [
        { id: 'c1', name: 'Refreshed', messages: [] },
        { id: 'c2', name: 'New', messages: [] },
      ],
    });
    await useConversationsStore.getState().loadChats();
    expect((window.electron as any).getChats).toHaveBeenCalledWith({ includeArchived: true });
    // Existing row with messages is kept as-is (not replaced by the list projection).
    const c1 = useConversationsStore.getState().chats.find((c) => c.id === 'c1')!;
    expect(c1.name).toBe('Old');
    expect(c1.messages).toHaveLength(1);
    expect(useConversationsStore.getState().chats).toHaveLength(2);
  });

  it('switchChat is a no-op when already current; fetches when messages missing', async () => {
    useConversationsStore.setState({
      currentChatId: 'c1',
      chats: [{ id: 'c1', messages: [{ id: 'm' }] } as any],
    });
    (window.electron as any).switchChat = vi.fn();
    await useConversationsStore.getState().switchChat('c1');
    expect((window.electron as any).switchChat).not.toHaveBeenCalled();

    (window.electron as any).getChat = vi.fn().mockResolvedValue({
      success: true,
      chat: { id: 'c2', messages: [{ id: 'm2', content: 'hi' }] },
    });
    useConversationsStore.setState({
      currentChatId: 'c1',
      chats: [{ id: 'c2', messages: [] } as any],
    });
    await useConversationsStore.getState().switchChat('c2');
    expect(useConversationsStore.getState().currentChatId).toBe('c2');
    expect(useConversationsStore.getState().chats[0].messages).toHaveLength(1);
    expect(useConversationsStore.getState().switchingChat).toBe(false);
  });

  it('archiveChat removes from list when not showing archived; delete clears selection', async () => {
    useConversationsStore.setState({
      chats: [{ id: 'c1', name: 'A' } as any, { id: 'c2', name: 'B' } as any],
      currentChatId: 'c1',
      showArchived: false,
    });
    (window.electron as any).archiveChat = vi.fn().mockResolvedValue({
      success: true,
      chat: { id: 'c1', archivedAt: 123 },
    });
    await useConversationsStore.getState().archiveChat('c1');
    expect(useConversationsStore.getState().chats.map((c) => c.id)).toEqual(['c2']);
    expect(useConversationsStore.getState().currentChatId).toBeNull();

    (window.electron as any).deleteChat = vi.fn().mockResolvedValue({ success: true });
    useConversationsStore.setState({
      chats: [{ id: 'c2' } as any],
      currentChatId: 'c2',
    });
    await useConversationsStore.getState().deleteChat('c2');
    expect(useConversationsStore.getState().chats).toHaveLength(0);
    expect(useConversationsStore.getState().currentChatId).toBeNull();
  });

  it('searchChats / filterByTags / getAllTags', async () => {
    (window.electron as any).searchChats = vi.fn().mockResolvedValue({
      success: true,
      chats: [{ id: 'hit' }],
    });
    await useConversationsStore.getState().searchChats('q');
    expect(useConversationsStore.getState().chats[0].id).toBe('hit');

    (window.electron as any).getChatsByTags = vi.fn().mockResolvedValue({
      success: true,
      chats: [{ id: 'tagged', tags: 'work,ai' }],
    });
    await useConversationsStore.getState().filterByTags(['work']);
    expect(useConversationsStore.getState().getAllTags()).toEqual(expect.arrayContaining(['work', 'ai']));
  });
});

describe('useConversationsStore — channel surface', () => {
  beforeEach(resetConversations);

  it('loadChannels preserves messages on already-open channels', async () => {
    useConversationsStore.setState({
      channels: [{ id: 'ch1', messages: [{ id: 'm1' }], participants: [] } as any],
      showArchived: false,
    });
    (window.electron as any).getChannels = vi.fn().mockResolvedValue({
      success: true,
      channels: [{ id: 'ch1', name: 'Room', participants: [], messages: [] }],
    });
    await useConversationsStore.getState().loadChannels();
    expect(useConversationsStore.getState().channels[0].messages).toHaveLength(1);
  });

  it('switchChannel paints immediately and merges local-only messages', async () => {
    useConversationsStore.setState({
      channels: [
        {
          id: 'ch1',
          participants: [],
          messages: [{ id: 'local-only' }],
        } as any,
      ],
    });
    (window.electron as any).switchChannel = vi.fn().mockResolvedValue({
      success: true,
      channel: {
        id: 'ch1',
        participants: [{ id: 'a1', type: 'agent' }],
        messages: [{ id: 'server-1' }],
      },
    });
    await useConversationsStore.getState().switchChannel('ch1');
    const ch = useConversationsStore.getState().channels[0];
    expect(ch.messages.map((m: any) => m.id).sort()).toEqual(['local-only', 'server-1']);
    expect(useConversationsStore.getState().channelSelectedAgents.get('ch1')).toBe('a1');
  });

  it('archiveChannel / unarchiveChannel update list membership', async () => {
    useConversationsStore.setState({
      channels: [{ id: 'ch1' } as any],
      currentChannelId: 'ch1',
      showArchived: false,
    });
    (window.electron as any).archiveChannel = vi.fn().mockResolvedValue({
      success: true,
      channel: { id: 'ch1', archivedAt: 1 },
    });
    await useConversationsStore.getState().archiveChannel('ch1');
    expect(useConversationsStore.getState().channels).toHaveLength(0);

    (window.electron as any).unarchiveChannel = vi.fn().mockResolvedValue({
      success: true,
      channel: { id: 'ch1' },
    });
    await useConversationsStore.getState().unarchiveChannel('ch1');
    expect(useConversationsStore.getState().channels).toHaveLength(1);
  });

  it('updateChannel merges server row; createChannel rejects empty name', async () => {
    await useConversationsStore.getState().createChannel('  ');
    expect(useToastStore.getState().toasts.some((t) => t.type === 'warning')).toBe(true);

    useConversationsStore.setState({
      channels: [{ id: 'ch1', name: 'Old', messages: [{ id: 'm' }], participants: [] } as any],
    });
    (window.electron as any).updateChannel = vi.fn().mockResolvedValue({
      id: 'ch1',
      name: 'New',
      participants: [{ id: 'a1', type: 'agent' }],
    });
    await useConversationsStore.getState().updateChannel('ch1', { name: 'New' });
    expect(useConversationsStore.getState().channels[0]).toMatchObject({
      name: 'New',
      messages: [{ id: 'm' }],
    });
  });

  it('modals and search helpers', () => {
    useConversationsStore.getState().openChannelModal();
    useConversationsStore.getState().openAddAgentModal();
    useConversationsStore.getState().openChatModal();
    useConversationsStore.getState().setChannelSearchQuery('x');
    useConversationsStore.getState().setSearchQuery('y');
    useConversationsStore.getState().clearChannelSearch();
    useConversationsStore.getState().clearSearch();
    expect(useConversationsStore.getState()).toMatchObject({
      showChannelModal: true,
      showAddAgentModal: true,
      showChatModal: true,
      channelSearchQuery: '',
      searchQuery: '',
    });
  });
});
