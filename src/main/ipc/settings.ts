import { ipcMain, dialog, BrowserWindow } from 'electron';
import { getSettingsRepository } from '../repositories';
import { Settings } from '../types';
import { PROVIDERS, ProviderId } from '../../shared/providers';
import { getBackgroundCache } from '../services/BackgroundCache';
import { getEventBus } from '../services/EventBus';
import {
  UpdateSettingsSchema,
  BackgroundUrlSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

/**
 * The settings row carries decrypted provider keys, but this event fans out to
 * the activity feed — which persists `data` verbatim and renders it in the
 * Activity view — and to every plugin holding `events:listen`, which is
 * deliberately type-open (see EventBridge.subscribe). No consumer needs the key
 * material, only whether a provider is configured, so the values never leave
 * the settings repository.
 */
export function redactSettingsForEvent(
  settings: Settings
): Omit<Settings, 'apiKeys'> & { configuredProviders: string[] } {
  const { apiKeys, ...rest } = settings;
  return {
    ...rest,
    configuredProviders: configuredProviderIds(apiKeys),
  };
}

function configuredProviderIds(apiKeys: Settings['apiKeys']): ProviderId[] {
  return (Object.entries(apiKeys ?? {}) as [ProviderId, string | undefined][])
    .filter(([, key]) => typeof key === 'string' && key.length > 0)
    .map(([provider]) => provider);
}

/**
 * The only Settings shape allowed to cross to the renderer.
 *
 * `SettingsRepository.get()` decrypts provider keys, and both renderer-facing
 * paths returned it verbatim — `update-settings` (whose schema is entirely
 * optional, so `updateSettings({})` was a pure read) and `get-memory` at boot.
 * Plugin UI bundles are loaded with a bare dynamic import into the renderer's
 * own realm and are handed `window.electron` deliberately, so any installed
 * plugin could ask for the user's Anthropic/OpenAI keys and get them.
 *
 * Key material is dropped and replaced with the list of providers that have
 * something on file, which is all the renderer ever needed. Local providers
 * (`isLocalEndpoint`) keep their value: that field holds an endpoint URL
 * rather than a credential, and the settings UI has to be able to show and
 * edit it.
 */
export function redactSettingsForRenderer(settings: Settings): Settings {
  const visible: Settings['apiKeys'] = {};
  for (const provider of PROVIDERS) {
    if (!provider.isLocalEndpoint) continue;
    const value = settings.apiKeys?.[provider.id];
    if (value) visible[provider.id] = value;
  }

  return {
    ...settings,
    apiKeys: visible,
    configuredProviders: configuredProviderIds(settings.apiKeys),
  };
}

export function registerSettingsHandlers() {
  const backgroundCache = getBackgroundCache();
  const eventBus = getEventBus();
  ipcMain.handle('update-settings', ipcResult('update-settings', async (_event, settings: Partial<Settings>) => {
    const validation = validateIPC(UpdateSettingsSchema, settings, 'update-settings');
    if (!validation.success) return validation;

    const settingsRepo = getSettingsRepository();
    const updated = settingsRepo.update(validation.data);
    eventBus.emitEvent('settings:updated', redactSettingsForEvent(updated));

    // Embedding config changed → (re)build the vector index in the background.
    if (validation.data.memoryEmbedding !== undefined) {
      import('../services/CoreMemoryBackend')
        .then(m => m.backfillCoreVectors())
        .catch(() => { /* best-effort */ });
    }
    return redactSettingsForRenderer(updated);
  }));

  ipcMain.handle('dialog:pick-background-image', ipcResult('dialog:pick-background-image', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(window!, {
      title: 'Select Background Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const sourcePath = result.filePaths[0];
    const protocolUrl = backgroundCache.cacheLocalFile(sourcePath);
    return { canceled: false, path: protocolUrl || sourcePath };
  }));

  ipcMain.handle('cache-background-url', ipcResult('cache-background-url', async (_event, url: string) => {
    const validation = validateIPC(BackgroundUrlSchema, url, 'cache-background-url');
    if (!validation.success) return validation;

    const protocolUrl = await backgroundCache.cacheUrl(validation.data);
    return { success: !!protocolUrl, path: protocolUrl };
  }));

  ipcMain.handle('get-cached-background', ipcResult('get-cached-background', async (_event, url: string) => {
    const validation = validateIPC(BackgroundUrlSchema, url, 'get-cached-background');
    if (!validation.success) return { cached: false, error: validation.error };

    const protocolUrl = backgroundCache.getCached(validation.data);
    return { cached: !!protocolUrl, path: protocolUrl };
  }));

  ipcMain.handle('clear-background-cache', ipcResult('clear-background-cache', async () => {
    backgroundCache.clearCache();
    return { success: true };
  }));
}
