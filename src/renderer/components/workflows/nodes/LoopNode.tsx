import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { LoopNodeConfig } from './configs';

export const LoopNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="🔁"
      fallbackLabel="Loop"
      className="loop-node"
      customHandles={
        <>
          <Handle type="source" position={Position.Bottom} id="body" style={{ left: '50%' }}>
            <div className="handle-label">Loop Body</div>
          </Handle>
          <Handle type="source" position={Position.Right} id="next">
            <div className="handle-label">Done</div>
          </Handle>
        </>
      }
    >
      <LoopNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

LoopNode.displayName = 'LoopNode';
