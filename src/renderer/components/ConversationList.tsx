import { useState, useMemo, memo, useCallback, useEffect } from 'react';
import { useConversationsStore } from '@/stores';
import { useUIStore } from '@/stores/useUIStore';
import { useAgentStore } from '@/stores/useAgentStore';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Archive, Search, X, MoreVertical, Pencil, Trash2, ArchiveRestore,
  Filter, ChevronDown, ChevronLeft, ChevronRight, Folder, FolderInput, FolderPlus,
  Check, Copy, Download, Hash, Pin, PinOff, Bot,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { useConversationFoldersStore } from '@/stores/useConversationFoldersStore';
import type { ConversationFolder } from '@/types';
import { ConfirmDialog } from '@/components/modals/ConfirmDialog';
import { openChannel, openChat } from '@/utils/conversationNav';
import type { Channel } from '@/types';

type ConversationFilter = 'all' | 'channels' | 'chats';

/** "Move to folder" submenu shared by chat and channel row menus. */
function FolderSubmenu({ conversationId, currentFolderId, folders, onSetFolder, onNewFolder }: {
  conversationId: string;
  currentFolderId?: string;
  folders: ConversationFolder[];
  onSetFolder: (conversationId: string, folderId: string | null) => void;
  onNewFolder: (conversationId: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput className="h-4 w-4" />
        Move to folder
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {folders.map((folder) => (
          <DropdownMenuItem
            key={folder.id}
            onClick={() => onSetFolder(conversationId, folder.id === currentFolderId ? null : folder.id)}
          >
            {folder.id === currentFolderId
              ? <Check className="h-4 w-4" />
              : <Folder className="h-4 w-4" />}
            {folder.name}
          </DropdownMenuItem>
        ))}
        {folders.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => onNewFolder(conversationId)}>
          <FolderPlus className="h-4 w-4" />
          New folder…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

interface ChatItemProps {
  chat: any;
  isActive: boolean;
  isRenaming: boolean;
  agent: any;
  onSwitch: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onStartRename: (id: string) => void;
  onCancelRename: () => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  folders: ConversationFolder[];
  onSetFolder: (id: string, folderId: string | null) => void;
  onNewFolder: (id: string) => void;
}

const ChatItem = memo(function ChatItem({
  chat, isActive, isRenaming, agent,
  onSwitch, onRename, onStartRename, onCancelRename,
  onDuplicate, onExport, onArchive, onUnarchive, onDelete,
  onTogglePin, folders, onSetFolder, onNewFolder,
}: ChatItemProps) {
  const isArchived = !!chat.archivedAt;

  return (
    <div
      onClick={() => !isRenaming && onSwitch(chat.id)}
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors group',
        isActive ? 'app-bg-secondary text-secondary-foreground' : 'hover:bg-secondary/50',
        isArchived && 'opacity-60'
      )}
    >
      {isRenaming ? (
        <Input
          autoFocus
          defaultValue={chat.name}
          className="h-7 px-2 text-sm"
          onBlur={(e) => onRename(chat.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRename(chat.id, e.currentTarget.value);
            } else if (e.key === 'Escape') {
              onCancelRename();
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {agent && (
                agent.avatar ? (
                  <img
                    src={`avatar://${agent.avatar}`}
                    alt={agent.name}
                    className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                    title={agent.name}
                  />
                ) : (
                  <div
                    className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-white text-[10px] font-bold"
                    style={{ backgroundColor: agent.color }}
                    title={agent.name}
                  >
                    {agent.name[0]?.toUpperCase() || '?'}
                  </div>
                )
              )}
              {/* Long names truncate to the same visible prefix — two chats can
                  render identically, so the full name has to stay reachable. */}
              <span className="text-sm truncate" title={chat.name}>{chat.name}</span>
              {chat.pinned && (
                <Pin className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
              )}
            </div>
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onStartRename(chat.id)}>
                  <Pencil className="h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicate(chat.id)}>
                  <Copy className="h-4 w-4" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport(chat.id)}>
                  <Download className="h-4 w-4" />
                  Download
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onTogglePin(chat.id, !chat.pinned)}>
                  {chat.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                  {chat.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                </DropdownMenuItem>
                <FolderSubmenu
                  conversationId={chat.id}
                  currentFolderId={chat.folderId}
                  folders={folders}
                  onSetFolder={onSetFolder}
                  onNewFolder={onNewFolder}
                />
                <DropdownMenuItem onClick={() => (isArchived ? onUnarchive(chat.id) : onArchive(chat.id))}>
                  {isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                  {isArchived ? 'Unarchive' : 'Archive'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onDelete(chat.id)}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
    </div>
  );
});

interface ChannelItemProps {
  channel: Channel;
  isActive: boolean;
  isRenaming: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onStartRename: (id: string) => void;
  onCancelRename: () => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  folders: ConversationFolder[];
  onSetFolder: (id: string, folderId: string | null) => void;
  onNewFolder: (id: string) => void;
}

const ChannelItem = memo(function ChannelItem({
  channel, isActive, isRenaming,
  onSelect, onRename, onStartRename, onCancelRename, onTogglePin,
  onArchive, onUnarchive, onDelete,
  folders, onSetFolder, onNewFolder,
}: ChannelItemProps) {
  // #general is the built-in home channel — pinnable but not renamable/
  // archivable/deletable (archiving it would hide the home channel).
  const isProtected = channel.name === 'general';
  const isArchived = !!channel.archivedAt;
  const agentOnly = isAgentOnlyRoom(channel);
  // Identifiable at a glance once the toggle mixes them back in.
  const TypeIcon = agentOnly ? Bot : channel.type === 'project' ? Folder : Hash;

  return (
    <div
      onClick={() => !isRenaming && onSelect(channel.id)}
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors group',
        isActive ? 'app-bg-secondary text-secondary-foreground' : 'hover:bg-secondary/50',
        isArchived && 'opacity-60'
      )}
    >
      {isRenaming ? (
        <Input
          autoFocus
          defaultValue={channel.name}
          className="h-7 px-2 text-sm"
          onBlur={(e) => onRename(channel.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRename(channel.id, e.currentTarget.value);
            } else if (e.key === 'Escape') {
              onCancelRename();
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <TypeIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span className="text-sm truncate" title={channel.name}>{channel.name}</span>
            {channel.pinned && (
              <Pin className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            )}
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!isProtected && (
                  <DropdownMenuItem onClick={() => onStartRename(channel.id)}>
                    <Pencil className="h-4 w-4" />
                    Rename
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onTogglePin(channel.id, !channel.pinned)}>
                  {channel.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                  {channel.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                </DropdownMenuItem>
                <FolderSubmenu
                  conversationId={channel.id}
                  currentFolderId={channel.folderId}
                  folders={folders}
                  onSetFolder={onSetFolder}
                  onNewFolder={onNewFolder}
                />
                {!isProtected && (
                  <DropdownMenuItem onClick={() => (isArchived ? onUnarchive(channel.id) : onArchive(channel.id))}>
                    {isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                    {isArchived ? 'Unarchive' : 'Archive'}
                  </DropdownMenuItem>
                )}
                {!isProtected && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDelete(channel.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
    </div>
  );
});

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
      {children}
    </div>
  );
}

interface ConversationListProps {
  onCollapse?: () => void;
}

/**
 * A room with no human in it — agents talking to each other.
 *
 * Derived from participants rather than a flag someone has to set: these
 * appear when an agent creates a channel via `channel_create`, so there is
 * nobody to do the tagging. Users were surprised to find them mixed into the
 * conversation list, so they are hidden by default and shown on request.
 */
function isAgentOnlyRoom(channel: Channel): boolean {
  const participants = channel.participants ?? [];
  return participants.length > 0 && participants.every((p) => p.type === 'agent');
}

export const ConversationList: React.FC<ConversationListProps> = ({ onCollapse }) => {
  // Granular selectors — avoid re-rendering on streaming/input changes
  const chats = useConversationsStore((s) => s.chats);
  const currentChatId = useConversationsStore((s) => s.currentChatId);
  const showArchived = useConversationsStore((s) => s.showArchived);
  const selectedTags = useConversationsStore((s) => s.selectedTags);
  const renamingChatId = useConversationsStore((s) => s.renamingChatId);

  const channels = useConversationsStore((s) => s.channels);
  const currentChannelId = useConversationsStore((s) => s.currentChannelId);
  const renamingChannelId = useConversationsStore((s) => s.renamingChannelId);
  const showAgentRooms = useConversationsStore((s) => s.showAgentRooms);

  const view = useUIStore((s) => s.view);

  // Actions are stable — grab once
  const {
    switchChat, createBlankChat, deleteChat, duplicateChat,
    exportChatAsMarkdown, archiveChat, unarchiveChat, updateChat,
    setShowArchived, setShowAgentRooms, searchChats, filterByTags, loadChats,
    clearSearch, getAllTags, setRenamingChatId,
    updateChannel, deleteChannel, setRenamingChannelId, openChannelModal,
    loadChannels, filterChannelsByTags, archiveChannel, unarchiveChannel,
  } = useConversationsStore.getState();
  const { setView } = useUIStore.getState();

  const { agents } = useAgentStore();
  const folders = useConversationFoldersStore((st) => st.folders);
  const {
    loadFolders, createFolder, renameFolder, deleteFolder,
    setConversationPinned, setConversationFolder,
  } = useConversationFoldersStore.getState();
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  // Folder UI state: collapse map persists across sessions; the new-folder
  // dialog remembers which conversation triggered it so the new folder can
  // adopt it on create.
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('conversation-folders-collapsed') || '{}'); }
    catch { return {}; }
  });
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [newFolderFor, setNewFolderFor] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [displayCount, setDisplayCount] = useState(50);
  const [showAllTags, setShowAllTags] = useState(false);
  const [filter, setFilter] = useState<ConversationFilter>(() => {
    const stored = localStorage.getItem('conversation-filter');
    return stored === 'channels' || stored === 'chats' ? stored : 'all';
  });
  // Two-step delete: clicking the menu item only sets pending state. The
  // ConfirmDialog (a Radix Dialog) handles the actual confirm with proper
  // focus management, instead of native confirm() which runs synchronously
  // inside the dropdown's close lifecycle and leaves focus trapped.
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'chat' | 'channel' | 'folder'; id: string } | null>(null);
  const handleRequestChatDelete = useCallback((id: string) => setPendingDelete({ kind: 'chat', id }), []);
  const handleRequestChannelDelete = useCallback((id: string) => setPendingDelete({ kind: 'channel', id }), []);
  const handleConfirmDelete = useCallback(() => {
    if (pendingDelete?.kind === 'chat') deleteChat(pendingDelete.id);
    if (pendingDelete?.kind === 'channel') deleteChannel(pendingDelete.id);
    if (pendingDelete?.kind === 'folder') deleteFolder(pendingDelete.id);
    setPendingDelete(null);
  }, [pendingDelete, deleteChat, deleteChannel]);

  useEffect(() => {
    loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showChannels = filter !== 'chats';
  const showChats = filter !== 'channels';

  const changeFilter = (next: ConversationFilter) => {
    setFilter(next);
    localStorage.setItem('conversation-filter', next);
  };

  // Channels are filtered client-side (small set); chats go through the
  // store's IPC-backed search below.
  const visibleChannels = useMemo(() => {
    const query = localSearchQuery.trim().toLowerCase();
    const byToggle = showAgentRooms ? channels : channels.filter((c) => !isAgentOnlyRoom(c));
    const matches = query
      ? byToggle.filter((c) => c.name.toLowerCase().includes(query))
      : byToggle;
    const lastActivity = (c: Channel) =>
      c.messages && c.messages.length > 0
        ? c.messages[c.messages.length - 1].timestamp
        : c.createdAt;
    return [...matches].sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || lastActivity(b) - lastActivity(a)
    );
  }, [channels, localSearchQuery, showAgentRooms]);

  const visibleChats = chats.slice(0, displayCount);
  const hasMore = chats.length > displayCount;

  // Folder grouping over the already-filtered lists: a folder shows the
  // members that survive the current search/type filters; ungrouped items
  // fall through to the CHANNELS/CHATS sections below.
  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const groupedChannels = useMemo(() => {
    const inFolder = new Map<string, Channel[]>();
    const ungrouped: Channel[] = [];
    for (const c of visibleChannels) {
      if (c.folderId && folderIds.has(c.folderId)) {
        const list = inFolder.get(c.folderId) ?? [];
        list.push(c);
        inFolder.set(c.folderId, list);
      } else {
        ungrouped.push(c);
      }
    }
    return { inFolder, ungrouped };
  }, [visibleChannels, folderIds]);
  const groupedChats = useMemo(() => {
    const inFolder = new Map<string, typeof visibleChats>();
    const ungrouped: typeof visibleChats = [];
    for (const c of visibleChats) {
      if (c.folderId && folderIds.has(c.folderId)) {
        const list = inFolder.get(c.folderId) ?? [];
        list.push(c);
        inFolder.set(c.folderId, list);
      } else {
        ungrouped.push(c);
      }
    }
    return { inFolder, ungrouped };
  }, [visibleChats, folderIds]);

  const availableTags = getAllTags();

  // Categorize tags for better display
  const categorizedTags = availableTags.reduce(
    (acc, tag) => {
      if (tag.startsWith('folder:')) {
        acc.folders.push(tag);
      } else if (tag.startsWith('project:')) {
        acc.projects.push(tag);
      } else if (tag.startsWith('gpt:')) {
        acc.gpts.push(tag);
      } else {
        acc.other.push(tag);
      }
      return acc;
    },
    { folders: [] as string[], projects: [] as string[], gpts: [] as string[], other: [] as string[] }
  );

  const getTagDisplayName = (tag: string) => {
    if (tag.startsWith('folder:')) return tag.replace('folder:', '');
    if (tag.startsWith('project:')) return tag.replace('project:', '').slice(-8) + '...';
    if (tag.startsWith('gpt:')) return 'GPT';
    return tag;
  };

  const getTagIcon = (tag: string) => {
    if (tag.startsWith('folder:')) return <Folder className="h-3 w-3 mr-1" />;
    return null;
  };

  const clearAllFilters = () => {
    setLocalSearchQuery('');
    clearSearch();
    loadChats();
    loadChannels();
  };

  const hasActiveFilters = selectedTags.length > 0 || localSearchQuery.trim().length > 0;

  const handleSearch = (query: string) => {
    setLocalSearchQuery(query);
    if (query.trim()) {
      searchChats(query);
    } else {
      loadChats();
    }
  };

  // One tag filter across both surfaces, but two calls: chats go through the
  // chat IPC projection, channels through get-channels-by-tags.
  const handleTagClick = (tag: string) => {
    const newTags = selectedTags.includes(tag)
      ? selectedTags.filter((t) => t !== tag)
      : [...selectedTags, tag];

    if (newTags.length > 0) {
      filterByTags(newTags);
      filterChannelsByTags(newTags);
    } else {
      useConversationsStore.getState().setSelectedTags([]);
      loadChats();
      loadChannels();
    }
  };

  const handleToggleArchived = () => {
    setShowArchived(!showArchived);
    loadChats();
    loadChannels();
  };

  const handleChatRename = useCallback((chatId: string, newName: string) => {
    setRenamingChatId(null);
    if (newName.trim()) {
      updateChat(chatId, { name: newName });
    }
  }, []);

  const handleCancelChatRename = useCallback(() => setRenamingChatId(null), []);
  const handleStartChatRename = useCallback((id: string) => setRenamingChatId(id), []);

  const handleChannelRename = useCallback((channelId: string, newName: string) => {
    setRenamingChannelId(null);
    if (newName.trim()) {
      updateChannel(channelId, { name: newName.trim() });
    }
  }, []);

  const handleCancelChannelRename = useCallback(() => setRenamingChannelId(null), []);
  const handleStartChannelRename = useCallback((id: string) => setRenamingChannelId(id), []);

  const handleTogglePin = useCallback((conversationId: string, pinned: boolean) => {
    setConversationPinned(conversationId, pinned);
  }, []);

  const handleSetFolder = useCallback((conversationId: string, folderId: string | null) => {
    setConversationFolder(conversationId, folderId);
  }, []);

  const handleNewFolderFor = useCallback((conversationId: string) => {
    setNewFolderName('');
    setNewFolderFor(conversationId);
  }, []);

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    const target = newFolderFor;
    setNewFolderFor(null);
    if (!name) return;
    const folder = await createFolder(name);
    if (folder && target) {
      await setConversationFolder(target, folder.id);
    }
  }, [newFolderName, newFolderFor]);

  const toggleFolderCollapsed = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = { ...prev, [folderId]: !prev[folderId] };
      localStorage.setItem('conversation-folders-collapsed', JSON.stringify(next));
      return next;
    });
  }, []);

  const handleFolderRename = useCallback((folderId: string, name: string) => {
    setRenamingFolderId(null);
    if (name.trim()) renameFolder(folderId, name.trim());
  }, []);

  const handleNewChat = async () => {
    await createBlankChat();
    setView('chats');
  };

  const noResults =
    (!showChannels || visibleChannels.length === 0) &&
    (!showChats || chats.length === 0) &&
    (folders.length === 0 || hasActiveFilters);

  const searchPlaceholder =
    filter === 'channels' ? 'Search channels...'
      : filter === 'chats' ? 'Search chats...'
        : 'Search conversations...';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}>
                + New <ChevronDown className="ml-1 h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={handleNewChat}>
                <span className="font-medium">New Chat</span>
                <span className="ml-2 text-xs text-muted-foreground">(default agent)</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openChannelModal}>
                <Hash className="h-4 w-4" />
                <span className="font-medium">New Channel</span>
              </DropdownMenuItem>
              {agents.length > 0 && <DropdownMenuSeparator />}
              {agents.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  onClick={async () => {
                    try {
                      const result = await window.electron.createChat({
                        name: 'New Chat',
                        agentId: agent.id,
                      });
                      if (result.success && result.chat) {
                        await loadChats();
                        await switchChat(result.chat.id);
                        setView('chats');
                      }
                    } catch (error) {
                      console.error('Error creating chat:', error);
                    }
                  }}
                >
                  <div className="flex items-center gap-2">
                    {agent.avatar ? (
                      <img
                        src={`avatar://${agent.avatar}`}
                        alt={agent.name}
                        className="w-4 h-4 rounded-full object-cover"
                      />
                    ) : (
                      <div
                        className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-bold"
                        style={{ backgroundColor: agent.color }}
                      >
                        {agent.name[0]?.toUpperCase()}
                      </div>
                    )}
                    <span>{agent.name}</span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {onCollapse && (
            <button
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
              onClick={onCollapse}
              title="Collapse sidebar"
            >
              <ChevronLeft size={14} />
            </button>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={searchPlaceholder}
            value={localSearchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-8 pr-8 h-8 text-sm"
          />
          {localSearchQuery && (
            <button
              onClick={() => {
                setLocalSearchQuery('');
                clearSearch();
              }}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Type filter */}
        <div className="mt-2 flex gap-0.5 rounded-md bg-secondary/50 p-0.5">
          {(['all', 'channels', 'chats'] as const).map((f) => (
            <button
              key={f}
              onClick={() => changeFilter(f)}
              className={cn(
                'flex-1 text-xs px-2 py-1 rounded capitalize transition-colors',
                filter === f
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Active Filters Banner */}
        {hasActiveFilters && (
          <div className="mt-2 flex items-center justify-between bg-primary/10 rounded-md px-2 py-1">
            <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
              <Filter className="h-3 w-3 app-text-primary flex-shrink-0" />
              <span className="text-xs app-text-primary">Filtered:</span>
              {selectedTags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs app-bg-primary text-primary-foreground px-1.5 py-0.5 rounded flex items-center gap-1"
                >
                  {getTagIcon(tag)}
                  {getTagDisplayName(tag)}
                  <button
                    onClick={() => handleTagClick(tag)}
                    className="hover:bg-primary-foreground/20 rounded"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <button
              onClick={clearAllFilters}
              className="text-xs app-text-primary hover:text-primary/80 flex-shrink-0 ml-2"
              title="Clear all filters"
            >
              Clear
            </button>
          </div>
        )}

        {/* Tags and archive span both surfaces (channels first-class since
            Phase 3 Round 3) */}
        {(showChats || showChannels) && (
          <>
            {/* Folder Tags (shown prominently) */}
            {categorizedTags.folders.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Folder className="h-3 w-3" />
                  Folders
                </div>
                <div className="flex flex-wrap gap-1">
                  {categorizedTags.folders.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => handleTagClick(tag)}
                      className={cn(
                        'text-xs px-2 py-0.5 rounded-md transition-colors flex items-center',
                        selectedTags.includes(tag)
                          ? 'app-bg-primary text-primary-foreground'
                          : 'bg-accent hover:bg-accent/80'
                      )}
                    >
                      {getTagDisplayName(tag)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Other Tags (collapsible if many) */}
            {categorizedTags.other.length > 0 && (
              <div className="mt-2">
                <div className="flex flex-wrap gap-1">
                  {(showAllTags ? categorizedTags.other : categorizedTags.other.slice(0, 3)).map((tag) => (
                    <button
                      key={tag}
                      onClick={() => handleTagClick(tag)}
                      className={cn(
                        'text-xs px-2 py-0.5 rounded-md transition-colors',
                        selectedTags.includes(tag)
                          ? 'app-bg-primary text-primary-foreground'
                          : 'bg-accent hover:bg-accent/80'
                      )}
                    >
                      {getTagDisplayName(tag)}
                    </button>
                  ))}
                  {categorizedTags.other.length > 3 && (
                    <button
                      onClick={() => setShowAllTags(!showAllTags)}
                      className="text-xs px-2 py-0.5 text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                    >
                      {showAllTags ? 'Less' : `+${categorizedTags.other.length - 3} more`}
                      <ChevronDown className={cn('h-3 w-3 transition-transform', showAllTags && 'rotate-180')} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Show archived toggle */}
            <div className="mt-2 space-y-1">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox
                  checked={showArchived}
                  onCheckedChange={handleToggleArchived}
                />
                <span className="text-muted-foreground">Show archived</span>
              </label>
              {/* Agent-to-agent rooms are hidden by default: they are created by
                  agents, not by the user, and turning up unannounced in the
                  conversation list is what surprised people. */}
              <label className="flex items-center gap-2 text-xs cursor-pointer" data-testid="show-agent-rooms">
                <Checkbox
                  checked={showAgentRooms}
                  onCheckedChange={(checked) => setShowAgentRooms(checked === true)}
                />
                <span className="text-muted-foreground">Show agent-to-agent</span>
              </label>
            </div>
          </>
        )}
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {noResults ? (
          <div className="text-center text-sm text-muted-foreground mt-8">
            {hasActiveFilters ? 'No conversations found' : 'No conversations yet'}
          </div>
        ) : (
          <>
            {folders.map((folder) => {
              const folderChannels = showChannels ? (groupedChannels.inFolder.get(folder.id) ?? []) : [];
              const folderChats = showChats ? (groupedChats.inFolder.get(folder.id) ?? []) : [];
              const memberCount = folderChannels.length + folderChats.length;
              // Hide empty folders while searching/filtering; show them
              // otherwise so a fresh folder is visible and targetable.
              if (memberCount === 0 && hasActiveFilters) return null;
              const collapsed = !!collapsedFolders[folder.id];
              return (
                <div key={folder.id}>
                  <div className="flex items-center gap-1 px-1 pt-2 pb-1 group/folder">
                    {renamingFolderId === folder.id ? (
                      <Input
                        autoFocus
                        defaultValue={folder.name}
                        className="h-6 px-2 text-xs"
                        onBlur={(e) => handleFolderRename(folder.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleFolderRename(folder.id, e.currentTarget.value);
                          else if (e.key === 'Escape') setRenamingFolderId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <button
                          onClick={() => toggleFolderCollapsed(folder.id)}
                          className="flex items-center gap-1.5 flex-1 min-w-0 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
                        >
                          {collapsed
                            ? <ChevronRight className="h-3 w-3 flex-shrink-0" />
                            : <ChevronDown className="h-3 w-3 flex-shrink-0" />}
                          <Folder className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{folder.name}</span>
                          <span className="font-normal">({memberCount})</span>
                        </button>
                        <div className="opacity-0 group-hover/folder:opacity-100 transition-opacity">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-5 w-5">
                                <MoreVertical className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setRenamingFolderId(folder.id)}>
                                <Pencil className="h-4 w-4" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setPendingDelete({ kind: 'folder', id: folder.id })}
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete folder
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </>
                    )}
                  </div>
                  {!collapsed && (
                    <div className="ml-2 space-y-1">
                      {folderChannels.map((channel) => (
                        <ChannelItem
                          key={channel.id}
                          channel={channel}
                          isActive={view === 'channels' && channel.id === currentChannelId}
                          isRenaming={renamingChannelId === channel.id}
                          onSelect={openChannel}
                          onRename={handleChannelRename}
                          onStartRename={handleStartChannelRename}
                          onCancelRename={handleCancelChannelRename}
                          onTogglePin={handleTogglePin}
                          onArchive={archiveChannel}
                          onUnarchive={unarchiveChannel}
                          onDelete={handleRequestChannelDelete}
                          folders={folders}
                          onSetFolder={handleSetFolder}
                          onNewFolder={handleNewFolderFor}
                        />
                      ))}
                      {folderChats.map((chat) => (
                        <ChatItem
                          key={chat.id}
                          chat={chat}
                          isActive={view === 'chats' && chat.id === currentChatId}
                          isRenaming={renamingChatId === chat.id}
                          agent={agents.find((a) => a.id === chat.agentId)}
                          onSwitch={openChat}
                          onRename={handleChatRename}
                          onStartRename={handleStartChatRename}
                          onCancelRename={handleCancelChatRename}
                          onDuplicate={duplicateChat}
                          onExport={exportChatAsMarkdown}
                          onArchive={archiveChat}
                          onUnarchive={unarchiveChat}
                          onDelete={handleRequestChatDelete}
                          onTogglePin={handleTogglePin}
                          folders={folders}
                          onSetFolder={handleSetFolder}
                          onNewFolder={handleNewFolderFor}
                        />
                      ))}
                      {memberCount === 0 && (
                        <div className="px-3 py-1 text-xs text-muted-foreground italic">
                          Empty — use a conversation's menu to move it here.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {showChannels && groupedChannels.ungrouped.length > 0 && (
              <>
                {filter === 'all' && <GroupLabel>Channels</GroupLabel>}
                {groupedChannels.ungrouped.map((channel) => (
                  <ChannelItem
                    key={channel.id}
                    channel={channel}
                    isActive={view === 'channels' && channel.id === currentChannelId}
                    isRenaming={renamingChannelId === channel.id}
                    onSelect={openChannel}
                    onRename={handleChannelRename}
                    onStartRename={handleStartChannelRename}
                    onCancelRename={handleCancelChannelRename}
                    onTogglePin={handleTogglePin}
                    onArchive={archiveChannel}
                    onUnarchive={unarchiveChannel}
                    onDelete={handleRequestChannelDelete}
                    folders={folders}
                    onSetFolder={handleSetFolder}
                    onNewFolder={handleNewFolderFor}
                  />
                ))}
              </>
            )}
            {showChats && groupedChats.ungrouped.length > 0 && (
              <>
                {filter === 'all' && groupedChannels.ungrouped.length > 0 && <GroupLabel>Chats</GroupLabel>}
                {groupedChats.ungrouped.map((chat) => (
                  <ChatItem
                    key={chat.id}
                    chat={chat}
                    isActive={view === 'chats' && chat.id === currentChatId}
                    isRenaming={renamingChatId === chat.id}
                    agent={agents.find((a) => a.id === chat.agentId)}
                    onSwitch={openChat}
                    onRename={handleChatRename}
                    onStartRename={handleStartChatRename}
                    onCancelRename={handleCancelChatRename}
                    onDuplicate={duplicateChat}
                    onExport={exportChatAsMarkdown}
                    onArchive={archiveChat}
                    onUnarchive={unarchiveChat}
                    onDelete={handleRequestChatDelete}
                    onTogglePin={handleTogglePin}
                    folders={folders}
                    onSetFolder={handleSetFolder}
                    onNewFolder={handleNewFolderFor}
                  />
                ))}
                {hasMore && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full mt-2"
                    onClick={() => setDisplayCount(prev => prev + 50)}
                  >
                    Load more ({chats.length - displayCount} remaining)
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title={
          pendingDelete?.kind === 'folder' ? 'Delete folder?'
            : pendingDelete?.kind === 'channel' ? 'Delete channel?'
              : 'Delete chat?'
        }
        message={
          pendingDelete?.kind === 'folder'
            ? 'The conversations inside will not be deleted — they return to the main list.'
            : pendingDelete?.kind === 'channel'
              ? 'This cannot be undone. All messages in this channel will be permanently removed.'
              : 'This cannot be undone. All messages in this chat will be permanently removed.'
        }
        onConfirm={handleConfirmDelete}
      />

      <Dialog open={newFolderFor !== null} onOpenChange={(open) => { if (!open) setNewFolderFor(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderFor(null)}>Cancel</Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
