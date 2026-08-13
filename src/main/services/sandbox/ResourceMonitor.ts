/**
 * Resource Monitor
 *
 * Monitors resource usage of sandboxed plugin workers.
 * Tracks memory, enforces limits, and can terminate runaway plugins.
 */

import { PluginWorker } from './PluginWorker';
import { WorkerHealth, ResourceLimits, DEFAULT_RESOURCE_LIMITS, HealthResponseMessage } from './types';
import { eventBus } from '../EventBus';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

interface MonitoredPlugin {
  pluginId: string;
  worker: PluginWorker;
  limits: ResourceLimits;
  lastHealth: WorkerHealth | null;
  warningCount: number;
  lastWarningAt: number;
  /** Bumped every time updateHealth() stores a new lastHealth snapshot. */
  healthSeq: number;
  /** healthSeq of the last snapshot checkPluginHealth() actually scored. */
  evaluatedHealthSeq: number;
}

interface ResourceWarning {
  pluginId: string;
  type: 'memory' | 'cpu' | 'timeout';
  current: number;
  limit: number;
  timestamp: number;
}

interface ResourceViolation extends ResourceWarning {
  action: 'warning' | 'terminated';
}

// ============================================================================
// Resource Monitor Class
// ============================================================================

/**
 * ResourceMonitor tracks and enforces resource limits for plugin workers
 */
export class ResourceMonitor {
  private plugins = new Map<string, MonitoredPlugin>();
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Configuration
  private checkIntervalMs = 10000; // 10 seconds
  private warningThreshold = 0.8; // 80% of limit
  private terminationThreshold = 1.5; // 150% of limit
  private maxWarningsBeforeTermination = 5;

  constructor(options?: {
    checkIntervalMs?: number;
    warningThreshold?: number;
    terminationThreshold?: number;
    maxWarningsBeforeTermination?: number;
  }) {
    if (options?.checkIntervalMs) this.checkIntervalMs = options.checkIntervalMs;
    if (options?.warningThreshold) this.warningThreshold = options.warningThreshold;
    if (options?.terminationThreshold) this.terminationThreshold = options.terminationThreshold;
    if (options?.maxWarningsBeforeTermination) {
      this.maxWarningsBeforeTermination = options.maxWarningsBeforeTermination;
    }
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.checkInterval = setInterval(() => {
      this.checkAllPlugins();
    }, this.checkIntervalMs);

    logger.info('[ResourceMonitor] Started monitoring');
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    logger.info('[ResourceMonitor] Stopped monitoring');
  }

  /**
   * Register a plugin worker for monitoring
   */
  track(
    pluginId: string,
    worker: PluginWorker,
    limits?: Partial<ResourceLimits>
  ): void {
    const fullLimits: ResourceLimits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...limits,
    };

    const monitored: MonitoredPlugin = {
      pluginId,
      worker,
      limits: fullLimits,
      lastHealth: null,
      warningCount: 0,
      lastWarningAt: 0,
      healthSeq: 0,
      evaluatedHealthSeq: -1,
    };

    this.plugins.set(pluginId, monitored);

    // Listen for health responses
    worker.on('health-response', (health: HealthResponseMessage) => {
      this.updateHealth(pluginId, health);
    });

    logger.debug(`[ResourceMonitor] Tracking plugin ${pluginId}`, { limits: fullLimits });
  }

  /**
   * Stop tracking a plugin
   */
  untrack(pluginId: string): void {
    this.plugins.delete(pluginId);
    logger.debug(`[ResourceMonitor] Untracked plugin ${pluginId}`);
  }

  /**
   * Update health data from a worker
   */
  private updateHealth(pluginId: string, health: HealthResponseMessage): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    const workerHealth = plugin.worker.getHealth();

    plugin.lastHealth = {
      ...workerHealth,
      memoryUsage: {
        heapUsed: health.memoryUsage.heapUsed,
        heapTotal: health.memoryUsage.heapTotal,
        external: health.memoryUsage.external,
        percentUsed: (health.memoryUsage.heapUsed / (plugin.limits.maxHeapMB * 1024 * 1024)) * 100,
      },
      activeRequests: health.activeRequests,
      lastHealthCheck: Date.now(),
    };
    plugin.healthSeq++;

    // Check for violations
    this.checkPluginHealth(plugin);
  }

  /**
   * Check all plugins for resource violations
   */
  private checkAllPlugins(): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.worker.isRunning()) {
        this.checkPluginHealth(plugin);
      }
    }
  }

  /**
   * Check a single plugin for resource violations
   */
  private checkPluginHealth(plugin: MonitoredPlugin): void {
    const health = plugin.lastHealth;
    if (!health) return;

    // updateHealth (event-driven, once per health:response) and
    // checkAllPlugins (its own interval timer) both funnel into here over
    // the same lastHealth snapshot. Score each snapshot once — otherwise a
    // plugin merely in warning territory racks up ~2 warnings per interval
    // and hits maxWarningsBeforeTermination in a fraction of the intended
    // time.
    if (plugin.evaluatedHealthSeq === plugin.healthSeq) return;
    plugin.evaluatedHealthSeq = plugin.healthSeq;

    const memoryMB = health.memoryUsage.heapUsed / (1024 * 1024);
    const memoryLimitMB = plugin.limits.maxHeapMB;
    const memoryPercent = memoryMB / memoryLimitMB;

    // Check memory
    if (memoryPercent >= this.terminationThreshold) {
      // Critical - terminate
      this.handleViolation(plugin, {
        pluginId: plugin.pluginId,
        type: 'memory',
        current: memoryMB,
        limit: memoryLimitMB,
        timestamp: Date.now(),
        action: 'terminated',
      });
    } else if (memoryPercent >= this.warningThreshold) {
      // Warning
      this.handleWarning(plugin, {
        pluginId: plugin.pluginId,
        type: 'memory',
        current: memoryMB,
        limit: memoryLimitMB,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle a resource warning
   */
  private handleWarning(plugin: MonitoredPlugin, warning: ResourceWarning): void {
    plugin.warningCount++;
    plugin.lastWarningAt = Date.now();

    logger.warn(
      `[ResourceMonitor] Plugin ${plugin.pluginId} ${warning.type} warning: ` +
      `${warning.current.toFixed(1)}MB / ${warning.limit}MB (${((warning.current / warning.limit) * 100).toFixed(0)}%)`
    );

    eventBus.emitEvent('plugin:resource-warning', warning);

    // Check if we should terminate due to repeated warnings
    if (plugin.warningCount >= this.maxWarningsBeforeTermination) {
      this.handleViolation(plugin, {
        ...warning,
        action: 'terminated',
      });
    }
  }

  /**
   * Handle a resource violation (terminate plugin)
   */
  private async handleViolation(
    plugin: MonitoredPlugin,
    violation: ResourceViolation
  ): Promise<void> {
    logger.error(
      `[ResourceMonitor] Plugin ${plugin.pluginId} ${violation.type} violation - terminating: ` +
      `${violation.current.toFixed(1)}MB / ${violation.limit}MB`
    );

    eventBus.emitEvent('plugin:resource-violation', violation);

    try {
      await plugin.worker.stop(false); // Force stop
    } catch (error) {
      logger.error(
        `[ResourceMonitor] Failed to terminate plugin ${plugin.pluginId}:`,
        error
      );
    }
  }

  /**
   * Get health for a plugin
   */
  getPluginHealth(pluginId: string): WorkerHealth | null {
    return this.plugins.get(pluginId)?.lastHealth ?? null;
  }

  /**
   * Get health for all plugins
   */
  getAllHealth(): Map<string, WorkerHealth | null> {
    const result = new Map<string, WorkerHealth | null>();
    for (const [pluginId, plugin] of this.plugins) {
      result.set(pluginId, plugin.lastHealth);
    }
    return result;
  }

  /**
   * Get warning count for a plugin
   */
  getWarningCount(pluginId: string): number {
    return this.plugins.get(pluginId)?.warningCount ?? 0;
  }

  /**
   * Reset warning count for a plugin
   */
  resetWarnings(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      plugin.warningCount = 0;
      plugin.lastWarningAt = 0;
    }
  }

  /**
   * Get resource limits for a plugin
   */
  getPluginLimits(pluginId: string): ResourceLimits | null {
    return this.plugins.get(pluginId)?.limits ?? null;
  }

  /**
   * Update resource limits for a plugin
   */
  updatePluginLimits(pluginId: string, limits: Partial<ResourceLimits>): void {
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      plugin.limits = { ...plugin.limits, ...limits };
      logger.debug(`[ResourceMonitor] Updated limits for ${pluginId}`, { limits: plugin.limits });
    }
  }

  /**
   * Get monitoring statistics
   */
  getStats(): {
    totalPlugins: number;
    runningPlugins: number;
    totalWarnings: number;
    pluginsWithWarnings: number;
  } {
    let runningPlugins = 0;
    let totalWarnings = 0;
    let pluginsWithWarnings = 0;

    for (const plugin of this.plugins.values()) {
      if (plugin.worker.isRunning()) {
        runningPlugins++;
      }
      totalWarnings += plugin.warningCount;
      if (plugin.warningCount > 0) {
        pluginsWithWarnings++;
      }
    }

    return {
      totalPlugins: this.plugins.size,
      runningPlugins,
      totalWarnings,
      pluginsWithWarnings,
    };
  }

  /**
   * Check if monitoring is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get tracked plugin count
   */
  get pluginCount(): number {
    return this.plugins.size;
  }

  /**
   * Clear all tracked plugins
   */
  clear(): void {
    this.plugins.clear();
    logger.debug('[ResourceMonitor] Cleared all tracked plugins');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let resourceMonitorInstance: ResourceMonitor | null = null;

/**
 * Get the global ResourceMonitor instance
 */
export function getResourceMonitor(): ResourceMonitor {
  if (!resourceMonitorInstance) {
    resourceMonitorInstance = new ResourceMonitor();
  }
  return resourceMonitorInstance;
}

/**
 * Reset the global ResourceMonitor instance (for testing)
 */
export function resetResourceMonitor(): void {
  if (resourceMonitorInstance) {
    resourceMonitorInstance.stop();
    resourceMonitorInstance.clear();
  }
  resourceMonitorInstance = null;
}
