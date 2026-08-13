import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: { userName: 'User', apiKeys: {} },
      settingsHydrated: false,
    });
    vi.mocked(window.electron.updateSettings).mockReset();
  });

  it('setSettings hydrates and marks settingsHydrated', () => {
    useSettingsStore.getState().setSettings({
      userName: 'Robin',
      apiKeys: { anthropic: 'sk-a' },
      oobeCompleted: true,
    } as any);
    const state = useSettingsStore.getState();
    expect(state.settings.userName).toBe('Robin');
    expect(state.settingsHydrated).toBe(true);
  });

  it('updateSettings merges apiKeys patches and clears empty values', async () => {
    useSettingsStore.setState({
      settings: {
        userName: 'User',
        apiKeys: { anthropic: 'sk-old', openai: 'sk-oai' },
      },
      settingsHydrated: true,
    });
    vi.mocked(window.electron.updateSettings).mockResolvedValue({
      userName: 'User',
      apiKeys: { anthropic: 'sk-new' },
    } as any);

    await useSettingsStore.getState().updateSettings({
      apiKeys: { anthropic: 'sk-new', openai: '' },
    } as any);

    expect(window.electron.updateSettings).toHaveBeenCalledWith({
      apiKeys: { anthropic: 'sk-new', openai: '' },
    });
    expect(useSettingsStore.getState().settings.apiKeys).toEqual({ anthropic: 'sk-new' });
  });

  it('updateSettings throws on { success: false } envelope without merging', async () => {
    useSettingsStore.setState({
      settings: { userName: 'User', apiKeys: { anthropic: 'sk-keep' } },
      settingsHydrated: true,
    });
    vi.mocked(window.electron.updateSettings).mockResolvedValue({
      success: false,
      error: 'validation failed',
    } as any);

    await expect(
      useSettingsStore.getState().updateSettings({ userName: 'Nope' }),
    ).rejects.toThrow('validation failed');
    expect(useSettingsStore.getState().settings.userName).toBe('User');
    expect(useSettingsStore.getState().settings.apiKeys).toEqual({ anthropic: 'sk-keep' });
  });

  // Credentials are stripped before they reach the renderer, so a provider
  // with a key on file arrives with an empty apiKeys map and its id in
  // configuredProviders. hasApiKey has to read the latter or every key-based
  // provider looks unconfigured after boot.
  it('hasApiKey reports configured providers whose values were redacted', () => {
    useSettingsStore.getState().setSettings({
      userName: 'Robin',
      apiKeys: {},
      configuredProviders: ['anthropic'],
    } as any);

    expect(useSettingsStore.getState().hasApiKey('anthropic')).toBe(true);
    expect(useSettingsStore.getState().hasApiKey('openai')).toBe(false);
  });

  it('updateSettings keeps configuredProviders in step with the patch it sent', async () => {
    useSettingsStore.setState({
      settings: { userName: 'User', apiKeys: {}, configuredProviders: ['anthropic', 'openai'] },
      settingsHydrated: true,
    });
    vi.mocked(window.electron.updateSettings).mockResolvedValue({
      userName: 'User',
      apiKeys: {},
      configuredProviders: ['openrouter'],
    } as any);

    await useSettingsStore.getState().updateSettings({
      apiKeys: { openrouter: 'sk-or', anthropic: '', openai: '' },
    } as any);

    // Saving a key marks it configured without a reload; clearing one unmarks it.
    expect(useSettingsStore.getState().settings.configuredProviders).toEqual(['openrouter']);
    expect(useSettingsStore.getState().hasApiKey('openrouter')).toBe(true);
    expect(useSettingsStore.getState().hasApiKey('anthropic')).toBe(false);
  });

  it('updateUserName / updateApiKey / hasApiKey are local-only helpers', () => {
    useSettingsStore.getState().updateUserName('Pat');
    useSettingsStore.getState().updateApiKey('openai', 'sk-x');
    expect(useSettingsStore.getState().settings.userName).toBe('Pat');
    expect(useSettingsStore.getState().hasApiKey('openai')).toBe(true);
    expect(useSettingsStore.getState().hasApiKey('anthropic')).toBe(false);
  });
});
