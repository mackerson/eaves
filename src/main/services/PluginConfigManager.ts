import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './logger';

/**
 * Manages plugin configuration persistence
 * Stores user config overrides in {userData}/plugin-configs.json
 */
// Keys that would reach through to Object.prototype (or, for a null-prototype
// object, would silently no-op) if used as a plugin id. `PluginIdSchema`
// (src/shared/validation.ts) allows `.`/`_`/`-` in ids, so `__proto__` is a
// schema-valid plugin id — reject it here too, fail closed.
const UNSAFE_PLUGIN_ID_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class PluginConfigManager {
  private configFilePath: string;
  // Object.create(null): a plain `{}` has `__proto__` as a live accessor onto
  // Object.prototype, so `this.configs[id] = config` for id === '__proto__'
  // would mutate every object's prototype instead of adding an own key —
  // after which getConfig() for any plugin with no own entry resolves keys
  // off the injected object. A null-prototype map has no such accessor.
  private configs: Record<string, Record<string, any>> = Object.create(null);

  constructor() {
    const userDataPath = app.getPath('userData');
    this.configFilePath = path.join(userDataPath, 'plugin-configs.json');
    this.loadConfigs();
  }

  /**
   * Load all plugin configs from disk
   */
  private loadConfigs(): void {
    try {
      if (fs.existsSync(this.configFilePath)) {
        const data = fs.readFileSync(this.configFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        // Rebuild onto a null-prototype map rather than assigning the parsed
        // object directly — `JSON.parse` returns an ordinary object, which
        // would silently undo the Object.create(null) protection below on
        // every restart. Also drop any reserved key an old, pre-fix file may
        // have persisted.
        this.configs = Object.create(null);
        for (const key of Object.keys(parsed)) {
          if (UNSAFE_PLUGIN_ID_KEYS.has(key)) continue;
          this.configs[key] = parsed[key];
        }
        logger.info('Loaded plugin configs', { configCount: Object.keys(this.configs).length });
      } else {
        this.configs = Object.create(null);
        logger.info('No plugin configs file found, starting fresh');
      }
    } catch (error) {
      logger.error('Failed to load plugin configs', { error });
      this.configs = Object.create(null);
    }
  }

  /**
   * Save all plugin configs to disk
   */
  private saveConfigs(): void {
    try {
      const data = JSON.stringify(this.configs, null, 2);
      fs.writeFileSync(this.configFilePath, data, 'utf-8');
      logger.info('Saved plugin configs');
    } catch (error) {
      logger.error('Failed to save plugin configs', { error });
      throw error;
    }
  }

  /**
   * Get configuration for a specific plugin
   */
  getConfig(pluginId: string): Record<string, any> {
    return this.configs[pluginId] || {};
  }

  /**
   * Set configuration for a specific plugin
   */
  setConfig(pluginId: string, config: Record<string, any>): void {
    if (UNSAFE_PLUGIN_ID_KEYS.has(pluginId)) {
      throw new Error(`Refusing to set config for reserved plugin id "${pluginId}"`);
    }
    this.configs[pluginId] = config;
    this.saveConfigs();
    // Never log config values: this is exactly where plugin API keys/tokens live.
    logger.info(`Updated config for plugin ${pluginId}`, { keys: Object.keys(config) });
  }

  /**
   * Delete a plugin's persisted config. Called on uninstall so secrets don't
   * outlive the plugin on disk.
   */
  deleteConfig(pluginId: string): void {
    if (!(pluginId in this.configs)) return;
    delete this.configs[pluginId];
    this.saveConfigs();
    logger.info(`Deleted config for plugin ${pluginId}`);
  }

  /**
   * Get all plugin configurations
   */
  getAllConfigs(): Record<string, Record<string, any>> {
    return { ...this.configs };
  }
}

// Singleton instance
let configManagerInstance: PluginConfigManager | null = null;

export function getPluginConfigManager(): PluginConfigManager {
  if (!configManagerInstance) {
    configManagerInstance = new PluginConfigManager();
  }
  return configManagerInstance;
}
