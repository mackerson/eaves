import { useCallback, useEffect, useState } from 'react';
import type { MenuCommandId, DynamicMenuSource } from '@shared/menuModel';
import type { DynamicMenuEntry } from '@/components/layout/MenuBar';
import {
  useConversationsStore,
  useProjectStore,
  useUIStore,
  useUIPreferencesStore,
  useToastStore,
} from '@/stores';
import { useTheme } from '@/contexts/ThemeContext';

/**
 * Every menu command's behaviour, in one place.
 *
 * Both menu surfaces route here — the in-window bar calls `onCommand`
 * directly, and the native macOS menu sends the same command id over IPC.
 * That is the point of the split: the menu describes *what* exists, this
 * describes *what it does*, and neither duplicates the other.
 */

export interface MenuCommandModals {
  openAbout: () => void;
  openGlobalSearch: () => void;
  openLogViewer: () => void;
}

export function useMenuCommands(modals: MenuCommandModals) {
  const setView = useUIStore((s) => s.setView);
  const setViewWithCreate = useUIStore((s) => s.setViewWithCreate);
  const setEditingAgentId = useUIStore((s) => s.setEditingAgentId);
  const setPendingSettingsTab = useUIStore((s) => s.setPendingSettingsTab);
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);

  const openProjectModal = useProjectStore((s) => s.openProjectModal);
  const openTaskModal = useProjectStore((s) => s.openTaskModal);
  const openNoteModal = useProjectStore((s) => s.openNoteModal);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const openChannelModal = useConversationsStore((s) => s.openChannelModal);
  const createBlankChat = useConversationsStore((s) => s.createBlankChat);
  const exportChatAsMarkdown = useConversationsStore((s) => s.exportChatAsMarkdown);
  const currentChatId = useConversationsStore((s) => s.currentChatId);
  const showArchived = useConversationsStore((s) => s.showArchived);
  const showAgentRooms = useConversationsStore((s) => s.showAgentRooms);

  const sidebarCollapsed = useUIPreferencesStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIPreferencesStore((s) => s.toggleSidebar);
  const actionGutterCollapsed = useUIPreferencesStore((s) => s.actionGutterCollapsed);
  const setActionGutterCollapsed = useUIPreferencesStore((s) => s.setActionGutterCollapsed);
  const compactMode = useUIPreferencesStore((s) => s.compactMode);
  const toggleCompactMode = useUIPreferencesStore((s) => s.toggleCompactMode);

  const { theme, allThemes, setTheme } = useTheme();

  const toast = useToastStore((s) => s.showToast);

  const [routines, setRoutines] = useState<DynamicMenuEntry[]>([]);
  const [workflows, setWorkflows] = useState<DynamicMenuEntry[]>([]);

  // Tools ▸ Run Routine / Run Workflow list whatever the active project has.
  // Both IPC surfaces are project-scoped, so the submenus are empty (and say
  // so) when nothing is selected rather than silently listing another
  // project's automation.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!currentProjectId) {
        setRoutines([]);
        setWorkflows([]);
        return;
      }
      try {
        const [routineList, workflowList] = await Promise.all([
          window.electron.getRoutines(currentProjectId),
          window.electron.getWorkflows(currentProjectId),
        ]);
        if (cancelled) return;
        setRoutines(routineList.map((r) => ({ id: r.id, label: r.name })));
        setWorkflows(workflowList.map((w) => ({ id: w.id, label: w.name })));
      } catch (err) {
        if (!cancelled) console.error('Failed to load menu automation lists:', err);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  /**
   * Notes, tasks and project files all require an active project — the IPC
   * refuses without one. Saying that plainly beats opening a modal that
   * cannot save.
   */
  const requireProject = useCallback(
    (what: string): boolean => {
      if (currentProjectId) return true;
      toast(`Select a project first to create ${what}.`, 'warning');
      return false;
    },
    [currentProjectId, toast],
  );

  const uploadFiles = useCallback(async () => {
    if (!requireProject('files')) return;
    const picked = await window.electron.pickFiles();
    if (picked.canceled || picked.paths.length === 0) return;

    const results = await window.electron.addMultipleFiles(currentProjectId!, picked.paths);
    const failed = results.filter((r) => !r.success).length;
    if (failed > 0) {
      toast(`${results.length - failed} of ${results.length} files added.`, 'warning');
    } else {
      toast(`Added ${results.length} file${results.length === 1 ? '' : 's'}.`, 'success');
    }
    setView('files');
  }, [currentProjectId, requireProject, setView, toast]);

  const exportConversation = useCallback(async () => {
    if (currentChatId) {
      await exportChatAsMarkdown(currentChatId);
      return;
    }
    // Channel export has no backing IPC yet; the chat path is chats-only.
    toast('Open a chat to export it. Channel export is not available yet.', 'info');
  }, [currentChatId, exportChatAsMarkdown, toast]);

  const toggleArchived = useCallback(async () => {
    const next = !useConversationsStore.getState().showArchived;
    useConversationsStore.getState().setShowArchived(next);
    // Archived is a server-side filter — the flag alone changes nothing until
    // the lists are refetched.
    await Promise.all([
      useConversationsStore.getState().loadChats(),
      useConversationsStore.getState().loadChannels(),
    ]);
  }, []);

  const openSettingsTab = useCallback(
    (tab: Parameters<typeof setPendingSettingsTab>[0]) => {
      setPendingSettingsTab(tab);
      setView('settings');
    },
    [setPendingSettingsTab, setView],
  );

  const onCommand = useCallback(
    (id: MenuCommandId, payload?: { dynamicId?: string }) => {
      const run = async () => {
        switch (id) {
          // App
          case 'app.about':
            modals.openAbout();
            break;
          case 'app.checkForUpdates':
            openSettingsTab('updates');
            break;
          case 'app.settings':
            setView('settings');
            break;
          case 'app.hide':
            // macOS-only, handled by the native menu's role.
            break;
          case 'app.quit':
            await window.electron.quitApp();
            break;

          // File
          case 'file.newChat':
            await createBlankChat();
            setView('chats');
            break;
          case 'file.newChannel':
            openChannelModal();
            break;
          case 'file.newProject':
            openProjectModal();
            break;
          case 'file.newAgent':
            setEditingAgentId(null);
            setView('agent-editor');
            break;
          case 'file.newWorkflow':
            setViewWithCreate('workflows');
            break;
          case 'file.newRoutine':
            setViewWithCreate('routines');
            break;
          case 'file.newNote':
            if (requireProject('a note')) openNoteModal();
            break;
          case 'file.newTask':
            if (requireProject('a task')) openTaskModal();
            break;
          case 'file.uploadFiles':
            await uploadFiles();
            break;
          case 'file.import':
            setView('imports');
            break;
          case 'file.exportConversation':
            await exportConversation();
            break;

          // Edit — macOS routes these through native roles and never reaches
          // here; Windows and Linux have no native menu, so the renderer
          // performs them against the focused element.
          case 'edit.undo':
            document.execCommand('undo');
            break;
          case 'edit.redo':
            document.execCommand('redo');
            break;
          case 'edit.cut':
            document.execCommand('cut');
            break;
          case 'edit.copy':
            document.execCommand('copy');
            break;
          case 'edit.paste':
            document.execCommand('paste');
            break;
          case 'edit.findInConversation':
            focusConversationSearch(toast);
            break;

          // View
          case 'view.toggleSidebar':
            toggleSidebar();
            break;
          case 'view.toggleDetailPanel':
            setActionGutterCollapsed(!actionGutterCollapsed);
            break;
          case 'view.compactConversation':
            toggleCompactMode();
            break;
          case 'view.showArchived':
            await toggleArchived();
            break;
          case 'view.showAgentToAgent':
            useConversationsStore.getState().toggleShowAgentRooms();
            break;
          case 'view.zoomIn':
            await window.electron.zoomIn();
            break;
          case 'view.zoomOut':
            await window.electron.zoomOut();
            break;
          case 'view.resetZoom':
            await window.electron.resetZoom();
            break;
          case 'view.toggleFullScreen':
            await window.electron.toggleFullscreen();
            break;
          case 'view.setTheme':
            if (payload?.dynamicId) await setTheme(payload.dynamicId);
            break;

          // Go
          case 'go.searchEverything':
            modals.openGlobalSearch();
            break;
          case 'go.conversations':
            setView('chats');
            break;
          case 'go.projects':
            setView('projects');
            break;
          case 'go.agents':
            setView('agents');
            break;
          case 'go.workflows':
            setView('workflows');
            break;
          case 'go.routines':
            setView('routines');
            break;
          case 'go.files':
            setView('files');
            break;
          case 'go.notes':
            setView('notes');
            break;
          case 'go.tasks':
            setView('tasks');
            break;
          case 'go.calendar':
            setView('calendar');
            break;
          case 'go.activity':
            setView('activity');
            break;
          case 'go.memory':
            setView('memory');
            break;

          // Tools
          case 'tools.plugins':
            setView('plugins');
            break;
          case 'tools.modelProviders':
            openSettingsTab('providers');
            break;
          case 'tools.runRoutine':
            if (payload?.dynamicId) {
              const result = await window.electron.executeRoutine(payload.dynamicId);
              toast(result.success ? 'Routine started.' : result.error ?? 'Routine failed.', result.success ? 'success' : 'error');
            }
            break;
          case 'tools.runWorkflow':
            if (payload?.dynamicId) {
              const result = await window.electron.executeWorkflow(payload.dynamicId);
              toast(result.error ? result.error : 'Workflow started.', result.error ? 'error' : 'success');
            }
            break;
          case 'tools.toggleTerminal':
            toggleTerminal();
            break;
          case 'tools.toggleDevTools':
            await window.electron.toggleDevTools();
            break;
          case 'tools.viewLogs':
            modals.openLogViewer();
            break;
          case 'tools.openDataDir':
            await window.electron.openDataDir();
            break;

          // Help
          case 'help.documentation':
            await window.electron.openExternal('https://github.com/mackerson/eaves');
            break;
          case 'help.keyboardShortcuts':
            modals.openAbout();
            break;
          case 'help.releaseNotes':
            await window.electron.openExternal('https://github.com/mackerson/eaves/releases');
            break;
          case 'help.reportIssue':
            await window.electron.openExternal('https://github.com/mackerson/eaves/issues');
            break;
        }
      };

      void run().catch((err) => {
        console.error(`Menu command "${id}" failed:`, err);
        toast('That action could not be completed.', 'error');
      });
    },
    [
      modals,
      actionGutterCollapsed,
      createBlankChat,
      exportConversation,
      openChannelModal,
      openNoteModal,
      openProjectModal,
      openSettingsTab,
      openTaskModal,
      requireProject,
      setActionGutterCollapsed,
      setEditingAgentId,
      setTheme,
      setView,
      setViewWithCreate,
      toast,
      toggleArchived,
      toggleCompactMode,
      toggleSidebar,
      toggleTerminal,
      uploadFiles,
    ],
  );

  const isChecked = useCallback(
    (id: MenuCommandId): boolean => {
      switch (id) {
        case 'view.showArchived':
          return showArchived;
        case 'view.showAgentToAgent':
          return showAgentRooms;
        case 'view.toggleSidebar':
          return !sidebarCollapsed;
        case 'view.toggleDetailPanel':
          return !actionGutterCollapsed;
        case 'view.compactConversation':
          return compactMode;
        default:
          return false;
      }
    },
    [showArchived, showAgentRooms, sidebarCollapsed, actionGutterCollapsed, compactMode],
  );

  const resolveDynamic = useCallback(
    (source: DynamicMenuSource): DynamicMenuEntry[] => {
      switch (source) {
        case 'appearance':
          return allThemes.map((t) => ({ id: t.id, label: t.name, checked: t.id === theme }));
        case 'runRoutine':
          return routines;
        case 'runWorkflow':
          return workflows;
      }
    },
    [allThemes, theme, routines, workflows],
  );

  return { onCommand, isChecked, resolveDynamic };
}

/**
 * Find in Conversation focuses the existing per-view search field rather than
 * introducing a second search surface. Channels have one; chats do not yet.
 */
function focusConversationSearch(toast: (message: string, type?: 'info' | 'warning') => void) {
  const input = document.querySelector<HTMLInputElement>('[data-search="conversation"]');
  if (input) {
    input.focus();
    input.select();
    return;
  }
  toast('Open a channel to search its messages.', 'info');
}
