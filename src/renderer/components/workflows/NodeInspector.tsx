/**
 * Config surface for the selected node, at a size you can actually read.
 *
 * The inline config inside a node is capped by the node's footprint on the
 * canvas, which is unworkable for a multi-kilobyte prompt or a block of Python.
 * This renders the same field definitions (see nodes/configs.tsx) full-height
 * beside the canvas, and every long-form field can still go fullscreen from
 * here.
 */

import { Node } from 'reactflow';
import { MousePointerSquareDashed } from 'lucide-react';
import { configForNodeType } from './nodes/configs';
import { NodeTextField } from './nodes/fields';
import { useNodeFieldWriter } from './nodes/fields';

interface NodeInspectorProps {
  node: Node | null;
}

function InspectorBody({ node }: { node: Node }) {
  const write = useNodeFieldWriter(node.id);
  const Config = configForNodeType(node.type);

  return (
    <>
      <div className="node-inspector-header">
        <span className="node-inspector-type">{node.type || 'node'}</span>
        <span className="node-inspector-id">{node.id}</span>
      </div>

      <div className="node-inspector-fields">
        <NodeTextField
          label="Name"
          value={(node.data?.label as string) || ''}
          onChange={(value) => write('label', value)}
          placeholder="What this step does"
          help="Shown on the node. Agent-authored graphs often leave this empty."
        />
        <Config id={node.id} data={node.data || {}} />
      </div>
    </>
  );
}

export function NodeInspector({ node }: NodeInspectorProps) {
  return (
    <div className="node-inspector">
      {node ? (
        // Keyed on id so switching nodes remounts the fields rather than
        // carrying the previous node's uncommitted local state across.
        <InspectorBody key={node.id} node={node} />
      ) : (
        <div className="node-inspector-empty">
          <MousePointerSquareDashed size={28} aria-hidden />
          <p>Select a node to edit it here.</p>
        </div>
      )}
    </div>
  );
}
