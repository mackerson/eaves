import { memo } from 'react';
import { NodeProps, Handle, Position } from 'reactflow';
import { Play, Flag, Zap, Package } from 'lucide-react';
import { BaseWorkflowNode } from './BaseWorkflowNode';

interface GenericNodeData {
  label: string;
  [key: string]: unknown;
}

const ICONS: Record<string, JSX.Element> = {
  start: <Play size={14} />,
  end: <Flag size={14} />,
  action: <Zap size={14} />,
};

const CLASS_NAMES: Record<string, string> = {
  start: 'generic-node generic-node--start',
  action: 'generic-node generic-node--action',
  end: 'generic-node generic-node--end',
};

/**
 * Catch-all node for workflow node types that don't have a dedicated component
 * (e.g. "start", "action", "end" created by agents via builtin tools).
 *
 * Start/End nodes render a minimal view (no config panel).
 * Action nodes use BaseWorkflowNode with an expandable config section
 * showing all data fields the agent attached.
 */
export const GenericNode = memo(({ data, id, type }: NodeProps<GenericNodeData>) => {
  const nodeType = type || 'unknown';
  const icon = ICONS[nodeType] || <Package size={14} />;
  const className = CLASS_NAMES[nodeType] || 'generic-node generic-node--unknown';
  const extraFields = Object.entries(data).filter(([k]) => k !== 'label');

  // Start and End nodes: compact, no expandable config
  if (nodeType === 'start' || nodeType === 'end') {
    return (
      <div className={className}>
        {nodeType !== 'start' && <Handle type="target" position={Position.Top} />}
        <div className="node-header">
          <span className="node-icon">{icon}</span>
          <span className="node-label">{data.label || nodeType}</span>
        </div>
        {nodeType !== 'end' && <Handle type="source" position={Position.Bottom} />}
      </div>
    );
  }

  // Action / unknown nodes: full BaseWorkflowNode with expandable config
  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon={icon}
      fallbackLabel={nodeType}
      className={className}
    >
      {extraFields.length > 0 ? (
        extraFields.map(([key, value]) => (
          <div className="node-field" key={key}>
            <label>{key}</label>
            {typeof value === 'string' ? (
              <input
                type="text"
                defaultValue={value}
                className="node-input"
                readOnly
              />
            ) : (
              <textarea
                defaultValue={JSON.stringify(value, null, 2)}
                className="node-textarea"
                rows={3}
                readOnly
              />
            )}
          </div>
        ))
      ) : (
        <div className="node-field">
          <span style={{ opacity: 0.5, fontSize: '11px' }}>No configuration</span>
        </div>
      )}
    </BaseWorkflowNode>
  );
});

GenericNode.displayName = 'GenericNode';
