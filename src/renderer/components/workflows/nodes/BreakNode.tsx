import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { BreakNodeConfig } from './configs';

export const BreakNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="⛔"
      fallbackLabel={"Break"}
      className="break-node"
    >
      <BreakNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

BreakNode.displayName = 'BreakNode';
