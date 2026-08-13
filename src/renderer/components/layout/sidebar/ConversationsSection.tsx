import { useEffect, useMemo } from 'react';
import { Pin } from 'lucide-react';
import { useConversationsStore } from '@/stores';
import { useUIStore } from '@/stores/useUIStore';
import { AppIcon } from '@/components/ui/AppIcon';
import { CollapsibleSection } from './CollapsibleSection';
import { openChannel, openChat } from '@/utils/conversationNav';
import type { Channel, Chat } from '@/types';

type PinnedEntry =
  | { kind: 'channel'; channel: Channel; activity: number }
  | { kind: 'chat'; chat: Chat; activity: number };

/**
 * Sidebar section for conversations: pinned chats and channels only, most
 * recently active first. Browsing everything else (search, tags, folders,
 * archive) lives in the conversations panel — a recent list here would only
 * repeat what that panel already shows.
 */
export function ConversationsSection() {
  const { chats, currentChatId, createBlankChat, loadChats, channels, currentChannelId } = useConversationsStore();
  const view = useUIStore((s) => s.view);
  const { setView } = useUIStore();

  // Load chats on mount
  useEffect(() => {
    loadChats();
  }, [loadChats]);

  const pinned = useMemo<PinnedEntry[]>(() => {
    const channelActivity = (c: Channel) =>
      c.messages && c.messages.length > 0
        ? c.messages[c.messages.length - 1].timestamp
        : c.createdAt;
    const entries: PinnedEntry[] = [
      ...channels
        .filter((c) => c.pinned)
        .map((c) => ({ kind: 'channel' as const, channel: c, activity: channelActivity(c) })),
      ...chats
        .filter((c) => c.pinned)
        .map((c) => ({ kind: 'chat' as const, chat: c, activity: c.lastMessageAt ?? c.createdAt })),
    ];
    return entries.sort((a, b) => b.activity - a.activity);
  }, [channels, chats]);

  const handleViewConversations = () => {
    setView('chats');
  };

  const handleActionClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await createBlankChat();
    setView('chats');
  };

  return (
    <CollapsibleSection
      title="Conversations"
      onTitleClick={handleViewConversations}
      onActionClick={handleActionClick}
      actionTitle="New Chat"
      isExpandedByDefault={true}
    >
      {pinned.length === 0 ? (
        <div className="section-empty">
          No pinned conversations. Pin one from its menu in the conversation list.
        </div>
      ) : (
        <div className="section-list">
          {pinned.map((entry) =>
            entry.kind === 'channel' ? (
              <button
                key={entry.channel.id}
                className={`section-item ${view === 'channels' && currentChannelId === entry.channel.id ? 'active' : ''}`}
                onClick={() => openChannel(entry.channel.id)}
                title={`Pinned channel — ${entry.channel.name}`}
              >
                <Pin size={12} className="item-pin" aria-hidden />
                <AppIcon name="channels" size={16} className="item-icon" />
                <span className="item-label">{entry.channel.name}</span>
                {entry.channel.messages && entry.channel.messages.length > 0 && (
                  <span className="item-count">{entry.channel.messages.length}</span>
                )}
              </button>
            ) : (
              <button
                key={entry.chat.id}
                className={`section-item ${view === 'chats' && currentChatId === entry.chat.id ? 'active' : ''}`}
                onClick={() => openChat(entry.chat.id)}
                title={`Pinned chat — ${entry.chat.name}`}
              >
                <Pin size={12} className="item-pin" aria-hidden />
                <AppIcon name="chat" size={16} className="item-icon" />
                <span className="item-label">{entry.chat.name}</span>
                {entry.chat.messages && entry.chat.messages.length > 0 && (
                  <span className="item-count">{entry.chat.messages.length}</span>
                )}
              </button>
            )
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}
