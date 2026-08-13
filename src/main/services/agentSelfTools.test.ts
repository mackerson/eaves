import { describe, it, expect, vi, beforeEach } from 'vitest';

const { agentRepo } = vi.hoisted(() => ({
  agentRepo: {
    getById: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../repositories', () => ({
  getAgentRepository: () => agentRepo,
}));

import { createAgentSelfTools } from './agentSelfTools';
import { DEFAULT_CHANNEL_BEHAVIOR } from '../types';

const exec = async (tool: { execute?: (...args: any[]) => any }, args: unknown = {}) =>
  tool.execute!(args as never, {} as never);

describe('createAgentSelfTools', () => {
  const agentId = 'agent-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('get_my_channel_behavior fails when agent missing', async () => {
    agentRepo.getById.mockReturnValue(null);
    const tools = createAgentSelfTools(agentId);
    expect(await exec(tools.get_my_channel_behavior)).toEqual({
      success: false,
      error: 'Agent not found',
    });
  });

  it.each([
    ['mentions-only', 'brief', 'You only respond when @mentioned', 'Keep responses to 1-3 sentences'],
    ['all', 'normal', 'You respond to all messages', 'Normal conversational length'],
    ['all', 'verbose', 'You respond to all messages', 'Detailed, thorough responses'],
  ] as const)(
    'get_my_channel_behavior describes respondTo=%s verbosity=%s',
    async (respondTo, verbosity, respondDesc, verbDesc) => {
      agentRepo.getById.mockReturnValue({
        id: agentId,
        channelBehavior: { respondTo, verbosity },
      });
      const tools = createAgentSelfTools(agentId);
      const result = await exec(tools.get_my_channel_behavior);
      expect(result.success).toBe(true);
      expect(result.channelBehavior).toEqual({ respondTo, verbosity });
      expect(result.description.respondTo).toContain(respondDesc.includes('only') ? 'only' : 'all');
      expect(result.description.verbosity).toBe(verbDesc);
    },
  );

  it('get falls back to DEFAULT_CHANNEL_BEHAVIOR when unset', async () => {
    agentRepo.getById.mockReturnValue({ id: agentId });
    const tools = createAgentSelfTools(agentId);
    const result = await exec(tools.get_my_channel_behavior);
    expect(result.channelBehavior).toEqual(DEFAULT_CHANNEL_BEHAVIOR);
  });

  it('update_my_channel_behavior merges partial updates', async () => {
    agentRepo.getById.mockReturnValue({
      id: agentId,
      channelBehavior: { respondTo: 'mentions-only', verbosity: 'brief' },
    });
    const tools = createAgentSelfTools(agentId);
    const result = await exec(tools.update_my_channel_behavior, { verbosity: 'verbose' });
    expect(result).toEqual({
      success: true,
      channelBehavior: { respondTo: 'mentions-only', verbosity: 'verbose' },
    });
    expect(agentRepo.update).toHaveBeenCalledWith(agentId, {
      channelBehavior: { respondTo: 'mentions-only', verbosity: 'verbose' },
    });
  });

  it('update fails when agent missing', async () => {
    agentRepo.getById.mockReturnValue(null);
    const tools = createAgentSelfTools(agentId);
    expect(await exec(tools.update_my_channel_behavior, { respondTo: 'all' })).toEqual({
      success: false,
      error: 'Agent not found',
    });
  });
});
