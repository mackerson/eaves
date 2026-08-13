import { create } from 'zustand';

/**
 * Change signal between the list views (where pinning happens) and the sidebar
 * sections (which show what's pinned).
 *
 * Conversations don't need this — they live in useConversationsStore, so the
 * sidebar re-renders from the same state the pin toggle writes. Workflows and
 * routines instead load their pinned set straight from IPC on mount, so
 * without a nudge the sidebar keeps showing a stale list until the section
 * remounts or the project changes, and pinning reads as broken.
 *
 * A counter rather than the pinned list itself: the sections already know how
 * to fetch, and duplicating that state here would just be a second thing to
 * keep correct.
 */
interface SidebarPinsState {
  workflowsRevision: number;
  routinesRevision: number;
  notifyWorkflowPinsChanged: () => void;
  notifyRoutinePinsChanged: () => void;
}

export const useSidebarPinsStore = create<SidebarPinsState>((set) => ({
  workflowsRevision: 0,
  routinesRevision: 0,
  notifyWorkflowPinsChanged: () => set((s) => ({ workflowsRevision: s.workflowsRevision + 1 })),
  notifyRoutinePinsChanged: () => set((s) => ({ routinesRevision: s.routinesRevision + 1 })),
}));
