import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { stripApprovalRequiredTools } from './toolGating';
import type { Tool } from 'ai';

const fakeTool = (extras: Record<string, unknown> = {}): Tool =>
  ({ description: 'test', inputSchema: {}, execute: async () => ({}), ...extras }) as unknown as Tool;

describe('stripApprovalRequiredTools', () => {
  it('returns undefined input untouched', () => {
    expect(stripApprovalRequiredTools(undefined, 'test')).toBeUndefined();
  });

  it('passes through tools with no needsApproval', () => {
    const tools = { foo: fakeTool(), bar: fakeTool() };
    expect(stripApprovalRequiredTools(tools, 'test')).toEqual(tools);
  });

  it('strips tools with needsApproval: true', () => {
    const tools = {
      bash: fakeTool({ needsApproval: true }),
      list_tasks: fakeTool({ needsApproval: false }),
      web_fetch: fakeTool(),
    };
    const out = stripApprovalRequiredTools(tools, 'test');
    expect(Object.keys(out!).sort()).toEqual(['list_tasks', 'web_fetch']);
  });

  it('strips tools with function-form needsApproval (conservative — could return true)', () => {
    const tools = {
      maybe_dangerous: fakeTool({ needsApproval: () => false }),
      safe: fakeTool(),
    };
    const out = stripApprovalRequiredTools(tools, 'test');
    expect(Object.keys(out!)).toEqual(['safe']);
  });

  it('keeps tools with needsApproval: false', () => {
    const tools = {
      explicit_safe: fakeTool({ needsApproval: false }),
    };
    expect(stripApprovalRequiredTools(tools, 'test')).toEqual(tools);
  });

  it('returns an empty object when every tool is stripped', () => {
    const tools = {
      a: fakeTool({ needsApproval: true }),
      b: fakeTool({ needsApproval: () => true }),
    };
    expect(stripApprovalRequiredTools(tools, 'test')).toEqual({});
  });
});
