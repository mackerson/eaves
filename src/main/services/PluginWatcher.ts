import * as chokidar from 'chokidar';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { logger } from './logger';
import { getSandboxedPluginManager } from './sandbox';
import { PluginManifest } from '../../shared/types';
import { PluginManifestSchema, validateWithSchema, isValidationFailure } from '../../shared/validation';

/** Which load tier a watched directory represents — see `PluginManifest.source`. */
type PluginSource = NonNullable<PluginManifest['source']>;

/**
 * PluginWatcher monitors plugin directories for changes and automatically
 * reloads plugins when new ones are added or existing ones are updated.
 *
 * This enables the "live demo" workflow where Claude Code can generate
 * a plugin and it appears in Eaves without restarting.
 */
export class PluginWatcher {
  private watchers: chokidar.FSWatcher[] = [];
  private readyPromises: Promise<void>[] = [];
  private buildQueue: Set<string> = new Set();
  private isBuilding: boolean = false;

  /**
   * Resolves once every started watcher has finished its initial scan. Until
   * then `ignoreInitial` treats writes as pre-existing files and drops them, so
   * anything wanting to observe a change must wait for this first.
   */
  async whenReady(): Promise<void> {
    await Promise.all(this.readyPromises);
  }

  /**
   * Start watching a plugin directory for changes
   */
  start(pluginDir: string, dirType: PluginSource = 'user'): void {
    if (!fs.existsSync(pluginDir)) {
      logger.info(`[PluginWatcher] Skipping ${dirType} plugins — directory does not exist`, { pluginDir });
      return;
    }

    logger.info(`[PluginWatcher] Starting file watcher for ${dirType} plugins`, { pluginDir });

    // Watch the directory itself, not a `*/plugin.json` glob: chokidar 4 dropped
    // glob support, so a pattern path is taken literally, matches nothing, and
    // reports no error — which silently disabled hot reload entirely. `depth: 1`
    // reaches <pluginDir>/<plugin>/plugin.json and stops before ui/ or
    // node_modules, and we filter to manifests by basename.
    const watcher = chokidar.watch(pluginDir, {
      ignoreInitial: true, // Don't fire for existing plugins
      persistent: true,
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: 1000, // Wait 1s after last write
        pollInterval: 100
      }
    });

    const isManifest = (p: string) => path.basename(p) === 'plugin.json';

    watcher.on('add', async (pluginJsonPath) => {
      if (!isManifest(pluginJsonPath)) return;
      const pluginId = this.extractPluginId(pluginJsonPath);
      logger.info(`[PluginWatcher] New plugin detected: ${pluginId}`);
      await this.handleNewPlugin(pluginId, pluginJsonPath, dirType);
    });

    watcher.on('change', async (pluginJsonPath) => {
      if (!isManifest(pluginJsonPath)) return;
      const pluginId = this.extractPluginId(pluginJsonPath);
      logger.info(`[PluginWatcher] Plugin updated: ${pluginId}`);
      await this.handlePluginUpdate(pluginId, pluginJsonPath, dirType);
    });

    watcher.on('error', (error) => {
      logger.error('[PluginWatcher] Watcher error', { error });
    });

    this.readyPromises.push(
      new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
    );

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
  private async handleNewPlugin(
    pluginId: string,
    pluginJsonPath: string,
    source: PluginSource
  ): Promise<void> {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      logger.warn('[PluginWatcher] No main window found, skipping notification');
      return;
    }

    try {
      // 1. Notify renderer: New plugin detected
      mainWindow.webContents.send('plugin:detected', { pluginId });

      // 2. Read the manifest, then wait for the entry file it points at. A
      // plugin being authored in place (by hand or by an agent) almost always
      // gets its manifest written before its entry, and the manifest is what
      // wakes us — so loading immediately would fail on a file that is seconds
      // from existing.
      const pluginDir = path.dirname(pluginJsonPath);
      const manifest = await this.readPluginManifest(pluginJsonPath, source);
      if (manifest?.entry) {
        await this.waitForFile(path.join(pluginDir, manifest.entry));
      }

      // 3. Check if plugin needs building (has vite.config.ts)
      const needsBuild = await this.checkNeedsBuild(pluginDir);

      if (needsBuild) {
        // Queue build
        this.buildQueue.add(pluginDir);
        mainWindow.webContents.send('plugin:building', { pluginId });

        // Process build queue
        await this.processBuildQueue();
      }

      // 4. Load via sandboxed manager
      if (manifest) {
        await this.reloadSandboxedPlugin(pluginId, manifest);
      }

      // 5. Notify renderer: Plugin loaded. `plugin-views-changed` is what
      // actually rebuilds the sidebar — the enable/install IPC handlers send it
      // via `event.sender`, which a main-initiated load has no equivalent of, so
      // without this a hot-loaded plugin announced itself in a toast and then
      // failed to appear until the next window focus.
      mainWindow.webContents.send('plugin:loaded', { pluginId, sandboxed: true });
      mainWindow.webContents.send('plugin-views-changed');
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
  private async handlePluginUpdate(
    pluginId: string,
    pluginJsonPath: string,
    source: PluginSource
  ): Promise<void> {
    // Updates take the same path as a new plugin: reloadSandboxedPlugin routes
    // an already-loaded id to reloadPlugin, which tears the worker down before
    // starting the new one — so there's no separate unload step here.
    logger.info(`[PluginWatcher] Reloading updated plugin: ${pluginId}`);
    await this.handleNewPlugin(pluginId, pluginJsonPath, source);
  }

  /**
   * Wait for a file to appear, up to `timeoutMs`. Resolves either way — a
   * still-missing entry is left to the loader to report, so a genuinely broken
   * manifest surfaces its real error instead of a timeout message.
   */
  private async waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!fs.existsSync(filePath)) {
      if (Date.now() >= deadline) {
        logger.warn(`[PluginWatcher] Entry file never appeared, loading anyway`, { filePath });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
      const pluginDirs = Array.from(this.buildQueue);
      this.buildQueue.clear();

      for (const pluginDir of pluginDirs) {
        await this.buildPlugin(pluginDir);
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
   * Build a plugin using the build-plugins.js script.
   *
   * Passes the plugin's **directory**, not its folder name: a plugin installed
   * or authored under userData is not inside the repo's `plugins/` tree, and a
   * bare name is only resolvable there.
   */
  private async buildPlugin(pluginDir: string): Promise<void> {
    logger.info(`[PluginWatcher] Building plugin`, { pluginDir });

    return new Promise((resolve, reject) => {
      const scriptPath = path.join(app.getAppPath(), 'scripts', 'build-plugins.js');

      const proc = spawn('node', [scriptPath, pluginDir], {
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
          logger.info(`[PluginWatcher] Build successful`, { pluginDir });
          resolve();
        } else {
          const error = stderr || stdout || `Build failed with code ${code}`;
          logger.error(`[PluginWatcher] Build failed`, { pluginDir, error, code });
          reject(new Error(error));
        }
      });

      proc.on('error', (error) => {
        logger.error(`[PluginWatcher] Build process error`, { pluginDir, error });
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
  private async readPluginManifest(
    pluginJsonPath: string,
    source: PluginSource
  ): Promise<PluginManifest | null> {
    const pluginDir = path.dirname(pluginJsonPath);

    try {
      const content = await fs.promises.readFile(pluginJsonPath, 'utf-8');

      // Shape this exactly like discovery (`discoverPluginsInDirectory`): the
      // loader resolves the entry against `path`, and the renderer picks a UI
      // bundle URL from `source`, so a manifest missing either is unloadable.
      // Entry stays *relative* — absolutizing it here while leaving `path`
      // unset is what made every hot-reloaded plugin die on a path.join of
      // undefined.
      const validation = validateWithSchema(PluginManifestSchema, JSON.parse(content));
      if (isValidationFailure(validation)) {
        logger.warn(`[PluginWatcher] Invalid manifest in ${pluginDir}`, { error: validation.error });
        return null;
      }

      return {
        ...validation.data,
        path: pluginDir,
        source,
        folderName: path.basename(pluginDir),
      } as PluginManifest;
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
    this.readyPromises = [];
    this.buildQueue.clear();
  }
}
