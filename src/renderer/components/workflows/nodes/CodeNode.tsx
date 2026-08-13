import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { CodeNodeConfig } from './configs';

export const CodeNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  const language = data.language ?? 'javascript';

  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="⚡"
      fallbackLabel={`Run ${language}`}
      className="code-node"
    >
      <CodeNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

CodeNode.displayName = 'CodeNode';
