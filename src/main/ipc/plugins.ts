import { ipcMain, BrowserWindow } from 'electron';
import { getSandboxedPluginManager, isHostOwnedEventType } from '../services/sandbox';
import { getPluginConfigManager } from '../services/PluginConfigManager';
import { getServiceRegistry } from '../services/ServiceRegistry';
import { getMarketplaceListing, installPlugin, uninstallPlugin } from '../services/MarketplaceService';
import { eventBus } from '../services/EventBus';
import { logger } from '../services/logger';
import {
  PluginIdSchema,
  PluginEventSchema,
  ExecutePluginToolSchema,
  SetPluginConfigSchema,
  ServiceTypeSchema,
  CallServiceSchema,
  TogglePluginSchema,
  EventFilterSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { rejectUndeclaredConfig } from './pluginConfigPolicy';

export function registerPluginHandlers(getMainWindow?: () => BrowserWindow | null) {
  ipcMain.handle('get-plugins', ipcResult('get-plugins', async () => {
    const pluginManager = getSandboxedPluginManager();
    const pluginsWithState = pluginManager.getPluginsWithState();
    const views = pluginManager.getRegisteredViews();

    return pluginsWithState.map(plugin => {
      const pluginViews = views.filter(v => v.pluginId === plugin.id);
      return {
        ...plugin,
        hasView: pluginViews.length > 0,
        viewId: pluginViews[0]?.id
      };
    });
  }));

  ipcMain.handle('get-plugin-views', ipcResult('get-plugin-views', async () => {
    const pluginManager = getSandboxedPluginManager();
    const views = pluginManager.getRegisteredViews();
    const pluginsWithState = pluginManager.getPluginsWithState();

    const enabledNonImportPlugins = new Set(
      pluginsWithState
        .filter(p => p.enabled && p.type !== 'import')
        .map(p => p.id)
    );

    const filteredViews = views.filter(view => enabledNonImportPlugins.has(view.pluginId));

    const manifests = pluginManager.getLoadedPlugins();
    return filteredViews.map(view => {
      const manifest = manifests.find((m: any) => m.id === view.pluginId);
      return {
        ...view,
        uiMetadata: manifest?.ui,
        folderName: (manifest as any)?.folderName,
        source: (manifest as any)?.source,
      };
    });
  }));

  ipcMain.handle('get-plugin-terminal-views', ipcResult('get-plugin-terminal-views', async () => {
    const pluginManager = getSandboxedPluginManager();
    return pluginManager.getRegisteredTerminalViews();
  }));

  ipcMain.handle('get-import-plugin-views', ipcResult('get-import-plugin-views', async () => {
    const pluginManager = getSandboxedPluginManager();
    const views = pluginManager.getRegisteredViews();
    const pluginsWithState = pluginManager.getPluginsWithState();

    const enabledImportPlugins = new Set(
      pluginsWithState
        .filter(p => p.enabled && p.type === 'import')
        .map(p => p.id)
    );

    const importViews = views.filter(view => enabledImportPlugins.has(view.pluginId));

    const manifests = pluginManager.getLoadedPlugins();
    return importViews.map(view => {
      const manifest = manifests.find((m: any) => m.id === view.pluginId);
      const plugin = pluginsWithState.find(p => p.id === view.pluginId);
      return {
        ...view,
        uiMetadata: manifest?.ui,
        folderName: (manifest as any)?.folderName,
        source: (manifest as any)?.source,
        description: plugin?.description || '',
      };
    });
  }));

  ipcMain.handle('reload-plugin', ipcResult('reload-plugin', async (_event, pluginId: string) => {
    const validation = validateIPC(PluginIdSchema, pluginId, 'reload-plugin');
    if (!validation.success) return validation;

    const pluginManager = getSandboxedPluginManager();
    await pluginManager.reloadPlugin(validation.data);
    return { success: true };
  }));

  ipcMain.handle('enable-plugin', ipcResult('enable-plugin', async (event, pluginId: string) => {
    const validation = validateIPC(PluginIdSchema, pluginId, 'enable-plugin');
    if (!validation.success) return validation;

    const pluginManager = getSandboxedPluginManager();
    await pluginManager.enablePlugin(validation.data);
    event.sender.send('plugin-views-changed');
    return { success: true };
  }));

  ipcMain.handle('disable-plugin', ipcResult('disable-plugin', async (event, pluginId: string) => {
    const validation = validateIPC(PluginIdSchema, pluginId, 'disable-plugin');
    if (!validation.success) return validation;

    const pluginManager = getSandboxedPluginManager();
    await pluginManager.disablePlugin(validation.data);
    event.sender.send('plugin-views-changed');
    return { success: true };
  }));

  ipcMain.handle('toggle-plugin', ipcResult('toggle-plugin', async (_event, { pluginId, enabled }: { pluginId: string; enabled: boolean }) => {
    const validation = validateIPC(TogglePluginSchema, { pluginId, enabled }, 'toggle-plugin');
    if (!validation.success) return validation;

    const pluginManager = getSandboxedPluginManager();
    if (validation.data.enabled) {
      await pluginManager.enablePlugin(validation.data.pluginId);
    } else {
      await pluginManager.disablePlugin(validation.data.pluginId);
    }
    return { success: true };
  }));

  // ── Marketplace (V1): registry + install/uninstall ──────────────────────────
  // The renderer passes only a registry id — never a URL — so install is
  // confined to curated registry entries. See MarketplaceService.

  ipcMain.handle('marketplace:registry', ipcResult('marketplace:registry', async () => {
    return getMarketplaceListing();
  }));

  ipcMain.handle('plugin:install', ipcResult('plugin:install', async (event, pluginId: string) => {
    const validation = validateIPC(PluginIdSchema, pluginId, 'plugin:install');
    if (!validation.success) return validation;
    const result = await installPlugin(validation.data);
    event.sender.send('plugin-views-changed');
    return { success: true, ...result };
  }));

  ipcMain.handle('plugin:uninstall', ipcResult('plugin:uninstall', async (event, pluginId: string) => {
    const validation = validateIPC(PluginIdSchema, pluginId, 'plugin:uninstall');
    if (!validation.success) return validation;
    await uninstallPlugin(validation.data);
    event.sender.send('plugin-views-changed');
    return { success: true };
  }));

  ipcMain.handle('get-event-history', ipcResult('get-event-history', async (_event, filterType?: string) => {
    if (filterType !== undefined) {
      const validation = validateIPC(EventFilterSchema, filterType, 'get-event-history');
      if (!validation.success) return validation;
      filterType = validation.data;
    }

    const events = eventBus.getEventHistory(filterType);

    return events.map(event => ({
      type: event.type,
      timestamp: event.timestamp,
      source: event.source || 'unknown',
      data: event.data ? JSON.parse(JSON.stringify(event.data, (_key, value) => {
        if (value instanceof Error) {
          return { name: value.name, message: value.message, stack: value.stack };
        }
        if (typeof value === 'function') return undefined;
        return value;
      })) : undefined
    }));
  }));

  ipcMain.handle('subscribe-to-events', ipcResult('subscribe-to-events', async () => {
    return { success: true };
  }));

  ipcMain.handle('clear-event-history', ipcResult('clear-event-history', async () => {
    eventBus.clearHistory();
    return { success: true };
  }));

  ipcMain.handle('plugin:event', ipcResult('plugin:event', async (_event, payload: { event: string; data?: any }) => {
    const validation = validateIPC(PluginEventSchema, payload, 'plugin:event');
    if (!validation.success) return validation;

    const { event, data } = validation.data;

    // Anti-forgery at the renderer ingress. Plugin UI bundles run UNSANDBOXED in
    // the renderer with full `window.electron`, so this handler is a second
    // plugin-originated emit path alongside the worker EventBridge — and it must
    // enforce the same host-owned deny-list. Without it, a plugin UI panel could
    // forge `message:created`/`agent:updated`/etc., and (because emitEvent
    // defaults source to 'core') the forgery would look MORE authoritative than a
    // genuine worker bridge emit. Fail closed on host namespaces.
    if (isHostOwnedEventType(event)) {
      logger.warn(`[plugin:event] Blocked renderer emit of host-owned event ${event}`);
      return { success: false, error: `Cannot emit host-owned event type: ${event}` };
    }

    // Never let a renderer-originated emit masquerade as core. Stamp a distinct,
    // non-authoritative source so downstream consumers can tell it apart.
    eventBus.emitEvent(event, data, 'plugin-ui');
    return { success: true };
  }));

  ipcMain.handle('execute-plugin-tool', ipcResult('execute-plugin-tool', async (_event, { pluginId, toolName, args }: { pluginId: string; toolName: string; args: any }) => {
    const validation = validateIPC(ExecutePluginToolSchema, { pluginId, toolName, args }, 'execute-plugin-tool');
    if (!validation.success) return validation;

    const pluginManager = getSandboxedPluginManager();
    return pluginManager.executePluginTool(
      validation.data.pluginId,
      validation.data.toolName,
      validation.data.args
    );
  }));

  ipcMain.handle('get-plugin-config', ipcResult('get-plugin-config', async (_event, pluginId: string) => {
    const validation = validateIPC(PluginIdSchema, pluginId, 'get-plugin-config');
    if (!validation.success) return validation;

    const configManager = getPluginConfigManager();
    const pluginManager = getSandboxedPluginManager();

    const plugins = pluginManager.getPluginsWithState();
    const plugin = plugins.find(p => p.id === validation.data);

    if (!plugin) {
      return { success: false, error: `Plugin ${validation.data} not found` };
    }

    const userConfig = configManager.getConfig(validation.data);
    const configSchema = plugin.config || {};

    return {
      schema: configSchema,
      values: userConfig,
      pluginId: validation.data,
      pluginName: plugin.name
    };
  }));

  /**
   * Write a plugin's user config, then reload it so the change takes effect.
   *
   * The payload is checked against the plugin's *declared* config schema, not
   * just its shape: an installed plugin, only keys its manifest declares, and
   * only the declared type. Without that, any caller could write arbitrary
   * keys into any plugin id — including one that is not installed — and the
   * reload below would hand them straight to the worker.
   *
   * What this deliberately does NOT claim is ownership. Plugin UI bundles are
   * imported into the renderer (see PluginViewRegistry) and share the whole
   * `window.electron` bridge, so IPC carries no caller identity: nothing here
   * can distinguish the Settings UI from a plugin UI writing a *different*
   * plugin's declared key. Closing that needs per-plugin renderer isolation,
   * not a check at this boundary. Plugin UI is trusted-by-install; SECURITY.md
   * says so plainly rather than implying a boundary that isn't there.
   */
  ipcMain.handle('set-plugin-config', ipcResult('set-plugin-config', async (event, { pluginId, config }: { pluginId: string; config: Record<string, any> }) => {
    const validation = validateIPC(SetPluginConfigSchema, { pluginId, config }, 'set-plugin-config');
    if (!validation.success) return validation;

    const configManager = getPluginConfigManager();
    const pluginManager = getSandboxedPluginManager();

    const plugin = pluginManager.getPluginsWithState().find(p => p.id === validation.data.pluginId);
    if (!plugin) {
      return { success: false, error: `Plugin ${validation.data.pluginId} not found` };
    }

    const rejection = rejectUndeclaredConfig(plugin.config, validation.data.config);
    if (rejection) {
      logger.warn('[Plugins] Rejected config write', { pluginId: validation.data.pluginId, reason: rejection });
      return { success: false, error: rejection };
    }

    configManager.setConfig(validation.data.pluginId, validation.data.config);
    await pluginManager.reloadPlugin(validation.data.pluginId);
    event.sender.send('plugin-views-changed');
    return { success: true };
  }));

  // Service Registry IPC Handlers
  const registry = getServiceRegistry();

  ipcMain.handle('discover-services', ipcResult('discover-services', async (_event, serviceType: string) => {
    const validation = validateIPC(ServiceTypeSchema, serviceType, 'discover-services');
    if (!validation.success) return validation;
    return registry.discover(validation.data);
  }));

  ipcMain.handle('get-registered-services', ipcResult('get-registered-services', async () => {
    return registry.getAllRegistrations();
  }));

  ipcMain.handle('get-service-types', ipcResult('get-service-types', async () => {
    return registry.getServiceTypes();
  }));

  ipcMain.handle('has-service-providers', ipcResult('has-service-providers', async (_event, serviceType: string) => {
    const validation = validateIPC(ServiceTypeSchema, serviceType, 'has-service-providers');
    if (!validation.success) return validation;
    return registry.hasProviders(validation.data);
  }));

  ipcMain.handle('call-service', ipcResult('call-service', async (_event, { serviceType, method, args }: { serviceType: string; method: string; args: any[] }) => {
    const validation = validateIPC(CallServiceSchema, { serviceType, method, args }, 'call-service');
    if (!validation.success) return validation;

    const result = await registry.call(
      validation.data.serviceType,
      validation.data.method,
      ...validation.data.args
    );
    return { success: true, result };
  }));

  // Forward UI events from plugins to renderer
  if (getMainWindow) {
    eventBus.onEvent('plugin:ui:toast', (event) => {
      const mainWindow = getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('plugin:ui:toast', event.data);
      }
    });

    eventBus.onEvent('plugin:ui:notification', (event) => {
      const mainWindow = getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('plugin:ui:notification', event.data);
      }
    });

    // Surface plugin load failures as a toast — otherwise a plugin that crashes
    // on every boot (e.g. a bundled importer) is invisible outside the Activity
    // feed. Once per plugin per session so a recurring crash doesn't spam.
    const notifiedPluginFailures = new Set<string>();
    const forwardPluginFailure = (type: 'plugin:crash' | 'plugin:error') => {
      eventBus.onEvent(type, (event) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) return;
        const data = event.data as { pluginId?: string } | undefined;
        const pluginId = data?.pluginId ?? 'A plugin';
        if (notifiedPluginFailures.has(pluginId)) return;
        notifiedPluginFailures.add(pluginId);
        mainWindow.webContents.send('plugin:ui:toast', {
          message: `Plugin "${pluginId}" failed to load — see Activity for details.`,
          type: 'error',
        });
      });
    };
    forwardPluginFailure('plugin:crash');
    forwardPluginFailure('plugin:error');

    const importEventPatterns = ['progress', 'complete', 'error', 'preview-result'];
    const forwardImportEvent = (eventType: string) => {
      eventBus.onEvent(eventType, (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(eventType, event.data);
        }
      });
    };

    const importPluginPrefixes = ['chatgpt-import', 'character-card-import'];
    for (const prefix of importPluginPrefixes) {
      for (const suffix of importEventPatterns) {
        forwardImportEvent(`${prefix}:${suffix}`);
      }
    }
  }
}
