import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from './useUIStore';

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      view: 'chats',
      pluginViews: [],
      showConfirmDialog: false,
      confirmMessage: '',
      confirmAction: () => {},
      pendingCreate: false,
      pendingSettingsTab: undefined,
      editingAgentIdForView: null,
      terminalOpen: false,
    });
  });

  describe('pendingSettingsTab', () => {
    it('is unset by default', () => {
      expect(useUIStore.getState().pendingSettingsTab).toBeUndefined();
    });

    it('setPendingSettingsTab records the requested tab', () => {
      useUIStore.getState().setPendingSettingsTab('providers');
      expect(useUIStore.getState().pendingSettingsTab).toBe('providers');
    });

    it('clearPendingSettingsTab consumes it', () => {
      useUIStore.getState().setPendingSettingsTab('memory');
      useUIStore.getState().clearPendingSettingsTab();
      expect(useUIStore.getState().pendingSettingsTab).toBeUndefined();
    });

    it('survives setView, so the caller can request the tab in either order', () => {
      useUIStore.getState().setPendingSettingsTab('sync');
      useUIStore.getState().setView('settings');
      expect(useUIStore.getState().view).toBe('settings');
      expect(useUIStore.getState().pendingSettingsTab).toBe('sync');
    });
  });

  describe('navigation + create signal', () => {
    it('setView clears pendingCreate; setViewWithCreate sets it', () => {
      useUIStore.getState().setViewWithCreate('agents');
      expect(useUIStore.getState()).toMatchObject({ view: 'agents', pendingCreate: true });
      useUIStore.getState().setView('chats');
      expect(useUIStore.getState()).toMatchObject({ view: 'chats', pendingCreate: false });
      useUIStore.getState().setViewWithCreate('projects');
      useUIStore.getState().clearPendingCreate();
      expect(useUIStore.getState().pendingCreate).toBe(false);
    });
  });

  describe('terminal + editing agent', () => {
    it('setTerminalOpen and toggleTerminal flip the flag', () => {
      useUIStore.getState().setTerminalOpen(true);
      expect(useUIStore.getState().terminalOpen).toBe(true);
      useUIStore.getState().toggleTerminal();
      expect(useUIStore.getState().terminalOpen).toBe(false);
      useUIStore.getState().setEditingAgentId('a1');
      expect(useUIStore.getState().editingAgentIdForView).toBe('a1');
    });
  });

  describe('confirmation dialog', () => {
    it('show / close / execute lifecycle', () => {
      const action = vi.fn();
      useUIStore.getState().showConfirmation('Delete?', action);
      expect(useUIStore.getState()).toMatchObject({
        showConfirmDialog: true,
        confirmMessage: 'Delete?',
      });

      useUIStore.getState().closeConfirmation();
      expect(useUIStore.getState().showConfirmDialog).toBe(false);
      expect(action).not.toHaveBeenCalled();

      useUIStore.getState().showConfirmation('Sure?', action);
      useUIStore.getState().executeConfirmation();
      expect(action).toHaveBeenCalledOnce();
      expect(useUIStore.getState().showConfirmDialog).toBe(false);
    });
  });

  it('setPluginViews replaces the list', () => {
    useUIStore.getState().setPluginViews([{ id: 'p', name: 'P' } as any]);
    expect(useUIStore.getState().pluginViews).toHaveLength(1);
  });
});
