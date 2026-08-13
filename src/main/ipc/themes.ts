import { ipcMain, shell } from 'electron';
import { getThemeManager } from '../services/ThemeManager';
import { EntityIdSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerThemeHandlers() {
  const themeManager = getThemeManager();
  ipcMain.handle('get-user-themes', ipcResult('get-user-themes', async () => {
    return themeManager.getAllUserThemes();
  }));

  ipcMain.handle('get-user-theme', ipcResult('get-user-theme', async (_event, themeId: string) => {
    const validation = validateIPC(EntityIdSchema, themeId, 'get-user-theme');
    if (!validation.success) return validation;
    return themeManager.getUserTheme(validation.data);
  }));

  ipcMain.handle('get-user-theme-css', ipcResult('get-user-theme-css', async (_event, themeId: string) => {
    const validation = validateIPC(EntityIdSchema, themeId, 'get-user-theme-css');
    if (!validation.success) return null;

    const theme = themeManager.getUserTheme(validation.data);
    return theme ? themeManager.generateThemeCSS(theme) : null;
  }));

  ipcMain.handle('is-user-theme', ipcResult('is-user-theme', async (_event, themeId: string) => {
    const validation = validateIPC(EntityIdSchema, themeId, 'is-user-theme');
    if (!validation.success) return false;
    return themeManager.isUserTheme(validation.data);
  }));

  ipcMain.handle('reload-user-themes', ipcResult('reload-user-themes', async () => {
    return themeManager.loadUserThemes();
  }));

  ipcMain.handle('get-themes-directory', ipcResult('get-themes-directory', async () => {
    return themeManager.getThemesDirectory();
  }));

  ipcMain.handle('open-themes-directory', ipcResult('open-themes-directory', async () => {
    const themesDir = themeManager.getThemesDirectory();
    await shell.openPath(themesDir);
    return { success: true };
  }));
}
