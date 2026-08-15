/**
 * Sink nodes — the node types that deliver a result out of the workflow.
 *
 * Grouped in one file because they are the same shape with a different
 * destination, and they only differ from each other by the config form they
 * render.
 */

import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { NoteNodeConfig, TaskNodeConfig } from './configs';

export const NoteNode = memo(({ data, id }: NodeProps<Record<string, any>>) => (
  <BaseWorkflowNode id={id} data={data} icon="📝" fallbackLabel="Save note" className="note-node">
    <NoteNodeConfig id={id} data={data} />
  </BaseWorkflowNode>
));
NoteNode.displayName = 'NoteNode';

export const TaskNode = memo(({ data, id }: NodeProps<Record<string, any>>) => (
  <BaseWorkflowNode id={id} data={data} icon="✅" fallbackLabel="Create task" className="task-node">
    <TaskNodeConfig id={id} data={data} />
  </BaseWorkflowNode>
));
TaskNode.displayName = 'TaskNode';
