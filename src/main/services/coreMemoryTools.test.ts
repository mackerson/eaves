import { describe, it, expect, vi, beforeEach } from 'vitest';

const { blockRepo } = vi.hoisted(() => ({
  blockRepo: {
    setValue: vi.fn(),
    append: vi.fn(),
  },
}));

vi.mock('../repositories', () => ({
  getMemoryBlockRepository: () => blockRepo,
}));

import { createCoreMemoryTools } from './coreMemoryTools';

const exec = async (tool: { execute?: (...args: any[]) => any }, args: unknown) =>
  tool.execute!(args as never, {} as never);

describe('createCoreMemoryTools', () => {
  const agentId = 'agent-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('core_memory_replace succeeds and reports length/limit', async () => {
    blockRepo.setValue.mockReturnValue({
      label: 'human',
      value: 'Robin',
      char_limit: 2000,
    });
    const tools = createCoreMemoryTools(agentId);
    expect(await exec(tools.core_memory_replace, { label: 'human', value: 'Robin' })).toEqual({
      success: true,
      label: 'human',
      length: 5,
      charLimit: 2000,
    });
    expect(blockRepo.setValue).toHaveBeenCalledWith(agentId, 'human', 'Robin');
  });

  it('core_memory_replace fails on read-only block', async () => {
    blockRepo.setValue.mockReturnValue(null);
    const tools = createCoreMemoryTools(agentId);
    expect(await exec(tools.core_memory_replace, { label: 'persona', value: 'x' })).toEqual({
      success: false,
      message: 'Block "persona" is read-only',
    });
  });

  it('core_memory_append succeeds and fails read-only', async () => {
    blockRepo.append.mockReturnValueOnce({
      label: 'current_focus',
      value: 'a\nb',
      char_limit: 2000,
    });
    const tools = createCoreMemoryTools(agentId);
    expect(await exec(tools.core_memory_append, { label: 'current_focus', text: 'b' })).toEqual({
      success: true,
      label: 'current_focus',
      length: 3,
      charLimit: 2000,
    });

    blockRepo.append.mockReturnValueOnce(null);
    expect(await exec(tools.core_memory_append, { label: 'locked', text: 'x' })).toEqual({
      success: false,
      message: 'Block "locked" is read-only',
    });
  });
});
