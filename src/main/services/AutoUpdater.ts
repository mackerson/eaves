import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { getLogger } from './logger';
import { getSettingsRepository } from '../repositories';
import { getEventBus } from './EventBus';
import type { Settings, UpdateMode } from '../types';

const logger = getLogger();

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  info?: UpdateInfo;
  progress?: ProgressInfo;
  error?: string;
}

let instance: AutoUpdaterService | null = null;

export class AutoUpdaterService {
  private getMainWindow: () => BrowserWindow | null;
  private state: UpdateState = { status: 'idle' };
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private periodicMs = 4 * 60 * 60 * 1000;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;

    // Don't auto-download — let the user decide
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Everything below 1.0 is alpha, and 0.x users are expected to take 0.x
    // builds — so prereleases stay eligible. Revisit at 1.0, when "stable" and
    // "latest" start meaning different things.
    //
    // This is NOT a licence to mark GitHub releases as prereleases. Doing that
    // is what kept the update feed dark for months: electron-updater ignores
    // drafts outright, and GitHub's /releases/latest skips prereleases, so a
    // prerelease-flagged build is invisible to the updater and to the README's
    // download link. Alpha is a label for the title, notes and version string.
    autoUpdater.allowPrerelease = true;

    // The feed is the public GitHub releases feed from build.publish.
    // Integrity comes from HTTPS plus the SHA512 in latest.yml; note that
    // builds are not code-signed, so there is no publisher verification.

    this.bindEvents();

    // React to mode changes saved from the Updates tab.
    getEventBus().onEvent('settings:updated', (event) => {
      const settings = event.data as Settings | undefined;
      this.applyMode(settings?.updateMode ?? 'auto');
    });
  }

  private getMode(): UpdateMode {
    try {
      return getSettingsRepository().get().updateMode ?? 'auto';
    } catch {
      return 'auto';
    }
  }

  private applyMode(mode: UpdateMode): void {
    // Turn the interval on/off to match the new mode. Idempotent.
    if (mode === 'auto') {
      if (!this.checkInterval) {
        this.checkInterval = setInterval(() => this.checkForUpdates(), this.periodicMs);
        logger.info('[AutoUpdater] Periodic update checks started');
      }
    } else {
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
        logger.info(`[AutoUpdater] Periodic update checks stopped (mode=${mode})`);
      }
    }
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking' });
      logger.info('[AutoUpdater] Checking for updates...');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.setState({ status: 'available', info });
      logger.info(`[AutoUpdater] Update available: ${info.version}`);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.setState({ status: 'not-available', info });
      logger.info(`[AutoUpdater] Already up to date: ${info.version}`);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({ status: 'downloading', progress });
      logger.info(`[AutoUpdater] Download progress: ${Math.round(progress.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.setState({ status: 'downloaded', info });
      logger.info(`[AutoUpdater] Update downloaded: ${info.version}`);
    });

    autoUpdater.on('error', (error: Error) => {
      this.setState({ status: 'error', error: error.message });
      logger.error('[AutoUpdater] Error:', error.message);
    });
  }

  private setState(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial };
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:state', this.state);
    }
  }

  /** Start periodic update checks (default: every 4 hours) */
  start(intervalMs = 4 * 60 * 60 * 1000): void {
    this.periodicMs = intervalMs;
    const mode = this.getMode();

    if (mode === 'external') {
      logger.info('[AutoUpdater] Update mode is "external" — in-app updater disabled');
      return;
    }

    // Initial check shortly after launch (skipped in manual mode — users who
    // pin a version shouldn't be pinged at every launch either).
    if (mode === 'auto') {
      setTimeout(() => this.checkForUpdates(), 10_000);
      this.applyMode('auto');
    } else {
      logger.info(`[AutoUpdater] Update mode is "${mode}" — no background checks`);
    }
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async checkForUpdates(): Promise<UpdateState> {
    // Managed externally — don't contact the update server even from a manual
    // click. Users in this mode installed via their system package manager.
    if (this.getMode() === 'external') {
      this.setState({
        status: 'error',
        error: 'Updates are managed by your system package manager. In-app updates are disabled.',
      });
      return this.state;
    }

    // electron-updater refuses to run against an unpackaged app (no AppImage /
    // Squirrel / .app bundle). Surface a clear message instead of silently
    // leaving the UI stuck on "idle" during development.
    if (!app.isPackaged) {
      this.setState({
        status: 'error',
        error: 'Update checks are only available in packaged builds (running in development mode).',
      });
      return this.state;
    }

    this.setState({ status: 'checking', error: undefined });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[AutoUpdater] Check failed:', message);
      this.setState({ status: 'error', error: message });
    }
    return this.state;
  }

  async downloadUpdate(): Promise<void> {
    await autoUpdater.downloadUpdate();
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall();
  }

  getState(): UpdateState {
    return this.state;
  }
}

export function getAutoUpdater(getMainWindow?: () => BrowserWindow | null): AutoUpdaterService {
  if (!instance) {
    if (!getMainWindow) throw new Error('AutoUpdaterService requires getMainWindow on first init');
    instance = new AutoUpdaterService(getMainWindow);
  }
  return instance;
}
