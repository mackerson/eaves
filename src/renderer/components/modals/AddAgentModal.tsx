import type { Agent, Channel } from '@/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface AddAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  currentChannel: Channel | null;
  onAddAgent: (agentId: string) => void;
}

export function AddAgentModal({
  open,
  onOpenChange,
  agents,
  currentChannel,
  onAddAgent,
}: AddAgentModalProps) {
  const availableAgents = agents.filter(
    (agent) => agent?.id && agent?.name && !currentChannel?.participants.some(participant => participant.id === agent.id)
  );

  const handleAddAgent = (agentId: string) => {
    onAddAgent(agentId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Agent to Channel</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {availableAgents.length > 0 ? (
            availableAgents.map((agent) => (
              <div
                key={agent.id}
                onClick={() => handleAddAgent(agent.id)}
                className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-accent cursor-pointer transition-colors"
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0"
                  style={{ backgroundColor: agent.color }}
                >
                  {(agent.name || '??').substring(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{agent.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {agent.provider} • {agent.model}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground text-center p-6">
              All agents are already in this channel
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
