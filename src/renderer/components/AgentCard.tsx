import { memo } from 'react';
import { Agent } from '@/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface AgentCardProps {
  agent: Agent;
  isActive: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onManageMCP: () => void;
}

export const AgentCard = memo(function AgentCard({ agent, isActive, onSelect, onEdit, onDelete, onManageMCP }: AgentCardProps) {
  return (
    <Card
      className={`cursor-pointer transition-all ${isActive ? 'ring-2 ring-primary' : ''}`}
      onClick={onSelect}
    >
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3 flex-1">
            {agent.avatar ? (
              <img
                src={`avatar://${agent.avatar}`}
                alt={agent.name}
                className="w-10 h-10 rounded-full object-cover"
              />
            ) : (
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
                style={{ backgroundColor: agent.color }}
              >
                {agent.name[0]?.toUpperCase() || '?'}
              </div>
            )}
            <div className="flex-1">
              <CardTitle className="text-lg">{agent.name}</CardTitle>
              <CardDescription className="mt-1">{agent.description}</CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <Badge variant="secondary">{agent.provider}</Badge>
          <Badge variant="outline">{agent.model}</Badge>
          <Badge variant="outline">
            {agent.mcpServers.filter(s => s.enabled).length} MCP
          </Badge>
        </div>
        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={onManageMCP} className="flex-1">
            Configure MCP
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});
