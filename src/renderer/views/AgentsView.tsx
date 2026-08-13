import { memo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { AgentCard } from '@/components/AgentCard';
import { useAgentStore } from '@/stores/useAgentStore';
import { useUIStore } from '@/stores/useUIStore';

export const AgentsView = memo(function AgentsView() {
  const { agents, currentAgentId, switchAgent, deleteAgent, openMCPModal } = useAgentStore();
  const { setView } = useUIStore();

  const handleCreateAgent = useCallback(() => {
    useUIStore.getState().setEditingAgentId(null);
    setView('agent-editor');
  }, [setView]);

  const handleEditAgent = useCallback((agentId: string) => {
    useUIStore.getState().setEditingAgentId(agentId);
    setView('agent-editor');
  }, [setView]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Agents</h2>
        <Button onClick={handleCreateAgent}>+ New Agent</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            isActive={agent.id === currentAgentId}
            onSelect={() => switchAgent(agent.id)}
            onEdit={() => handleEditAgent(agent.id)}
            onDelete={() => deleteAgent(agent.id)}
            onManageMCP={() => openMCPModal(agent.id)}
          />
        ))}
      </div>
    </div>
  );
});
