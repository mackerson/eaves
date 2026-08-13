import { useEffect } from 'react';
import { useAgentStore, useProjectStore, useConversationsStore, useUIStore } from '@/stores';

/**
 * Escape-to-dismiss.
 *
 * Every other chord this hook used to own now comes from the shared menu
 * model via useMenuShortcuts, so a shortcut and the menu row that advertises
 * it can no longer disagree. Escape stays here because it is not a menu
 * command — it dismisses whatever is open, which no menu row describes.
 */
export function useKeyboardShortcuts() {
  const { closeMCPModal } = useAgentStore();
  const { closeProjectModal, closeTaskModal, closeNoteModal } = useProjectStore();
  const { closeChannelModal, closeAddAgentModal, clearChannelSearch } = useConversationsStore();
  const { closeConfirmation } = useUIStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      closeProjectModal();
      closeChannelModal();
      closeMCPModal();
      closeAddAgentModal();
      closeConfirmation();
      closeTaskModal();
      closeNoteModal();
      clearChannelSearch();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    closeProjectModal,
    closeChannelModal,
    closeMCPModal,
    closeAddAgentModal,
    closeConfirmation,
    closeTaskModal,
    closeNoteModal,
    clearChannelSearch,
  ]);
}
