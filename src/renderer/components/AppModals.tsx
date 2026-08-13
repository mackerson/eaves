import type { MCPServer } from '@/types';
import { useAgentStore, useProjectStore, useConversationsStore, useUIStore } from '@/stores';
import { useChannelActions } from '@/hooks/useChannelActions';
import { ProjectModal } from '@/components/modals/ProjectModal';
import { ConfirmDialog } from '@/components/modals/ConfirmDialog';
import { ChannelModal } from '@/components/modals/ChannelModal';
import { MCPServerModal } from '@/components/modals/MCPServerModal';
import { AddAgentModal } from '@/components/modals/AddAgentModal';
import { TaskModal } from '@/components/modals/TaskModal';
import { NoteModal } from '@/components/modals/NoteModal';

export function AppModals({ loadMemory }: { loadMemory: () => Promise<void> }) {
  const {
    agents,
    showMCPModal,
    editingAgentId,
    closeMCPModal,
  } = useAgentStore();

  const {
    showProjectModal,
    editingProject,
    showTaskModal,
    closeTaskModal,
    showNoteModal,
    closeNoteModal,
    closeProjectModal,
    createProject,
    updateProject,
  } = useProjectStore();

  const {
    channels,
    currentChannelId,
    showChannelModal,
    showAddAgentModal,
    closeChannelModal,
    closeAddAgentModal,
  } = useConversationsStore();

  const {
    showConfirmDialog,
    confirmMessage,
    confirmAction,
    closeConfirmation,
    setView,
  } = useUIStore();

  const { handleAddAgentToChannel } = useChannelActions();

  const handleSaveProject = async (data: { name: string; description: string }) => {
    if (editingProject) {
      await updateProject(editingProject.id, data);
    } else {
      await createProject(data);
    }
    closeProjectModal();
    await loadMemory();
    if (!editingProject) {
      setView('channels');
    }
  };

  const handleCreateChannel = async (name: string) => {
    await window.electron.createChannel({ name, type: 'public' });
    await loadMemory();
  };

  const handleAddMCPServer = async (serverData: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    enabled: boolean;
    command: string;
    args: string;
    url: string;
  }) => {
    if (!editingAgentId) return;

    const mcpServerData: Omit<MCPServer, 'id'> = {
      name: serverData.name,
      transport: serverData.transport,
      enabled: serverData.enabled,
      config: {}
    };

    if (serverData.transport === 'stdio') {
      mcpServerData.config.command = serverData.command;
      mcpServerData.config.args = serverData.args ? serverData.args.split(' ') : [];
    } else {
      mcpServerData.config.url = serverData.url;
    }

    await window.electron.addMCPServer(editingAgentId, mcpServerData);
    await loadMemory();
  };

  const handleToggleMCPServer = async (serverId: string, enabled: boolean) => {
    if (!editingAgentId) return;
    await window.electron.updateMCPServer(editingAgentId, serverId, { enabled });
    await loadMemory();
  };

  const handleDeleteMCPServer = async (serverId: string) => {
    if (!editingAgentId) return;
    if (!confirm('Delete this MCP server?')) return;
    await window.electron.deleteMCPServer(editingAgentId, serverId);
    await loadMemory();
  };

  return (
    <>
      <ProjectModal
        open={showProjectModal}
        onOpenChange={closeProjectModal}
        project={editingProject}
        onSave={handleSaveProject}
      />

      <ConfirmDialog
        open={showConfirmDialog}
        onOpenChange={closeConfirmation}
        message={confirmMessage}
        onConfirm={confirmAction}
      />

      <ChannelModal
        open={showChannelModal}
        onOpenChange={closeChannelModal}
        onCreateChannel={handleCreateChannel}
      />

      <MCPServerModal
        open={showMCPModal}
        onOpenChange={closeMCPModal}
        agent={agents.find(a => a.id === editingAgentId) || null}
        onAddServer={handleAddMCPServer}
        onToggleServer={handleToggleMCPServer}
        onDeleteServer={handleDeleteMCPServer}
      />

      <AddAgentModal
        open={showAddAgentModal}
        onOpenChange={closeAddAgentModal}
        agents={agents}
        currentChannel={Array.isArray(channels) ? channels.find(c => c.id === currentChannelId) || null : null}
        onAddAgent={handleAddAgentToChannel}
      />

      <TaskModal open={showTaskModal} onOpenChange={(open) => !open && closeTaskModal()} />

      <NoteModal open={showNoteModal} onOpenChange={(open) => !open && closeNoteModal()} />
    </>
  );
}
