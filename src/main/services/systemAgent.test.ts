import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsRepo, agentRepo } = vi.hoisted(() => ({
  settingsRepo: { get: vi.fn() },
  agentRepo: {
    getById: vi.fn(),
    getAll: vi.fn(),
  },
}));

vi.mock('../repositories', () => ({
  getSettingsRepository: () => settingsRepo,
  getAgentRepository: () => agentRepo,
}));

import { resolveSystemAgent } from './systemAgent';

describe('resolveSystemAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsRepo.get.mockReturnValue({});
    agentRepo.getById.mockReturnValue(null);
    agentRepo.getAll.mockReturnValue([]);
  });

  it('prefers settings.systemAgentId when the agent exists', () => {
    const pinned = { id: 'sys', name: 'System' };
    settingsRepo.get.mockReturnValue({ systemAgentId: 'sys', defaultAgentId: 'def' });
    agentRepo.getById.mockImplementation((id: string) => (id === 'sys' ? pinned : null));
    expect(resolveSystemAgent()).toBe(pinned);
    expect(agentRepo.getAll).not.toHaveBeenCalled();
  });

  it('falls through to defaultAgentId when pin is missing or stale', () => {
    const fallback = { id: 'def', name: 'Default' };
    settingsRepo.get.mockReturnValue({ systemAgentId: 'stale', defaultAgentId: 'def' });
    agentRepo.getById.mockImplementation((id: string) => (id === 'def' ? fallback : null));
    expect(resolveSystemAgent()).toBe(fallback);
  });

  it('falls through to first agent in DB when neither pin resolves', () => {
    const first = { id: 'a1', name: 'Only' };
    settingsRepo.get.mockReturnValue({ systemAgentId: 'x', defaultAgentId: 'y' });
    agentRepo.getById.mockReturnValue(null);
    agentRepo.getAll.mockReturnValue([first, { id: 'a2' }]);
    expect(resolveSystemAgent()).toBe(first);
  });

  it('returns null when no agents exist', () => {
    settingsRepo.get.mockReturnValue({});
    agentRepo.getAll.mockReturnValue([]);
    expect(resolveSystemAgent()).toBeNull();
  });
});
