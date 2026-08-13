import * as chokidar from 'chokidar';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import { getLogger } from './logger';
import { getThemeManager } from './ThemeManager';

const logger = getLogger();
const themeManager = getThemeManager();

/**
 * ThemeWatcher monitors the user themes directory for changes and automatically
 * notifies the renderer when themes are added, updated, or removed.
 *
 * This enables hot-reload of user themes without restarting the app.
 */
class ThemeWatcherService {
  private watcher: chokidar.FSWatcher | null = null;

  /**
   * Start watching the user themes directory for changes
   */
  start(): void {
    const themesDir = themeManager.getThemesDirectory();
    logger.info('[ThemeWatcher] Starting file watcher for user themes', { themesDir });

    // Watch for theme.json files
    this.watcher = chokidar.watch(path.join(themesDir, '*/theme.json'), {
      ignoreInitial: true, // Don't fire for existing themes
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 500, // Wait 500ms after last write
        pollInterval: 100,
      },
    });

    this.watcher.on('add', async (themeJsonPath) => {
      logger.info('[ThemeWatcher] New theme detected', { path: themeJsonPath });
      await this.handleThemeAdded(themeJsonPath);
    });

    this.watcher.on('change', async (themeJsonPath) => {
      logger.info('[ThemeWatcher] Theme updated', { path: themeJsonPath });
      await this.handleThemeUpdated(themeJsonPath);
    });

    this.watcher.on('unlink', async (themeJsonPath) => {
      logger.info('[ThemeWatcher] Theme removed', { path: themeJsonPath });
      await this.handleThemeRemoved(themeJsonPath);
    });

    this.watcher.on('error', (error) => {
      logger.error('[ThemeWatcher] Watcher error', { error });
    });
  }

  /**
   * Stop watching for changes
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info('[ThemeWatcher] Stopped file watcher');
    }
  }

  /**
   * Handle newly detected theme
   */
  private async handleThemeAdded(themeJsonPath: string): Promise<void> {
    const theme = themeManager.addOrUpdateTheme(themeJsonPath);
    if (theme) {
      this.notifyRenderer('theme:added', theme);
    }
  }

  /**
   * Handle theme file update
   */
  private async handleThemeUpdated(themeJsonPath: string): Promise<void> {
    const theme = themeManager.addOrUpdateTheme(themeJsonPath);
    if (theme) {
      this.notifyRenderer('theme:updated', theme);
    }
  }

  /**
   * Handle theme removal
   */
  private async handleThemeRemoved(themeJsonPath: string): Promise<void> {
    const removedId = themeManager.removeThemeByPath(themeJsonPath);
    if (removedId) {
      this.notifyRenderer('theme:removed', { id: removedId });
    }
  }

  /**
   * Notify the renderer process of theme changes
   */
  private notifyRenderer(channel: string, data: any): void {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
      logger.debug('[ThemeWatcher] Sent notification to renderer', { channel, data });
    } else {
      logger.warn('[ThemeWatcher] No main window found, skipping notification');
    }
  }
}

let _themeWatcherInstance: ThemeWatcherService | null = null;
export function getThemeWatcher(): ThemeWatcherService {
  if (!_themeWatcherInstance) _themeWatcherInstance = new ThemeWatcherService();
  return _themeWatcherInstance;
}
export const themeWatcher = getThemeWatcher();
