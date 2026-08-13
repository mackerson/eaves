import { create } from 'zustand';
import type { ConversationFolder } from '@/types';
import { useConversationsStore } from './useConversationsStore';
import { useToastStore } from './useToastStore';

/**
 * Flat conversation folders + the pin/folder mutations shared by chats and
 * channels (one channels table underneath). Mutations patch the conversations
 * store in place so the panel and sidebar update without a reload.
 */
interface ConversationFoldersState {
  folders: ConversationFolder[];
  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<ConversationFolder | null>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  /** Deletes the folder; member conversations become ungrouped. */
  deleteFolder: (folderId: string) => Promise<void>;
  setConversationPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  setConversationFolder: (conversationId: string, folderId: string | null) => Promise<void>;
}

function patchConversation(conversationId: string, patch: { pinned?: boolean; folderId?: string | null }) {
  // A conversation lives in exactly one of the two list projections; patching
  // both is a cheap no-op for the one that doesn't hold it.
  const applied = { ...patch, folderId: patch.folderId === null ? undefined : patch.folderId };
  useConversationsStore.setState((state) => ({
    chats: state.chats.map((c) => (c.id === conversationId ? { ...c, ...applied } : c)),
    channels: state.channels.map((c) => (c.id === conversationId ? { ...c, ...applied } : c)),
  }));
}

export const useConversationFoldersStore = create<ConversationFoldersState>((set, get) => ({
  folders: [],

  loadFolders: async () => {
    try {
      const result = await window.electron.listConversationFolders();
      if (result.success && result.folders) {
        set({ folders: result.folders });
      }
    } catch (error) {
      console.error('Failed to load conversation folders:', error);
    }
  },

  createFolder: async (name) => {
    try {
      const result = await window.electron.createConversationFolder(name);
      if (!result.success || !result.folder) {
        useToastStore.getState().showToast(result.error || 'Failed to create folder', 'error');
        return null;
      }
      set({ folders: [...get().folders, result.folder] });
      return result.folder;
    } catch (error) {
      console.error('Failed to create folder:', error);
      useToastStore.getState().showToast('Failed to create folder', 'error');
      return null;
    }
  },

  renameFolder: async (folderId, name) => {
    try {
      const result = await window.electron.renameConversationFolder(folderId, name);
      if (!result.success) {
        useToastStore.getState().showToast(result.error || 'Failed to rename folder', 'error');
        return;
      }
      set({
        folders: get().folders.map((f) => (f.id === folderId ? { ...f, name } : f)),
      });
    } catch (error) {
      console.error('Failed to rename folder:', error);
      useToastStore.getState().showToast('Failed to rename folder', 'error');
    }
  },

  deleteFolder: async (folderId) => {
    try {
      const result = await window.electron.deleteConversationFolder(folderId);
      if (!result.success) {
        useToastStore.getState().showToast(result.error || 'Failed to delete folder', 'error');
        return;
      }
      set({ folders: get().folders.filter((f) => f.id !== folderId) });
      // Ungroup members locally to mirror the repository's folder_id reset.
      useConversationsStore.setState((state) => ({
        chats: state.chats.map((c) => (c.folderId === folderId ? { ...c, folderId: undefined } : c)),
        channels: state.channels.map((c) => (c.folderId === folderId ? { ...c, folderId: undefined } : c)),
      }));
    } catch (error) {
      console.error('Failed to delete folder:', error);
      useToastStore.getState().showToast('Failed to delete folder', 'error');
    }
  },

  setConversationPinned: async (conversationId, pinned) => {
    try {
      const result = await window.electron.setConversationPinned(conversationId, pinned);
      if (!result.success) {
        useToastStore.getState().showToast(result.error || 'Failed to update pin', 'error');
        return;
      }
      patchConversation(conversationId, { pinned });
    } catch (error) {
      console.error('Failed to update pin:', error);
      useToastStore.getState().showToast('Failed to update pin', 'error');
    }
  },

  setConversationFolder: async (conversationId, folderId) => {
    try {
      const result = await window.electron.setConversationFolder(conversationId, folderId);
      if (!result.success) {
        useToastStore.getState().showToast(result.error || 'Failed to move conversation', 'error');
        return;
      }
      patchConversation(conversationId, { folderId });
    } catch (error) {
      console.error('Failed to move conversation:', error);
      useToastStore.getState().showToast('Failed to move conversation', 'error');
    }
  },
}));
