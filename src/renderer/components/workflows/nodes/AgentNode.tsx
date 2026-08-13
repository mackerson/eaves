import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { AgentNodeConfig } from './configs';
import { useAgentStore } from '@/stores';

export const AgentNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  const agents = useAgentStore((s) => s.agents);
  const agentName = agents.find((agent) => agent.id === data.agentId)?.name;

  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="🤖"
      fallbackLabel={agentName ? `Ask ${agentName}` : 'Agent step'}
      className="agent-node"
    >
      <AgentNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

AgentNode.displayName = 'AgentNode';
