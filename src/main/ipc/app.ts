import { ipcMain, app, shell } from 'electron';
import * as path from 'path';
import { ipcResult } from '../utils/ipcValidation';
import { getProviderAdapter } from '../services/providers';
import { detectModelContext } from '../services/modelContext';
import { getToolInventory } from '../services/toolInventory';
import type { ModelCapabilities, ModelContextInfo } from '../../shared/providers';
import type { ToolInventoryEntry } from '../../shared/toolCatalog';

export function registerAppHandlers() {
  ipcMain.handle('app:get-version', ipcResult('app:get-version', async () => {
    return { version: app.getVersion() };
  }));

  // `path` is the database directory; `appDataPath` is its parent, which also
  // holds project workspaces, avatars, themes, and installed plugins. Both are
  // reported because "back up your data" means the parent — the settings UI
  // used to point at `enclave-data` alone while claiming it held everything.
  ipcMain.handle('app:get-data-dir', ipcResult('app:get-data-dir', async () => {
    return {
      path: path.join(app.getPath('userData'), 'enclave-data'),
      appDataPath: app.getPath('userData'),
    };
  }));

  ipcMain.handle('app:open-data-dir', ipcResult('app:open-data-dir', async () => {
    // Open the parent so everything that needs backing up is in one window.
    await shell.openPath(app.getPath('userData'));
    return { success: true };
  }));

  // Open a URL in the user's default browser. Only http(s) is allowed so a
  // renderer can never hand shell.openExternal a file:// or custom-scheme URL.
  ipcMain.handle('app:open-external', ipcResult('app:open-external', async (_event, params: { url: string }) => {
    const { url } = params;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refusing to open non-http(s) URL: ${parsed.protocol}`);
    }
    await shell.openExternal(url);
    return { success: true };
  }));

  // The renderer's "Quit Enclave" menu entry needs a real quit — on macOS
  // BrowserWindow.close() leaves the app running in the dock, so we need
  // app.quit() from the main process.
  ipcMain.handle('app:quit', ipcResult('app:quit', async () => {
    app.quit();
    return { success: true };
  }));

  // Returns what knobs a (provider, modelId) pair accepts, for the agent
  // editor to gate its UI. Falls back to optimistic defaults for unknown
  // providers so a future provider doesn't lock users out of fields.
  ipcMain.handle('app:get-model-capabilities', ipcResult('app:get-model-capabilities',
    async (_event, params: { provider: string; modelId: string }): Promise<ModelCapabilities> => {
      const adapter = getProviderAdapter(params.provider);
      if (adapter) return adapter.getCapabilities(params.modelId);
      return {
        temperature: true, topP: true, stopSequences: true,
        rawPrompt: false, maxOutputTokens: true, toolUse: true,
      };
    },
  ));

  // Live-detect a local model's context window for the agent editor. Returns
  // null for cloud providers (no native metadata API) or when the local server
  // is unreachable — the editor then just shows "Auto-detect".
  ipcMain.handle('app:detect-model-context', ipcResult('app:detect-model-context',
    async (_event, params: { provider: string; modelId: string }): Promise<ModelContextInfo | null> => {
      return detectModelContext(params.provider, params.modelId);
    },
  ));

  // Enumerate the tools available to agents (built-in + loaded plugins), tagged
  // by source with an approximate per-turn token cost — the agent editor uses
  // this for the default-tools trust tiers and token-weight readout. MCP-server
  // tools are excluded (enumerating them means spawning servers).
  ipcMain.handle('app:get-tool-inventory', ipcResult('app:get-tool-inventory',
    async (): Promise<ToolInventoryEntry[]> => getToolInventory(),
  ));
}
