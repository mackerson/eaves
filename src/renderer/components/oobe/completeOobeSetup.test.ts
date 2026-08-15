import { describe, it, expect, beforeEach, vi } from 'vitest';
import { completeOobeSetup, buildTourKickoff } from './completeOobeSetup';

const params = {
  userName: 'Robin',
  guidedTour: false,
  providerConfig: {
    provider: 'anthropic' as const,
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-5',
    availableModels: [],
  },
  agentConfig: {
    name: 'Atlas',
    description: 'A research partner',
    systemPrompt: 'You are Atlas.',
    temperature: 0.7,
    color: '#667eea',
  },
};

describe('completeOobeSetup', () => {
  beforeEach(() => {
    vi.mocked(window.electron.updateSettings).mockReset().mockResolvedValue({} as any);
    vi.mocked(window.electron.createAgent).mockReset().mockResolvedValue({ id: 'agent-1' } as any);
    vi.mocked(window.electron.switchAgent).mockReset().mockResolvedValue({ success: true } as any);
    (window.electron as any).completeOobe = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).createChat = vi.fn().mockResolvedValue({ success: true, chat: { id: 'chat-1' } });
    (window.electron as any).sendChatMessage = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).switchChat = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).logError = vi.fn();
  });

  it('saves the key, creates the agent, pins the defaults, then completes', async () => {
    const result = await completeOobeSetup(params);

    expect(result).toEqual({ agentId: 'agent-1', tourChatId: null });
    expect(window.electron.createChat).not.toHaveBeenCalled();
    expect(window.electron.updateSettings).toHaveBeenNthCalledWith(1, {
      userName: 'Robin',
      apiKeys: { anthropic: 'sk-ant-test' },
    });
    expect(window.electron.switchAgent).toHaveBeenCalledWith('agent-1');
    expect(window.electron.updateSettings).toHaveBeenNthCalledWith(2, {
      defaultAgentId: 'agent-1',
      systemAgentId: 'agent-1',
    });
    expect(window.electron.completeOobe).toHaveBeenCalled();
  });

  // The exact bug: step 1 is one Zod object, so an over-long name rejects the
  // API key with it. The handler resolves rather than rejecting, so the old
  // code created the agent anyway and marked OOBE done — leaving a first-run
  // user with an agent pointed at a provider that has no credential.
  it('aborts without completing when the settings patch is rejected', async () => {
    vi.mocked(window.electron.updateSettings).mockResolvedValue({
      success: false,
      error: 'User name must be less than 50 characters',
    } as any);

    await expect(completeOobeSetup(params)).rejects.toThrow(
      'Saving your provider key: User name must be less than 50 characters',
    );
    expect(window.electron.createAgent).not.toHaveBeenCalled();
    expect(window.electron.completeOobe).not.toHaveBeenCalled();
  });

  it('aborts without completing when agent creation is rejected', async () => {
    vi.mocked(window.electron.createAgent).mockResolvedValue({
      success: false,
      error: 'description too long',
    } as any);

    await expect(completeOobeSetup(params)).rejects.toThrow('Creating your agent: description too long');
    expect(window.electron.switchAgent).not.toHaveBeenCalled();
    expect(window.electron.completeOobe).not.toHaveBeenCalled();
  });

  // Without the explicit id check, `switchAgent(undefined)` and both default
  // writes no-op and OOBE still completes — with zero agents in the app.
  it('aborts when agent creation returns something with no id', async () => {
    vi.mocked(window.electron.createAgent).mockResolvedValue(undefined as any);

    await expect(completeOobeSetup(params)).rejects.toThrow('no agent was returned');
    expect(window.electron.completeOobe).not.toHaveBeenCalled();
  });
});

describe('completeOobeSetup: guided tour', () => {
  const tourParams = { ...params, guidedTour: true };

  beforeEach(() => {
    vi.mocked(window.electron.updateSettings).mockReset().mockResolvedValue({} as any);
    vi.mocked(window.electron.createAgent).mockReset().mockResolvedValue({ id: 'agent-1' } as any);
    vi.mocked(window.electron.switchAgent).mockReset().mockResolvedValue({ success: true } as any);
    (window.electron as any).completeOobe = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).createChat = vi.fn().mockResolvedValue({ success: true, chat: { id: 'chat-1' } });
    (window.electron as any).sendChatMessage = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).switchChat = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).logError = vi.fn();
  });

  it('opens a first chat, posts the kickoff, and selects it', async () => {
    const result = await completeOobeSetup(tourParams);

    expect(result.tourChatId).toBe('chat-1');
    expect(window.electron.createChat).toHaveBeenCalledWith({
      name: 'Getting started',
      agentId: 'agent-1',
    });
    expect(window.electron.sendChatMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      content: buildTourKickoff('Robin'),
    });
    expect(window.electron.switchChat).toHaveBeenCalledWith('chat-1');
  });

  // Deliberately does NOT start the agent's turn — the caller reloads app state
  // first so the chat view is mounted for the stream.
  it('leaves starting the agent turn to the caller', async () => {
    (window.electron as any).chatWithAgent = vi.fn();

    await completeOobeSetup(tourParams);

    expect(window.electron.chatWithAgent).not.toHaveBeenCalled();
  });

  // The tour is a convenience, not part of a working install. Failing here
  // would strand the user at the last step of the wizard over something a
  // single click in the app would redo.
  it('still finishes setup when the tour chat cannot be created', async () => {
    (window.electron as any).createChat = vi.fn().mockResolvedValue({
      success: false,
      error: 'no current user',
    });

    const result = await completeOobeSetup(tourParams);

    expect(result).toEqual({ agentId: 'agent-1', tourChatId: null });
    expect(window.electron.completeOobe).toHaveBeenCalled();
    expect(window.electron.logError).toHaveBeenCalled();
  });

  it('still finishes setup when the kickoff message is rejected', async () => {
    (window.electron as any).sendChatMessage = vi.fn().mockResolvedValue({
      success: false,
      error: 'Message is too long',
    });

    const result = await completeOobeSetup(tourParams);

    expect(result.tourChatId).toBeNull();
    expect(window.electron.completeOobe).toHaveBeenCalled();
  });

  it('addresses the user by name and points at the guide tool', () => {
    const kickoff = buildTourKickoff('Robin');
    expect(kickoff).toContain('Robin');
    expect(kickoff).toContain('eaves_guide');
  });
});
