/**
 * IPC handlers for the Messaging Bridge system.
 * Manages bridge lifecycle, config, and session state from the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { z } from 'zod/v3';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { getMessagingBridgeService, TelegramAdapter } from '../services/messaging';
import { logger } from '../services/logger';

// Validation schemas
const SetBridgeConfigSchema = z.object({
  platform: z.string().min(1),
  token: z.string().optional(),
  keepExistingToken: z.boolean().optional().default(false),
  allowedUserIds: z.array(z.string()).min(1, 'At least one authorized user ID is required'),
  autoStart: z.boolean().optional().default(false),
});

const PlatformSchema = z.object({
  platform: z.string().min(1),
});

export function registerMessagingHandlers(getMainWindow: () => BrowserWindow | null) {
  const service = getMessagingBridgeService(getMainWindow);

  // Register the Telegram adapter
  const telegramAdapter = new TelegramAdapter();
  telegramAdapter.setMessageHandler((msg) => service.handleIncoming(msg));
  service.registerBridge(telegramAdapter);

  // --- Bridge lifecycle ---

  ipcMain.handle('messaging:get-bridges', ipcResult('messaging:get-bridges', async () => {
    return { success: true, bridges: service.getBridgeStatuses() };
  }));

  ipcMain.handle('messaging:start-bridge', ipcResult('messaging:start-bridge', async (_event, data: unknown) => {
    const v = validateIPC(PlatformSchema, data, 'messaging:start-bridge');
    if (!v.success) return v;

    await service.startBridge(v.data.platform);
    return { success: true };
  }));

  ipcMain.handle('messaging:stop-bridge', ipcResult('messaging:stop-bridge', async (_event, data: unknown) => {
    const v = validateIPC(PlatformSchema, data, 'messaging:stop-bridge');
    if (!v.success) return v;

    await service.stopBridge(v.data.platform);
    return { success: true };
  }));

  // --- Config ---

  ipcMain.handle('messaging:get-bridge-config', ipcResult('messaging:get-bridge-config', async (_event, data: unknown) => {
    const v = validateIPC(PlatformSchema, data, 'messaging:get-bridge-config');
    if (!v.success) return v;

    const config = service.getBridgeConfig(v.data.platform);
    return { success: true, ...config };
  }));

  ipcMain.handle('messaging:set-bridge-config', ipcResult('messaging:set-bridge-config', async (_event, data: unknown) => {
    const v = validateIPC(SetBridgeConfigSchema, data, 'messaging:set-bridge-config');
    if (!v.success) return v;

    // Resolve token: use existing if keepExistingToken is set, otherwise require a new one
    let token: string;
    if (v.data.keepExistingToken) {
      const existing = service.loadBridgeConfig(v.data.platform);
      if (!existing) return { success: false, error: 'No existing config to preserve token from' };
      token = existing.token;
    } else {
      // Trim before validating and storing: a token pasted with trailing
      // whitespace is otherwise stored verbatim and only fails much later,
      // as an opaque 404 from the platform API.
      token = (v.data.token ?? '').trim();
      if (!token) return { success: false, error: 'Bot token is required' };

      const tokenError = service.validateBridgeToken(v.data.platform, token);
      if (tokenError) return { success: false, error: tokenError };
    }

    service.saveBridgeConfig(v.data.platform, {
      token,
      allowedUserIds: v.data.allowedUserIds,
      autoStart: v.data.autoStart ?? false,
    });

    return { success: true };
  }));

  ipcMain.handle('messaging:test-connection', ipcResult('messaging:test-connection', async (_event, data: unknown) => {
    const v = validateIPC(PlatformSchema, data, 'messaging:test-connection');
    if (!v.success) return v;

    const result = await service.testBridgeConnection(v.data.platform);
    return { success: true, ...result };
  }));

  ipcMain.handle('messaging:delete-bridge-config', ipcResult('messaging:delete-bridge-config', async (_event, data: unknown) => {
    const v = validateIPC(PlatformSchema, data, 'messaging:delete-bridge-config');
    if (!v.success) return v;

    // Stop if running
    await service.stopBridge(v.data.platform).catch(() => {});
    service.deleteBridgeConfig(v.data.platform);
    return { success: true };
  }));

  // --- Sessions ---

  ipcMain.handle('messaging:get-sessions', ipcResult('messaging:get-sessions', async (_event, data: unknown) => {
    const v = validateIPC(PlatformSchema, data, 'messaging:get-sessions');
    if (!v.success) return v;

    const sessions = service.getSessions(v.data.platform);
    return { success: true, sessions };
  }));
}

/**
 * Auto-start bridges that have autoStart enabled in their config.
 * Call this after plugin system initialization in main.ts.
 */
export async function autoStartBridges(getMainWindow: () => BrowserWindow | null): Promise<void> {
  try {
    const service = getMessagingBridgeService(getMainWindow);
    const platforms = service.getAutoStartPlatforms();

    for (const platform of platforms) {
      try {
        await service.startBridge(platform);
        logger.info(`[Messaging] Auto-started ${platform} bridge`);
      } catch (error) {
        logger.error(`[Messaging] Failed to auto-start ${platform}:`, error);
      }
    }
  } catch (error) {
    logger.error('[Messaging] Failed to check auto-start bridges:', error);
  }
}
