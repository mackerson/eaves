import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConversationFoldersStore } from './useConversationFoldersStore';
import { useConversationsStore } from './useConversationsStore';
import { useToastStore } from './useToastStore';

describe('useConversationFoldersStore', () => {
  beforeEach(() => {
    useConversationFoldersStore.setState({ folders: [] });
    useConversationsStore.setState({
      chats: [
        { id: 'c1', folderId: 'f1', pinned: false } as any,
        { id: 'c2', folderId: undefined, pinned: false } as any,
      ],
      channels: [{ id: 'ch1', folderId: 'f1' } as any],
    });
    useToastStore.setState({ toasts: [] });
  });

  it('loadFolders populates from IPC', async () => {
    (window.electron as any).listConversationFolders = vi.fn().mockResolvedValue({
      success: true,
      folders: [{ id: 'f1', name: 'Work' }],
    });
    await useConversationFoldersStore.getState().loadFolders();
    expect(useConversationFoldersStore.getState().folders).toEqual([{ id: 'f1', name: 'Work' }]);
  });

  it('createFolder appends on success and toasts on failure', async () => {
    (window.electron as any).createConversationFolder = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'bad name' })
      .mockResolvedValueOnce({ success: true, folder: { id: 'f2', name: 'Side' } });

    expect(await useConversationFoldersStore.getState().createFolder('')).toBeNull();
    expect(useToastStore.getState().toasts.some((t) => t.message === 'bad name')).toBe(true);

    const folder = await useConversationFoldersStore.getState().createFolder('Side');
    expect(folder?.id).toBe('f2');
    expect(useConversationFoldersStore.getState().folders).toHaveLength(1);
  });

  it('renameFolder updates local name', async () => {
    useConversationFoldersStore.setState({ folders: [{ id: 'f1', name: 'Old' } as any] });
    (window.electron as any).renameConversationFolder = vi.fn().mockResolvedValue({ success: true });
    await useConversationFoldersStore.getState().renameFolder('f1', 'New');
    expect(useConversationFoldersStore.getState().folders[0].name).toBe('New');
  });

  it('deleteFolder removes folder and ungroups members in conversations store', async () => {
    useConversationFoldersStore.setState({ folders: [{ id: 'f1', name: 'Work' } as any] });
    (window.electron as any).deleteConversationFolder = vi.fn().mockResolvedValue({ success: true });
    await useConversationFoldersStore.getState().deleteFolder('f1');
    expect(useConversationFoldersStore.getState().folders).toHaveLength(0);
    expect(useConversationsStore.getState().chats[0].folderId).toBeUndefined();
    expect(useConversationsStore.getState().channels[0].folderId).toBeUndefined();
  });

  it('setConversationPinned patches chat or channel in place', async () => {
    (window.electron as any).setConversationPinned = vi.fn().mockResolvedValue({ success: true });
    await useConversationFoldersStore.getState().setConversationPinned('c2', true);
    expect(useConversationsStore.getState().chats.find((c) => c.id === 'c2')?.pinned).toBe(true);

    await useConversationFoldersStore.getState().setConversationPinned('ch1', true);
    expect(useConversationsStore.getState().channels[0].pinned).toBe(true);
  });

  it('setConversationFolder moves a conversation and clears with null', async () => {
    (window.electron as any).setConversationFolder = vi.fn().mockResolvedValue({ success: true });
    await useConversationFoldersStore.getState().setConversationFolder('c2', 'f1');
    expect(useConversationsStore.getState().chats.find((c) => c.id === 'c2')?.folderId).toBe('f1');

    await useConversationFoldersStore.getState().setConversationFolder('c2', null);
    expect(useConversationsStore.getState().chats.find((c) => c.id === 'c2')?.folderId).toBeUndefined();
  });

  it('toasts when pin IPC fails', async () => {
    (window.electron as any).setConversationPinned = vi.fn().mockResolvedValue({
      success: false,
      error: 'denied',
    });
    await useConversationFoldersStore.getState().setConversationPinned('c1', true);
    expect(useToastStore.getState().toasts.some((t) => t.message === 'denied')).toBe(true);
    expect(useConversationsStore.getState().chats[0].pinned).toBe(false);
  });
});

// Every action wraps its IPC call in try/catch and falls back to a generic
// message when the envelope carries no `error`. Neither arm is reachable from
// the happy-path tests above.
describe('useConversationFoldersStore — IPC failure handling', () => {
  const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

  beforeEach(() => {
    useConversationFoldersStore.setState({ folders: [{ id: 'f1', name: 'Work' } as any] });
    useConversationsStore.setState({
      chats: [{ id: 'c1', folderId: 'f1', pinned: false } as any],
      channels: [],
    });
    useToastStore.setState({ toasts: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('swallows a thrown loadFolders and leaves folders untouched', async () => {
    (window.electron as any).listConversationFolders = vi.fn().mockRejectedValue(new Error('down'));
    await useConversationFoldersStore.getState().loadFolders();
    expect(useConversationFoldersStore.getState().folders).toHaveLength(1);
  });

  it('ignores a loadFolders envelope that reports success without folders', async () => {
    (window.electron as any).listConversationFolders = vi.fn().mockResolvedValue({ success: true });
    await useConversationFoldersStore.getState().loadFolders();
    expect(useConversationFoldersStore.getState().folders).toHaveLength(1);
  });

  it.each([
    ['createFolder', 'createConversationFolder', 'Failed to create folder'],
    ['renameFolder', 'renameConversationFolder', 'Failed to rename folder'],
    ['deleteFolder', 'deleteConversationFolder', 'Failed to delete folder'],
    ['setConversationPinned', 'setConversationPinned', 'Failed to update pin'],
    ['setConversationFolder', 'setConversationFolder', 'Failed to move conversation'],
  ])('%s falls back to a generic toast when the envelope has no error', async (action, ipc, msg) => {
    (window.electron as any)[ipc] = vi.fn().mockResolvedValue({ success: false });
    await (useConversationFoldersStore.getState() as any)[action]('f1', 'x');
    expect(toastMessages()).toContain(msg);
  });

  it.each([
    ['createFolder', 'createConversationFolder', 'Failed to create folder'],
    ['renameFolder', 'renameConversationFolder', 'Failed to rename folder'],
    ['deleteFolder', 'deleteConversationFolder', 'Failed to delete folder'],
    ['setConversationPinned', 'setConversationPinned', 'Failed to update pin'],
    ['setConversationFolder', 'setConversationFolder', 'Failed to move conversation'],
  ])('%s toasts when the IPC call throws', async (action, ipc, msg) => {
    (window.electron as any)[ipc] = vi.fn().mockRejectedValue(new Error('boom'));
    await (useConversationFoldersStore.getState() as any)[action]('f1', 'x');
    expect(toastMessages()).toContain(msg);
    expect(console.error).toHaveBeenCalled();
  });

  it('returns null from createFolder when the envelope omits the folder', async () => {
    (window.electron as any).createConversationFolder = vi
      .fn()
      .mockResolvedValue({ success: true });
    expect(await useConversationFoldersStore.getState().createFolder('X')).toBeNull();
  });
});
