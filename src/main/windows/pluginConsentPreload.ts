import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload for the plugin-install consent window. Deliberately tiny: the only
 * capability it hands the page is "report the user's decision once".
 *
 * This preload is attached solely to the consent window created by
 * pluginConsentWindow.ts, whose page is app-authored HTML loaded from a data:
 * URL. The main window's renderer — where unsandboxed plugin UI code runs —
 * never gets this bridge, which is the point: consent has to be a surface the
 * marketplace plugin cannot script.
 *
 * Runs sandboxed, so it must stay dependency-free: a sandboxed preload's
 * require() resolves 'electron' and a few builtins, never relative paths. The
 * channel name is therefore duplicated rather than imported — keep it in sync
 * with CONSENT_RESPOND_CHANNEL in pluginConsentWindow.ts.
 */
contextBridge.exposeInMainWorld('pluginConsent', {
  respond: (approved: boolean) =>
    ipcRenderer.send('plugin-consent:respond', approved === true),
});
