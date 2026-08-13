import { create } from 'zustand';
import { View, PluginView, SettingsTabId } from '@/types';

interface UIState {
  // State
  view: View;
  pluginViews: PluginView[];
  showConfirmDialog: boolean;
  confirmMessage: string;
  confirmAction: () => void;
  pendingCreate: boolean; // Signal to open creation form on view load
  pendingSettingsTab?: SettingsTabId; // One-shot: settings tab to open on view load
  editingAgentIdForView: string | null; // Agent ID for agent-editor view
  // Lives here rather than in App's local state so Tools ▸ Toggle Terminal can
  // reach it without drilling a callback through AppLayout.
  terminalOpen: boolean;

  // Actions
  setView: (view: View) => void;
  setViewWithCreate: (view: View) => void; // Navigate and signal creation mode
  clearPendingCreate: () => void;
  setPendingSettingsTab: (tab: SettingsTabId) => void;
  clearPendingSettingsTab: () => void;
  setPluginViews: (views: PluginView[]) => void;
  setEditingAgentId: (id: string | null) => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;

  // Confirmation dialog
  showConfirmation: (message: string, action: () => void) => void;
  closeConfirmation: () => void;
  executeConfirmation: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  // Initial state
  view: 'chats',
  pluginViews: [],
  showConfirmDialog: false,
  confirmMessage: '',
  confirmAction: () => {},
  pendingCreate: false,
  pendingSettingsTab: undefined,
  editingAgentIdForView: null,
  terminalOpen: false,

  // State setters
  setView: (view) => set({ view, pendingCreate: false }), // Clear pending on normal nav
  setViewWithCreate: (view) => set({ view, pendingCreate: true }), // Signal creation mode
  clearPendingCreate: () => set({ pendingCreate: false }),
  // Deliberately not cleared by setView: the caller may set the tab either
  // before or after navigating, and SettingsView clears it once applied.
  setPendingSettingsTab: (tab) => set({ pendingSettingsTab: tab }),
  clearPendingSettingsTab: () => set({ pendingSettingsTab: undefined }),
  setPluginViews: (views) => set({ pluginViews: views }),
  setEditingAgentId: (id) => set({ editingAgentIdForView: id }),
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  toggleTerminal: () => set({ terminalOpen: !get().terminalOpen }),

  // Confirmation dialog
  showConfirmation: (message, action) => {
    set({
      showConfirmDialog: true,
      confirmMessage: message,
      confirmAction: action,
    });
  },

  closeConfirmation: () => {
    set({
      showConfirmDialog: false,
      confirmMessage: '',
      confirmAction: () => {},
    });
  },

  executeConfirmation: () => {
    const { confirmAction } = get();
    confirmAction();
    get().closeConfirmation();
  },
}));
