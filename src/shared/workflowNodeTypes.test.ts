import { describe, it, expect } from 'vitest';
import {
  isWorkflowNodeType,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_NODE_SPECS,
  describeNodeType,
  validateNodeData,
} from './workflowNodeTypes';

describe('isWorkflowNodeType', () => {
  it('accepts canonical names', () => {
    for (const name of WORKFLOW_NODE_TYPES) {
      expect(isWorkflowNodeType(name)).toBe(true);
    }
  });

  it('rejects non-canonical names', () => {
    expect(isWorkflowNodeType('transform')).toBe(false);
    expect(isWorkflowNodeType('trigger')).toBe(false);
    expect(isWorkflowNodeType('httpNode')).toBe(false);
    expect(isWorkflowNodeType('HTTP')).toBe(false);
    expect(isWorkflowNodeType('')).toBe(false);
    expect(isWorkflowNodeType(null)).toBe(false);
    expect(isWorkflowNodeType(undefined)).toBe(false);
    expect(isWorkflowNodeType(42)).toBe(false);
  });
});

describe('WORKFLOW_NODE_SPECS', () => {
  it('specs every canonical type', () => {
    for (const name of WORKFLOW_NODE_TYPES) {
      expect(WORKFLOW_NODE_SPECS[name]).toBeDefined();
      expect(WORKFLOW_NODE_SPECS[name].summary.length).toBeGreaterThan(0);
    }
  });

  it('renders a type as one reference line', () => {
    const line = describeNodeType('http');
    expect(line).toContain('HTTP request');
    expect(line).toContain('url: string');
    // Optional fields carry the `?` marker.
    expect(line).toContain('method?:');
  });

  it('renders markerless types with an empty data object', () => {
    expect(describeNodeType('start')).toContain('data: {}');
  });
});

describe('validateNodeData', () => {
  it('accepts a node carrying its required fields', () => {
    expect(validateNodeData('code', { label: 'Crunch', code: 'return 1' })).toBeNull();
    expect(validateNodeData('start', {})).toBeNull();
  });

  it('names the missing field and restates the shape', () => {
    const message = validateNodeData('code', { label: 'Crunch' });
    expect(message).toContain('`code`');
    // The correction travels with the rejection — that is what lets the
    // grammar stay off the wire.
    expect(message).toContain('language?:');
    expect(message).toContain('run a script in a subprocess');
  });

  it('treats an empty string as missing', () => {
    expect(validateNodeData('http', { label: 'Fetch', url: '' })).toContain('`url`');
  });

  it('reports every missing required field at once', () => {
    const message = validateNodeData('conditional', { label: 'Branch' });
    expect(message).toContain('`condition`');
    expect(message).toContain('`operator`');
  });

  it('ignores absent optional fields', () => {
    expect(validateNodeData('delay', { label: 'Wait' })).toBeNull();
    expect(validateNodeData('break', { label: 'Stop' })).toBeNull();
  });
});
