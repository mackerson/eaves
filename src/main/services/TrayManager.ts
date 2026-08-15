import * as path from 'path';
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { getLogger } from './logger';

const logger = getLogger();

const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABQSURBVDiNY2AYBaNgFAwkYGJgYPjPwMDw/z8DEz8DA8N/BgaG/wwMDP+RxZGFkMWRhZDFkYWQxZGFkMWRhZDFkYWQxZGFkMWRhZDFRsEAAgAkDAQN0jLSIwAAAABJRU5ErkJggg==';

export type TrayNavigateView = 'chats' | 'channels' | 'settings';

export interface TrayManagerOptions {
  getMainWindow: () => BrowserWindow | null;
  createWindow: () => void;
  onNavigate: (view: TrayNavigateView) => void;
}

class TrayManagerService {
  private tray: Tray | null = null;
  private options: TrayManagerOptions | null = null;

  init(options: TrayManagerOptions): void {
    if (this.tray) {
      logger.warn('[TrayManager] init called but tray already exists');
      return;
    }
    this.options = options;

    try {
      const icon = this.loadIcon();
      this.tray = new Tray(icon);

      this.tray.setToolTip('Eaves');
      this.tray.setContextMenu(this.buildContextMenu());

      const toggle = () => this.toggleWindow();
      this.tray.on('click', toggle);
      this.tray.on('double-click', toggle);

      logger.info('System tray created successfully');
    } catch (error) {
      logger.error('Failed to create system tray:', error);
    }
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    this.options = null;
  }

  private loadIcon() {
    const iconPath = this.getTrayIconPath();
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      logger.warn('Tray icon not found, creating fallback');
      return nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL);
    }
    return icon;
  }

  private getTrayIconPath(): string {
    // __dirname is dist/main/main/services/, assets are at dist/assets/
    const iconBasePath = path.join(__dirname, '..', '..', '..', 'assets', 'icons');
    // macOS template images auto-switch for light/dark menu bar
    if (process.platform === 'darwin') {
      return path.join(iconBasePath, 'tray-iconTemplate.png');
    }
    return path.join(iconBasePath, 'tray-icon.png');
  }

  private buildContextMenu(): Menu {
    return Menu.buildFromTemplate([
      {
        label: 'Show Eaves',
        click: () => this.showWindow(),
      },
      { type: 'separator' },
      {
        label: 'Chats',
        click: () => this.navigate('chats'),
      },
      {
        label: 'Channels',
        click: () => this.navigate('channels'),
      },
      {
        label: 'Settings',
        click: () => this.navigate('settings'),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);
  }

  private navigate(view: TrayNavigateView): void {
    this.showWindow();

    // showWindow may have just *created* the window, in which case its renderer
    // has not loaded and `tray:navigate` goes nowhere — the user clicks Chats
    // in the tray, the window opens, and it lands on whatever view it last had.
    // Wait for the load when there is one to wait for.
    const win = this.options?.getMainWindow() ?? null;
    if (!win || win.isDestroyed()) return;

    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => this.options?.onNavigate(view));
      return;
    }
    this.options?.onNavigate(view);
  }

  private showWindow(): void {
    const win = this.options?.getMainWindow() ?? null;
    if (!win) {
      this.options?.createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  private toggleWindow(): void {
    const win = this.options?.getMainWindow() ?? null;
    if (!win) {
      this.options?.createWindow();
      return;
    }
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

let _instance: TrayManagerService | null = null;
export function getTrayManager(): TrayManagerService {
  if (!_instance) _instance = new TrayManagerService();
  return _instance;
}
