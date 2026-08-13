import * as chokidar from 'chokidar';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { logger } from './logger';
import { getSandboxedPluginManager } from './sandbox';
import { PluginManifest } from '../../shared/types';

/**
 * PluginWatcher monitors plugin directories for changes and automatically
 * reloads plugins when new ones are added or existing ones are updated.
 *
 * This enables the "live demo" workflow where Claude Code can generate
 * a plugin and it appears in Enclave without restarting.
 */
export class PluginWatcher {
  private watchers: chokidar.FSWatcher[] = [];
  private buildQueue: Set<string> = new Set();
  private isBuilding: boolean = false;

  /**
   * Start watching a plugin directory for changes
   */
  start(pluginDir: string, dirType: 'bundled' | 'user' = 'user'): void {
    logger.info(`[PluginWatcher] Starting file watcher for ${dirType} plugins`, { pluginDir });

    // Watch for new plugin.json files (new plugins)
    // and changes to existing plugin.json files (plugin updates)
    const watcher = chokidar.watch(path.join(pluginDir, '*/plugin.json'), {
      ignoreInitial: true, // Don't fire for existing plugins
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000, // Wait 1s after last write
        pollInterval: 100
      }
    });

    watcher.on('add', async (pluginJsonPath) => {
      const pluginId = this.extractPluginId(pluginJsonPath);
      logger.info(`[PluginWatcher] New plugin detected: ${pluginId}`);
      await this.handleNewPlugin(pluginId, pluginJsonPath);
    });

    watcher.on('change', async (pluginJsonPath) => {
      const pluginId = this.extractPluginId(pluginJsonPath);
      logger.info(`[PluginWatcher] Plugin updated: ${pluginId}`);
      await this.handlePluginUpdate(pluginId, pluginJsonPath);
    });

    watcher.on('error', (error) => {
      logger.error('[PluginWatcher] Watcher error', { error });
    });

    this.watchers.push(watcher);
  }

  /**
   * Extract plugin ID from plugin.json path
   * Example: /path/to/plugins/my-plugin/plugin.json → my-plugin
   */
  private extractPluginId(pluginJsonPath: string): string {
    return path.basename(path.dirname(pluginJsonPath));
  }

  /**
   * Handle newly detected plugin
   */
  private async handleNewPlugin(pluginId: string, pluginJsonPath: string): Promise<void> {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      logger.warn('[PluginWatcher] No main window found, skipping notification');
      return;
    }

    try {
      // 1. Notify renderer: New plugin detected
      mainWindow.webContents.send('plugin:detected', { pluginId });

      // 2. Check if plugin needs building (has vite.config.ts)
      const pluginDir = path.dirname(pluginJsonPath);
      const needsBuild = await this.checkNeedsBuild(pluginDir);

      if (needsBuild) {
        // Queue build
        this.buildQueue.add(pluginId);
        mainWindow.webContents.send('plugin:building', { pluginId });

        // Process build queue
        await this.processBuildQueue();
      }

      // 3. Read manifest and load via sandboxed manager
      const manifest = await this.readPluginManifest(pluginJsonPath);
      if (manifest) {
        await this.reloadSandboxedPlugin(pluginId, manifest);
      }

      // 4. Notify renderer: Plugin loaded
      mainWindow.webContents.send('plugin:loaded', { pluginId, sandboxed: true });
      logger.info(`[PluginWatcher] Plugin loaded successfully: ${pluginId}`);
    } catch (error) {
      logger.error(`[PluginWatcher] Failed to load plugin ${pluginId}`, { error });
      mainWindow.webContents.send('plugin:error', {
        pluginId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Handle plugin update (existing plugin.json changed)
   */
  private async handlePluginUpdate(pluginId: string, pluginJsonPath: string): Promise<void> {
    // Updates take the same path as a new plugin: reloadSandboxedPlugin routes
    // an already-loaded id to reloadPlugin, which tears the worker down before
    // starting the new one — so there's no separate unload step here.
    logger.info(`[PluginWatcher] Reloading updated plugin: ${pluginId}`);
    await this.handleNewPlugin(pluginId, pluginJsonPath);
  }

  /**
   * Check if a plugin needs building (has vite.config.ts or vite.config.js)
   */
  private async checkNeedsBuild(pluginDir: string): Promise<boolean> {
    const viteConfigTs = path.join(pluginDir, 'vite.config.ts');
    const viteConfigJs = path.join(pluginDir, 'vite.config.js');

    const hasViteConfig = fs.existsSync(viteConfigTs) || fs.existsSync(viteConfigJs);

    if (hasViteConfig) {
      logger.debug(`[PluginWatcher] Plugin needs building (has vite.config)`, { pluginDir });
    }

    return hasViteConfig;
  }

  /**
   * Process the build queue (serialize builds to avoid conflicts)
   */
  private async processBuildQueue(): Promise<void> {
    if (this.isBuilding || this.buildQueue.size === 0) {
      return;
    }

    this.isBuilding = true;

    try {
      // Build all plugins in queue
      const pluginIds = Array.from(this.buildQueue);
      this.buildQueue.clear();

      for (const pluginId of pluginIds) {
        await this.buildPlugin(pluginId);
      }
    } finally {
      this.isBuilding = false;

      // Check if more plugins were queued during build
      if (this.buildQueue.size > 0) {
        await this.processBuildQueue();
      }
    }
  }

  /**
   * Build a plugin using the build-plugins.js script
   */
  private async buildPlugin(pluginId: string): Promise<void> {
    logger.info(`[PluginWatcher] Building plugin: ${pluginId}`);

    return new Promise((resolve, reject) => {
      const scriptPath = path.join(app.getAppPath(), 'scripts', 'build-plugins.js');

      const proc = spawn('node', [scriptPath, pluginId], {
        cwd: app.getAppPath(),
        stdio: ['ignore', 'pipe', 'pipe'], // Capture stdout/stderr
        env: process.env
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('exit', (code) => {
        if (code === 0) {
          logger.info(`[PluginWatcher] Build successful: ${pluginId}`);
          resolve();
        } else {
          const error = stderr || stdout || `Build failed with code ${code}`;
          logger.error(`[PluginWatcher] Build failed: ${pluginId}`, { error, code });
          reject(new Error(error));
        }
      });

      proc.on('error', (error) => {
        logger.error(`[PluginWatcher] Build process error: ${pluginId}`, { error });
        reject(error);
      });
    });
  }

  /**
   * Reload a sandboxed plugin
   */
  private async reloadSandboxedPlugin(
    pluginId: string,
    manifest: PluginManifest
  ): Promise<void> {
    const sandboxManager = getSandboxedPluginManager();

    if (sandboxManager.isPluginLoaded(pluginId)) {
      // Plugin exists, reload it
      logger.info(`[PluginWatcher] Reloading sandboxed plugin: ${pluginId}`);
      await sandboxManager.reloadPlugin(pluginId);
    } else {
      // New plugin, load it
      logger.info(`[PluginWatcher] Loading new sandboxed plugin: ${pluginId}`);
      await sandboxManager.loadPlugin(manifest);
    }
  }

  /**
   * Read and parse a plugin manifest file
   */
  private async readPluginManifest(pluginJsonPath: string): Promise<PluginManifest | null> {
    try {
      const content = await fs.promises.readFile(pluginJsonPath, 'utf-8');
      const manifest = JSON.parse(content) as PluginManifest;

      // Ensure entry path is absolute
      if (manifest.entry && !path.isAbsolute(manifest.entry)) {
        manifest.entry = path.join(path.dirname(pluginJsonPath), manifest.entry);
      }

      return manifest;
    } catch (error) {
      logger.error(`[PluginWatcher] Failed to read plugin manifest: ${pluginJsonPath}`, { error });
      return null;
    }
  }

  /**
   * Stop all watchers
   */
  stop(): void {
    logger.info('[PluginWatcher] Stopping file watchers');

    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.watchers = [];
    this.buildQueue.clear();
  }
}
