import { describe, it, expect } from 'vitest';
import { describeActivity, humanizeEventType } from './activityLabels';

describe('humanizeEventType', () => {
  // The old fallback was `type.split(':').pop()`, which threw away the
  // namespace — the informative half — and left a sidebar of bare verbs.
  it('keeps the subject for namespaced types', () => {
    expect(humanizeEventType('routine:execution:started')).toBe('Routine execution started');
    expect(humanizeEventType('workflow:blocked:pending-review')).toBe('Workflow blocked pending review');
  });

  it('never degrades to a bare verb', () => {
    for (const type of ['routine:execution:started', 'workflow:execution:failed']) {
      expect(['started', 'failed']).not.toContain(humanizeEventType(type).toLowerCase());
    }
  });

  it('survives malformed types', () => {
    expect(humanizeEventType('ready')).toBe('Ready');
    expect(humanizeEventType('')).toBe('');
    expect(humanizeEventType(':::')).toBe(':::');
  });
});

describe('describeActivity', () => {
  it('names the routine instead of just saying a routine ran', () => {
    const d = describeActivity({
      type: 'routine:execution:started',
      data: { routineId: 'r1', routineName: 'HMD BG Collector' },
    });
    expect(d.label).toBe('Routine started');
    expect(d.subject).toBe('HMD BG Collector');
    expect(d.text).toBe('Routine started — HMD BG Collector');
  });

  it('leads with the agent when the agent is the actor', () => {
    const d = describeActivity({
      type: 'workflow:node:completed',
      data: { nodeType: 'agent', agentId: 'a1', agentName: 'Ninja' },
    });
    expect(d.text).toBe('Ninja — Step finished');
  });

  it('falls back to the label alone when the row names nothing', () => {
    const d = describeActivity({ type: 'app:ready', data: undefined });
    expect(d.subject).toBeUndefined();
    expect(d.text).toBe('App started');
  });

  it('ignores non-string subject values rather than rendering [object Object]', () => {
    const d = describeActivity({ type: 'task:created', data: { name: { nested: true } } });
    expect(d.subject).toBeUndefined();
    expect(d.text).toBe('Task created');
  });

  it('renders every event type that actually fires as prose, never a raw slug', () => {
    for (const type of [
      'routine:execution:started', 'routine:execution:completed', 'routine:execution:failed',
      'workflow:execution:started', 'workflow:execution:failed', 'workflow:node:completed',
      'approval:requested', 'approval:resolved', 'chat:aborted', 'chat:complete',
      'code-execution:start', 'messaging:bridge:error', 'task:created', 'message:created',
    ]) {
      const { label } = describeActivity({ type, data: undefined });
      expect(label).not.toContain(':');
      expect(label).not.toMatch(/[-_]/);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
