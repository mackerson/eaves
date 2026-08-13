import { useEffect, useRef, useCallback } from 'react';
import { useAgentStore, useProjectStore, useConversationsStore, useSettingsStore, useUIStore, useToastStore } from '@/stores';
import { initializePluginAPI } from '@/lib/plugin-api';

export function useAppInit() {
  const hasInitializedRef = useRef(false);

  const { setAgents, setCurrentAgentId } = useAgentStore();
  const { setProjects, setCurrentProjectId, setTasks, setNotes, setEvents } = useProjectStore();
  const { setChannels, setCurrentChannelId } = useConversationsStore();
  const { setSettings } = useSettingsStore();
  const { setView, setPluginViews } = useUIStore();
  const showToast = useToastStore((state) => state.showToast);

  const loadMemory = useCallback(async () => {
    const memory = await window.electron.getMemory();
    setSettings(memory.settings);
    setAgents(memory.agents);
    setCurrentAgentId(memory.currentAgentId);
    setProjects(memory.projects);
    setCurrentProjectId(memory.currentProjectId);
    setChannels(memory.channels || []);
    setCurrentChannelId(memory.currentChannelId);

    useConversationsStore.getState().initChannelSelectedAgents(memory.channels || []);

    // Mirror currentChatId into the chats store so the chats view doesn't
    // have to fire another getMemory IPC just to learn which chat to
    // auto-select. getMemory is heavy (synchronously hydrates every
    // project's tasks/notes/events) — doubling it noticeably blocks the
    // renderer at boot, which surfaces to the user as a chat input that's
    // disabled with a misleading "No agent selected" reason.
    const currentChatId = memory.settings?.currentChatId || null;
    if (currentChatId) {
      useConversationsStore.getState().setCurrentChatId(currentChatId);
      // Pre-fetch the current chat with messages so it's ready when the
      // user navigates to the chats view, matching the prior behavior of
      // loadChats's auto-load.
      try {
        const chatResult = await window.electron.getChat(currentChatId);
        if (chatResult.success && chatResult.chat) {
          const chat = chatResult.chat;
          useConversationsStore.setState((state) => ({
            chats: state.chats.some((c) => c.id === currentChatId)
              ? state.chats.map((c) => (c.id === currentChatId ? chat : c))
              : [chat, ...state.chats],
          }));
        }
      } catch (error) {
        window.electron.logError({ message: 'Failed to pre-fetch current chat', error });
      }
    }

    const currentProj = memory.projects.find(p => p.id === memory.currentProjectId);
    if (currentProj) {
      setTasks(currentProj.tasks);
      setNotes(currentProj.notes);
      setEvents(currentProj.events);
    }

    try {
      const views = await window.electron.getPluginViews();
      setPluginViews(views);

      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        if (memory.agents.length === 0 && memory.settings.oobeCompleted) {
          setView('agents');
        }
      }
    } catch (error) {
      window.electron.logError({ message: 'Failed to load plugin views', error });
    }
  }, [setSettings, setAgents, setCurrentAgentId, setProjects, setCurrentProjectId, setTasks, setNotes, setEvents, setChannels, setCurrentChannelId, setPluginViews, setView]);

  useEffect(() => {
    initializePluginAPI();
    loadMemory();

    const reloadPluginViews = async () => {
      try {
        const views = await window.electron.getPluginViews();
        setPluginViews(views);
      } catch (error) {
        window.electron.logError({ message: 'Failed to reload plugin views', error });
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        reloadPluginViews();
      }
    };

    const handlePluginViewsChanged = () => {
      reloadPluginViews();
    };

    const handlePluginToast = (data: any) => {
      showToast(data.message, data.type || 'info', data.duration);
    };

    const handlePluginNotification = (data: any) => {
      showToast(data.message, data.type || 'info');
    };

    // Refresh project data when background agents create/modify tasks or notes
    const cleanupProjectData = window.electron.onProjectDataChanged(() => {
      loadMemory();
    });

    // Refresh agent list when something other than the renderer creates one
    // (e.g. plugin imports via the sandbox actions surface — character-card-
    // import is the current caller). The renderer's optimistic createAgent
    // path doesn't fire this, so it's a no-op for self-initiated changes.
    const cleanupAgentsChanged = window.electron.onAgentsChanged(() => {
      loadMemory();
    });

    // LAN sync applied remote changes directly to SQLite (bypassing
    // repositories, so no per-entity events fired). Coarse refresh: reload
    // app state, and the chats list when chat data was touched.
    const cleanupSyncApplied = window.electron.on('sync:applied', (...args: unknown[]) => {
      const data = args[0] as { tables?: string[] } | undefined;
      loadMemory();
      const tables = data?.tables ?? [];
      if (tables.some(t => t.startsWith('chat'))) {
        useConversationsStore.getState().loadChats();
      }
    });

    // Surface silent workflow blocks (e.g. a scheduled routine fires while
    // its workflow is still pending human review) as a toast so the user
    // doesn't have to notice via the activity log.
    const cleanupActivityToasts = window.electron.onActivityNew((activity) => {
      if (activity.type === 'workflow:blocked:pending-review') {
        const data = activity.data as { workflowName?: string } | null;
        const name = data?.workflowName ?? 'a workflow';
        showToast(
          `Blocked: ${name} is pending review. Approve it in the Workflows tab.`,
          'warning',
        );
      }
    });

    window.addEventListener('focus', reloadPluginViews);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.electron.on('plugin-views-changed', handlePluginViewsChanged);
    window.electron.on('plugin:ui:toast', handlePluginToast);
    window.electron.on('plugin:ui:notification', handlePluginNotification);

    return () => {
      cleanupProjectData();
      cleanupAgentsChanged();
      cleanupSyncApplied();
      cleanupActivityToasts();
      window.removeEventListener('focus', reloadPluginViews);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.electron.off('plugin-views-changed', handlePluginViewsChanged);
      window.electron.off('plugin:ui:toast', handlePluginToast);
      window.electron.off('plugin:ui:notification', handlePluginNotification);
    };
  }, [showToast]);

  return { loadMemory };
}
