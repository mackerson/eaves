import { ipcMain, BrowserWindow } from 'electron';
import { getAutoUpdater } from '../services/AutoUpdater';
import { ipcResult } from '../utils/ipcValidation';

export function registerUpdateHandlers(getMainWindow: () => BrowserWindow | null): void {
  const updater = getAutoUpdater(getMainWindow);

  ipcMain.handle('updater:get-state', ipcResult('updater:get-state', async () => {
    return updater.getState();
  }));

  ipcMain.handle('updater:check', ipcResult('updater:check', async () => {
    return updater.checkForUpdates();
  }));

  ipcMain.handle('updater:download', ipcResult('updater:download', async () => {
    await updater.downloadUpdate();
    return { success: true };
  }));

  ipcMain.handle('updater:quit-and-install', ipcResult('updater:quit-and-install', async () => {
    updater.quitAndInstall();
    return { success: true };
  }));
}
