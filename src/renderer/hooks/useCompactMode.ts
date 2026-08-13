import { useConversationsStore, useUIPreferencesStore, useUIStore } from '@/stores';

/**
 * Whether compact ("companion") mode is actually in effect right now.
 *
 * The stored flag is the user's standing intent; this is the rendering. They
 * differ deliberately in two cases, both of which would otherwise strand the
 * user in a window with no navigation:
 *
 *  - Not on a message surface. Compact hides the sidebar and the menu bar, so
 *    a compact Settings or Agents view would be a dead end.
 *  - No conversation selected. There is nothing to focus on, and the
 *    conversation list — the only way to pick one — is hidden in compact.
 *
 * Either way the flag survives, so returning to a conversation re-engages it.
 */
export function useCompactMode(): boolean {
  const compactMode = useUIPreferencesStore((s) => s.compactMode);
  const view = useUIStore((s) => s.view);
  const currentChatId = useConversationsStore((s) => s.currentChatId);
  const currentChannelId = useConversationsStore((s) => s.currentChannelId);

  if (!compactMode) return false;
  if (view === 'chats') return Boolean(currentChatId);
  if (view === 'channels') return Boolean(currentChannelId);
  return false;
}
