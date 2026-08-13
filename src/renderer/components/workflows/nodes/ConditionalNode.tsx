import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { ConditionalNodeConfig } from './configs';

export const ConditionalNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="❓"
      fallbackLabel="Condition"
      className="conditional-node"
      customHandles={
        <>
          <Handle type="source" position={Position.Bottom} id="true" style={{ left: '25%' }}>
            <div className="handle-label">✓</div>
          </Handle>
          <Handle type="source" position={Position.Bottom} id="false" style={{ left: '75%' }}>
            <div className="handle-label">✗</div>
          </Handle>
        </>
      }
    >
      <ConditionalNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

ConditionalNode.displayName = 'ConditionalNode';
