import { describe, it, expect } from 'vitest';
import { buildDemoWorkflow } from './WorkflowEditor';
import { WORKFLOW_NODE_TYPES, isWorkflowNodeType } from '@shared/workflowNodeTypes';

// Regression coverage for the stale 'transformNode' bug: the shipped "Load
// Demo" workflow used a node type ('transformNode') that existed nowhere
// else in the codebase — not in WORKFLOW_NODE_TYPES, not in the editor's own
// `nodeTypes` React Flow registry, no executor handler — plus a `script`
// data field the real `code` node never reads (it reads `code`).
// WorkflowExecutor's switch used to silently report success for any
// unhandled node type, so this never surfaced until it was made to throw.
// This test pins the demo template to only ever emit node types the
// executor can actually run.
describe('buildDemoWorkflow', () => {
  it('only emits node types the executor recognizes (WORKFLOW_NODE_TYPES)', () => {
    const { nodes } = buildDemoWorkflow();

    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(isWorkflowNodeType(node.type)).toBe(true);
    }
  });

  it('does not emit the stale transformNode type', () => {
    const { nodes } = buildDemoWorkflow();
    expect(nodes.some(n => n.type === 'transformNode')).toBe(false);
  });

  it('does not emit React Flow built-in input/output types (uses canonical start/end)', () => {
    const { nodes } = buildDemoWorkflow();
    const types = nodes.map(n => n.type);
    expect(types).not.toContain('input');
    expect(types).not.toContain('output');
  });

  it('gives the code node a `code` field, not the stale `script` field', () => {
    const { nodes } = buildDemoWorkflow();
    const transformNode = nodes.find(n => n.id === 'transform-success');

    expect(transformNode?.type).toBe('code');
    expect(transformNode?.data.code).toBeTruthy();
    expect(transformNode?.data.script).toBeUndefined();
  });

  it('every edge connects nodes that exist in the graph', () => {
    const { nodes, edges } = buildDemoWorkflow();
    const nodeIds = new Set(nodes.map(n => n.id));

    for (const edge of edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });
});

describe('WORKFLOW_NODE_TYPES sanity', () => {
  it('includes start/end/code, which the demo template relies on', () => {
    expect(WORKFLOW_NODE_TYPES).toContain('start');
    expect(WORKFLOW_NODE_TYPES).toContain('end');
    expect(WORKFLOW_NODE_TYPES).toContain('code');
  });
});
