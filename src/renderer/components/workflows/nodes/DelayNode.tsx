import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { DelayNodeConfig } from './configs';

export const DelayNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="⏱️"
      fallbackLabel={"Delay"}
      className="delay-node"
    >
      <DelayNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

DelayNode.displayName = 'DelayNode';
