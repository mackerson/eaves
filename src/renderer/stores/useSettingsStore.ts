import { create } from 'zustand';
import { Settings } from '@/types';
import { ProviderId } from '@shared/providers';

interface SettingsState {
  // State
  settings: Settings;
  // True once setSettings has been called with the real settings from the
  // main process. The OOBE gate in App.tsx needs to distinguish "settings
  // not yet loaded" from "user hasn't completed OOBE" — without this, the
  // wizard flashes on every cold start before getMemory() resolves.
  settingsHydrated: boolean;

  // Actions
  setSettings: (settings: Settings) => void;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;
  updateUserName: (userName: string) => void;
  updateApiKey: (provider: keyof Settings['apiKeys'], key: string) => void;

  // Helpers
  hasApiKey: (provider: keyof Settings['apiKeys']) => boolean;
}

// Merge an apiKeys patch onto the cached map instead of replacing it, so a
// partial update (only the changed provider) doesn't drop the other keys from
// the renderer cache. Mirrors SettingsRepository: '' / undefined clears a key.
//
// Note this cache only ever holds what the renderer legitimately has: endpoint
// URLs for local providers, plus whatever the user typed this session. Secret
// credentials never arrive from the main process (redactSettingsForRenderer),
// so `configuredProviders` — not this map — answers "is this provider set up".
function mergeApiKeys(
  existing: Settings['apiKeys'],
  patch: Settings['apiKeys'],
): Settings['apiKeys'] {
  const next: Settings['apiKeys'] = { ...existing };
  for (const id of Object.keys(patch) as (keyof Settings['apiKeys'])[]) {
    const value = patch[id];
    if (value === undefined || value === '') {
      delete next[id];
    } else {
      next[id] = value;
    }
  }
  return next;
}

// Apply the same patch to the configured list, so a save takes effect without
// waiting for a reload to re-hydrate it from the main process.
function mergeConfiguredProviders(
  existing: Settings['configuredProviders'],
  patch: Settings['apiKeys'],
): ProviderId[] {
  const next = new Set<ProviderId>(existing ?? []);
  for (const id of Object.keys(patch) as ProviderId[]) {
    const value = patch[id];
    if (value === undefined || value === '') {
      next.delete(id);
    } else {
      next.add(id);
    }
  }
  return [...next];
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  // Initial state
  settings: {
    userName: 'User',
    apiKeys: {},
  },
  settingsHydrated: false,

  // State setters
  setSettings: (settings) => set({ settings, settingsHydrated: true }),

  // Settings operations. Send only the partial to the main process so
  // unchanged fields (oobeCompleted, theme, etc.) don't tag along on every
  // write; merge locally for the renderer cache.
  updateSettings: async (updates) => {
    // update-settings resolves to the full Settings on success, or a
    // { success: false, error } envelope on validation/handler failure —
    // ipcResult swallows the throw so the promise never rejects. Detect the
    // envelope and throw, so callers' catch fires (error toast) and we don't
    // merge rejected data into the cache.
    const result = await window.electron.updateSettings(updates);
    if (
      result &&
      typeof result === 'object' &&
      'success' in result &&
      (result as { success?: boolean }).success === false
    ) {
      throw new Error(
        (result as { error?: string }).error ?? 'Failed to save settings',
      );
    }
    set((state) => ({
      settings: {
        ...state.settings,
        ...updates,
        // apiKeys arrives as a partial patch; merge rather than replace.
        ...(updates.apiKeys
          ? {
              apiKeys: mergeApiKeys(state.settings.apiKeys, updates.apiKeys),
              configuredProviders: mergeConfiguredProviders(
                state.settings.configuredProviders,
                updates.apiKeys,
              ),
            }
          : {}),
      },
    }));
  },

  updateUserName: (userName) => {
    set((state) => ({
      settings: { ...state.settings, userName },
    }));
  },

  updateApiKey: (provider, key) => {
    set((state) => ({
      settings: {
        ...state.settings,
        apiKeys: { ...state.settings.apiKeys, [provider]: key },
        configuredProviders: mergeConfiguredProviders(
          state.settings.configuredProviders,
          { [provider]: key },
        ),
      },
    }));
  },

  // Helpers
  hasApiKey: (provider) => {
    const { settings } = get();
    // configuredProviders is authoritative: credentials are redacted out of
    // apiKeys before they reach the renderer, so a truthiness check on the
    // map alone would report every key-based provider as unconfigured.
    return (settings.configuredProviders ?? []).includes(provider as ProviderId)
      || !!settings.apiKeys[provider];
  },
}));
