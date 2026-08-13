import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { HttpNodeConfig } from './configs';

export const HttpNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="🌐"
      fallbackLabel={"HTTP request"}
      className="http-node"
    >
      <HttpNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

HttpNode.displayName = 'HttpNode';
