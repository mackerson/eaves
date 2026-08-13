import { useConversationsStore } from '@/stores';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Navigation helpers shared by every surface that can open a conversation
 * (sidebar section, unified list panel). Chats and channels are one data
 * model but render in different views, so selecting one is always a
 * switch + view change pair.
 */
export async function openChannel(channelId: string) {
  await useConversationsStore.getState().switchChannel(channelId);
  useUIStore.getState().setView('channels');
}

export async function openChat(chatId: string) {
  await useConversationsStore.getState().switchChat(chatId);
  useUIStore.getState().setView('chats');
}
