import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({
  eventBus: { emitEvent: vi.fn(), onEvent: vi.fn() },
}));

import { PendingApprovalRegistry } from './PendingApprovalRegistry';

describe('PendingApprovalRegistry', () => {
  let registry: PendingApprovalRegistry;

  beforeEach(() => {
    registry = new PendingApprovalRegistry();
  });

  it('generates unique approval ids', () => {
    const a = registry.generateApprovalId();
    const b = registry.generateApprovalId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^appr_/);
  });

  it('round-trips an entry through register → get', () => {
    const entry = registry.register({
      approvalId: 'appr_x',
      toolCallId: 'call_1',
      toolName: 'bash',
      input: { command: 'ls' },
      context: 'chat',
      contextId: 'chat_a',
      agentId: 'agent_1',
      messageId: 'msg_1',
    });

    expect(entry.createdAt).toBeGreaterThan(0);
    const fetched = registry.get('appr_x');
    expect(fetched?.toolName).toBe('bash');
    expect(fetched?.context).toBe('chat');
  });

  it('resolve removes the entry and returns it', () => {
    registry.register({
      approvalId: 'appr_y',
      toolCallId: 'call_2',
      toolName: 'execute_code',
      input: {},
      context: 'channel',
      contextId: 'chan_a',
      agentId: 'agent_1',
      messageId: 'msg_2',
    });

    const resolved = registry.resolve('appr_y');
    expect(resolved?.approvalId).toBe('appr_y');
    expect(registry.get('appr_y')).toBeUndefined();
  });

  it('listForContext filters by context+contextId', () => {
    registry.register({
      approvalId: 'a1', toolCallId: 'c1', toolName: 'bash', input: {},
      context: 'chat', contextId: 'X', agentId: 'g', messageId: 'm1',
    });
    registry.register({
      approvalId: 'a2', toolCallId: 'c2', toolName: 'bash', input: {},
      context: 'chat', contextId: 'Y', agentId: 'g', messageId: 'm2',
    });
    registry.register({
      approvalId: 'a3', toolCallId: 'c3', toolName: 'bash', input: {},
      context: 'channel', contextId: 'X', agentId: 'g', messageId: 'm3',
    });

    expect(registry.listForContext('chat', 'X').map(e => e.approvalId)).toEqual(['a1']);
    expect(registry.listForContext('channel', 'X').map(e => e.approvalId)).toEqual(['a3']);
    expect(registry.listForContext('chat', 'Z')).toEqual([]);
  });

  it('listAll returns every entry', () => {
    registry.register({
      approvalId: 'a1', toolCallId: 'c1', toolName: 'bash', input: {},
      context: 'chat', contextId: 'X', agentId: 'g', messageId: 'm1',
    });
    registry.register({
      approvalId: 'a2', toolCallId: 'c2', toolName: 'bash', input: {},
      context: 'channel', contextId: 'Y', agentId: 'g', messageId: 'm2',
    });
    expect(registry.listAll()).toHaveLength(2);
  });

  it('clear empties the registry', () => {
    registry.register({
      approvalId: 'a1', toolCallId: 'c1', toolName: 'bash', input: {},
      context: 'chat', contextId: 'X', agentId: 'g', messageId: 'm1',
    });
    registry.clear();
    expect(registry.listAll()).toEqual([]);
  });
});
