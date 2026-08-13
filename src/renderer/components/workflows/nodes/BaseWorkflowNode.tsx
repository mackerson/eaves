import { memo, useState, ReactNode } from 'react';
import { Handle, Position, useReactFlow } from 'reactflow';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';

interface BaseWorkflowNodeProps<T = any> {
  id: string;
  // `label` is a convention, not a guarantee: WorkflowNode.data is an untyped
  // bag and agent-authored graphs omit it entirely. Callers supply a
  // fallbackLabel so a node always says what it is.
  data: T & { label?: string };
  icon: ReactNode;
  className: string;
  /** Shown when data.label is absent. Describe the step, not the node type. */
  fallbackLabel: string;
  children: ReactNode; // Config section content
  customHandles?: ReactNode; // Custom handles for special nodes
}

export const BaseWorkflowNode = memo(<T extends { label?: string }>({
  id,
  data,
  icon,
  className,
  fallbackLabel,
  children,
  customHandles,
}: BaseWorkflowNodeProps<T>) => {
  const displayLabel = data.label || fallbackLabel;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  // Renaming starts from what the user can see, so accepting the prefilled
  // value promotes the fallback into a real stored label.
  const [newLabel, setNewLabel] = useState(displayLabel);
  const { setNodes, deleteElements } = useReactFlow();

  const handleRename = () => {
    setNodes((nodes) =>
      nodes.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, label: newLabel } };
        }
        return node;
      })
    );
    setIsRenaming(false);
  };

  const handleDelete = () => {
    deleteElements({ nodes: [{ id }] });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRename();
    } else if (e.key === 'Escape') {
      setNewLabel(displayLabel);
      setIsRenaming(false);
    }
  };

  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} />

      <div className="node-header">
        <span className="node-icon">{icon}</span>
        {isRenaming ? (
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleKeyDown}
            className="node-label-input"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="node-label" onClick={() => setIsExpanded(!isExpanded)}>
            {displayLabel}
          </span>
        )}
        <div className="node-controls">
          <button
            className="node-control-btn"
            onClick={(e) => {
              e.stopPropagation();
              setIsRenaming(true);
            }}
            title="Rename node"
          >
            <Pencil size={12} />
          </button>
          <button
            className="node-control-btn node-delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete();
            }}
            title="Delete node"
          >
            <Trash2 size={12} />
          </button>
          <button
            className="node-expand-btn"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        </div>
      </div>

      {isExpanded && <div className="node-config">{children}</div>}

      {customHandles || <Handle type="source" position={Position.Bottom} />}
    </div>
  );
});

BaseWorkflowNode.displayName = 'BaseWorkflowNode';
