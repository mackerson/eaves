import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAgentStore } from './useAgentStore';
import { useToastStore } from './useToastStore';

describe('useAgentStore', () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: [],
      currentAgentId: null,
      editingAgentId: null,
      showMCPModal: false,
    });
    useToastStore.setState({ toasts: [] });
    vi.mocked(window.electron.createAgent).mockReset();
    vi.mocked(window.electron.updateAgent).mockReset();
    vi.mocked(window.electron.deleteAgent).mockReset();
    vi.mocked(window.electron.switchAgent).mockReset();
  });

  it('setAgents / setCurrentAgentId / getCurrentAgent', () => {
    const agents = [
      { id: 'a1', name: 'One' },
      { id: 'a2', name: 'Two' },
    ] as any;
    useAgentStore.getState().setAgents(agents);
    useAgentStore.getState().setCurrentAgentId('a2');
    expect(useAgentStore.getState().getCurrentAgent()?.name).toBe('Two');
  });

  it('createAgent throws on envelope failure and does not add a fake row', async () => {
    vi.mocked(window.electron.createAgent).mockResolvedValue({
      success: false,
      error: 'invalid model',
    } as any);
    await expect(
      useAgentStore.getState().createAgent({ name: 'X' } as any),
    ).rejects.toThrow('invalid model');
    expect(useAgentStore.getState().agents).toHaveLength(0);
  });

  it('createAgent appends and selects the new agent on success', async () => {
    const created = { id: 'a-new', name: 'Nova' };
    vi.mocked(window.electron.createAgent).mockResolvedValue(created as any);
    await useAgentStore.getState().createAgent({ name: 'Nova' } as any);
    expect(useAgentStore.getState().agents).toEqual([created]);
    expect(useAgentStore.getState().currentAgentId).toBe('a-new');
  });

  it('updateAgent throws on envelope; replaces row on success', async () => {
    useAgentStore.setState({
      agents: [{ id: 'a1', name: 'Old' } as any],
      currentAgentId: 'a1',
      editingAgentId: null,
      showMCPModal: false,
    });
    vi.mocked(window.electron.updateAgent).mockResolvedValueOnce({
      success: false,
      error: 'nope',
    } as any);
    await expect(
      useAgentStore.getState().updateAgent('a1', { name: 'X' }),
    ).rejects.toThrow('nope');

    vi.mocked(window.electron.updateAgent).mockResolvedValueOnce({
      id: 'a1',
      name: 'New',
    } as any);
    await useAgentStore.getState().updateAgent('a1', { name: 'New' });
    expect(useAgentStore.getState().agents[0].name).toBe('New');
  });

  it('deleteAgent removes and clears current when deleting selection', async () => {
    useAgentStore.setState({
      agents: [{ id: 'a1', name: 'A' } as any, { id: 'a2', name: 'B' } as any],
      currentAgentId: 'a1',
      editingAgentId: null,
      showMCPModal: false,
    });
    vi.mocked(window.electron.deleteAgent).mockResolvedValue(undefined as any);
    await useAgentStore.getState().deleteAgent('a1');
    expect(useAgentStore.getState().agents.map((a) => a.id)).toEqual(['a2']);
    expect(useAgentStore.getState().currentAgentId).toBeNull();
  });

  it('deleteAgent toasts on failure without mutating list', async () => {
    useAgentStore.setState({
      agents: [{ id: 'a1', name: 'A' } as any],
      currentAgentId: 'a1',
      editingAgentId: null,
      showMCPModal: false,
    });
    vi.mocked(window.electron.deleteAgent).mockRejectedValue(new Error('boom'));
    await useAgentStore.getState().deleteAgent('a1');
    expect(useAgentStore.getState().agents).toHaveLength(1);
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true);
  });

  it('switchAgent sets current on success; toasts on failure', async () => {
    vi.mocked(window.electron.switchAgent).mockResolvedValueOnce(undefined as any);
    await useAgentStore.getState().switchAgent('a9');
    expect(useAgentStore.getState().currentAgentId).toBe('a9');

    vi.mocked(window.electron.switchAgent).mockRejectedValueOnce(new Error('x'));
    await useAgentStore.getState().switchAgent('a10');
    expect(useAgentStore.getState().currentAgentId).toBe('a9');
    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });

  it('openMCPModal / closeMCPModal toggle UI state', () => {
    useAgentStore.getState().openMCPModal('a1');
    expect(useAgentStore.getState()).toMatchObject({
      showMCPModal: true,
      editingAgentId: 'a1',
    });
    useAgentStore.getState().closeMCPModal();
    expect(useAgentStore.getState()).toMatchObject({
      showMCPModal: false,
      editingAgentId: null,
    });
  });
});
