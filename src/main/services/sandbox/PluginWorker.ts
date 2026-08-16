/**
 * Plugin Worker
 *
 * Manages the lifecycle of a sandboxed plugin running in a Worker Thread.
 * Handles spawning, message routing, health checks, and termination.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  WorkerConfig,
  WorkerState,
  WorkerHealth,
  ResourceLimits,
  DEFAULT_RESOURCE_LIMITS,
  RPCRequest,
  RPCResponse,
  RPCError,
  PluginShutdownMessage,
  HealthCheckMessage,
  HealthResponseMessage,
  CallbackInvokeMessage,
  EventDispatchMessage,
  ToolExecuteMessage,
  WorkerToMainMessage,
  createMessageId,
  SerializableValue
} from './types';
import { RequestCorrelator, serializeError, sanitizeForSerialization } from './protocol';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export interface PluginWorkerEvents {
  ready: () => void;
  error: (error: Error) => void;
  crash: (code: number | null, error?: Error) => void;
  message: (message: WorkerToMainMessage) => void;
  'rpc-request': (request: RPCRequest) => void;
  'event-subscribe': (eventType: string, callbackId: string) => void;
  'event-unsubscribe': (eventType: string, callbackId: string) => void;
  'event-emit': (eventType: string, data: SerializableValue) => void;
  'tool-result': (executionId: string, result: SerializableValue, error?: Error) => void;
  'callback-result': (invocationId: string, result: SerializableValue) => void;
  'callback-error': (invocationId: string, error: Error) => void;
  'health-response': (health: HealthResponseMessage) => void;
}

// ============================================================================
// Plugin Worker Class
// ============================================================================

/**
 * PluginWorker manages a single plugin running in a Worker Thread
 */
export class PluginWorker extends EventEmitter {
  private worker: Worker | null = null;
  private state: WorkerState = 'idle';
  private config: WorkerConfig;
  private resourceLimits: ResourceLimits;
  private startTime: number = 0;
  private restartCount: number = 0;
  private lastHealthCheck: number = 0;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private rpcCorrelator: RequestCorrelator;

  // Stored once so start()'s failure path can detach exactly the listeners
  // it attached (a fresh `.bind(this)` per call can't be removeListener'd).
  private readonly boundHandleMessage = this.handleMessage.bind(this);
  private readonly boundHandleError = this.handleError.bind(this);
  private readonly boundHandleExit = this.handleExit.bind(this);

  constructor(config: WorkerConfig) {
    super();
    this.config = config;
    this.resourceLimits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...config.resourceLimits,
    };
    this.rpcCorrelator = new RequestCorrelator(this.resourceLimits.apiTimeoutMs);
    // executeTool() adds one 'tool-result' listener per in-flight call; with
    // many concurrent plugin tool calls that's expected, not a leak, so don't
    // let Node's default cap of 10 spam MaxListenersExceededWarning.
    this.setMaxListeners(0);
  }

  /**
   * Get the plugin ID
   */
  get pluginId(): string {
    return this.config.pluginId;
  }

  /**
   * Get current worker state
   */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.state === 'ready' || this.state === 'running';
  }

  /**
   * Start the worker
   */
  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'stopped' && this.state !== 'crashed') {
      throw new Error(`Cannot start worker in state: ${this.state}`);
    }

    this.state = 'starting';
    this.startTime = Date.now();

    try {
      // Create the worker
      this.worker = new Worker(
        path.join(__dirname, 'worker-entry.js'),
        {
          workerData: {
            pluginId: this.config.pluginId,
            manifestPath: this.config.manifestPath,
            entryPath: this.config.entryPath,
            permissions: this.config.permissions,
            config: this.config.config,
            // Resolved paths so plugins don't need to require('electron').
            // Worker threads don't have access to the Electron app object;
            // pass the values that matter (userData + derived dirs) on the
            // workerData blob instead.
            paths: {
              userData: this.config.userDataPath,
              avatars: this.config.avatarsPath,
            },
          },
          resourceLimits: {
            maxYoungGenerationSizeMb: Math.floor(this.resourceLimits.maxHeapMB * 0.25),
            maxOldGenerationSizeMb: this.resourceLimits.maxOldGenerationMB,
          },
        }
      );

      // Set up event handlers
      this.worker.on('message', this.boundHandleMessage);
      this.worker.on('error', this.boundHandleError);
      this.worker.on('exit', this.boundHandleExit);

      // Wait for ready signal
      await this.waitForReady();

      this.state = 'ready';
      this.startHealthChecks();

      logger.info(`[PluginWorker] Plugin ${this.config.pluginId} started successfully`);
    } catch (error) {
      // A plugin whose activate() never resolves (or that errors before
      // ready) must not keep its thread running untracked: terminate it and
      // detach the listeners we just attached so a late/stray message can't
      // route back into a manager that's about to unregister this plugin's
      // gate and bridges.
      await this.terminateOrphan();
      this.state = 'crashed';
      throw error;
    }
  }

  /**
   * Hard-kill a worker thread that failed to come up cleanly and detach the
   * listeners start() installed. Safe to call even if the worker never got
   * created.
   */
  private async terminateOrphan(): Promise<void> {
    this.stopHealthChecks();
    if (!this.worker) return;

    const worker = this.worker;
    this.worker = null;
    worker.off('message', this.boundHandleMessage);
    worker.off('error', this.boundHandleError);
    worker.off('exit', this.boundHandleExit);

    try {
      await worker.terminate();
    } catch (error) {
      logger.warn(
        `[PluginWorker] Failed to terminate orphaned worker for ${this.config.pluginId}:`,
        error
      );
    }
  }

  /**
   * Wait for the worker to signal ready
   */
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Plugin ${this.config.pluginId} failed to start within timeout`));
      }, 30000);

      const onReady = () => {
        clearTimeout(timeout);
        this.removeListener('error', onError);
        resolve();
      };

      const onError = (error: Error) => {
        clearTimeout(timeout);
        this.removeListener('ready', onReady);
        reject(error);
      };

      this.once('ready', onReady);
      this.once('error', onError);
    });
  }

  /**
   * Stop the worker gracefully
   */
  async stop(graceful = true): Promise<void> {
    if (!this.worker || this.state === 'stopped' || this.state === 'idle') {
      return;
    }

    this.state = 'stopping';
    this.stopHealthChecks();

    if (graceful) {
      // Send shutdown message and wait
      try {
        await this.sendShutdown(true);
        await this.waitForExit(5000);
      } catch {
        // Timeout - force terminate
        logger.warn(`[PluginWorker] Plugin ${this.config.pluginId} did not shut down gracefully`);
      }
    }

    // Force terminate if still running
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }

    this.state = 'stopped';
    this.rpcCorrelator.cancelAll('Worker stopped');

    logger.info(`[PluginWorker] Plugin ${this.config.pluginId} stopped`);
  }

  /**
   * Wait for worker to exit
   */
  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Exit timeout'));
      }, timeoutMs);

      const onExit = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.worker?.once('exit', onExit);
    });
  }

  /**
   * Send a shutdown message to the worker
   */
  private sendShutdown(graceful: boolean): void {
    const message: PluginShutdownMessage = {
      type: 'plugin:shutdown',
      id: createMessageId(),
      pluginId: this.config.pluginId,
      timestamp: Date.now(),
      graceful,
    };
    this.worker?.postMessage(message);
  }

  /**
   * Handle incoming message from worker
   */
  private handleMessage(message: WorkerToMainMessage): void {
    if (!message || typeof message !== 'object') {
      logger.warn(`[PluginWorker] Invalid message from ${this.config.pluginId}`);
      return;
    }

    switch (message.type) {
      case 'plugin:ready':
        this.emit('ready');
        break;

      case 'plugin:error':
        this.emit('error', new Error(message.error.message));
        break;

      case 'rpc:request':
        // Fail closed: a crashed/stopped worker must never be resurrected by
        // an inbound message. This is the backstop for terminateOrphan()
        // detaching listeners on start() failure — even if a stray message
        // still reaches here, don't let it flip state back to 'running' and
        // re-enter handleRPCRequest with a permissioned surface that may be
        // about to be (or already was) unregistered.
        if (!this.worker || this.state === 'crashed' || this.state === 'stopped') {
          logger.warn(
            `[PluginWorker] Dropping rpc:request from a dead worker: ${this.config.pluginId}`
          );
          return;
        }
        this.state = 'running';
        this.emit('rpc-request', message);
        break;

      case 'event:subscribe':
        this.emit('event-subscribe', message.eventType, message.callbackId);
        break;

      case 'event:unsubscribe':
        this.emit('event-unsubscribe', message.eventType, message.callbackId);
        break;

      case 'event:emit':
        this.emit('event-emit', message.eventType, message.data);
        break;

      case 'tool:result':
        this.emit('tool-result', message.executionId, message.result, message.error ? new Error(message.error.message) : undefined);
        break;

      case 'callback:result':
        this.emit('callback-result', message.invocationId, message.result);
        break;

      case 'callback:error':
        this.emit('callback-error', message.invocationId, new Error(message.error.message));
        break;

      case 'health:response':
        this.lastHealthCheck = Date.now();
        this.emit('health-response', message);
        break;

      default:
        this.emit('message', message);
    }
  }

  /**
   * Handle worker error
   */
  private handleError(error: Error): void {
    logger.error(`[PluginWorker] Error from ${this.config.pluginId}:`, error);
    this.emit('error', error);
  }

  /**
   * Handle worker exit
   */
  private handleExit(code: number): void {
    this.stopHealthChecks();
    this.rpcCorrelator.cancelAll('Worker exited');

    const stopping = this.state === 'stopping' || this.state === 'stopped';

    // Exit code 0 is a clean exit, whether or not we asked for it — a plugin
    // whose entry simply returns is not a crash, and reporting it as one
    // inflated restartCount and put a scary line in the log for normal
    // shutdown. Only a non-zero code is a crash.
    if (!stopping && code !== 0) {
      this.state = 'crashed';
      this.restartCount++;
      logger.error(`[PluginWorker] Plugin ${this.config.pluginId} crashed with code ${code}`);
      this.emit('crash', code);
    } else {
      this.state = 'stopped';

      if (!stopping) {
        logger.info(`[PluginWorker] Plugin ${this.config.pluginId} exited cleanly`);
        // Clean, but nobody asked for it — so anything waiting on this worker
        // is still waiting. Not a crash (no restart count, no error), but it
        // has to be terminal for callers, or a tool call in flight blocks for
        // the full 120s timeout with the worker already gone.
        this.emit('exited', code);
      }
    }

    this.worker = null;
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      this.sendHealthCheck();
    }, this.resourceLimits.healthCheckIntervalMs);
  }

  /**
   * Stop health checks
   */
  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Send a health check message
   */
  private sendHealthCheck(): void {
    if (!this.worker || !this.isRunning()) return;

    const message: HealthCheckMessage = {
      type: 'health:check',
      id: createMessageId(),
      pluginId: this.config.pluginId,
      timestamp: Date.now(),
    };
    this.worker.postMessage(message);
  }

  /**
   * Send an RPC response to the worker
   */
  sendRPCResponse(requestId: string, result: SerializableValue): void {
    if (!this.worker) return;

    const message: RPCResponse = {
      type: 'rpc:response',
      id: createMessageId(),
      pluginId: this.config.pluginId,
      timestamp: Date.now(),
      requestId,
      result: sanitizeForSerialization(result),
    };
    this.worker.postMessage(message);
  }

  /**
   * Send an RPC error to the worker
   */
  sendRPCError(requestId: string, error: Error | string): void {
    if (!this.worker) return;

    const message: RPCError = {
      type: 'rpc:error',
      id: createMessageId(),
      pluginId: this.config.pluginId,
      timestamp: Date.now(),
      requestId,
      error: serializeError(error),
    };
    this.worker.postMessage(message);
  }

  /**
   * Dispatch an event to the worker
   */
  dispatchEvent(eventType: string, data: SerializableValue, source?: string): void {
    if (!this.worker || !this.isRunning()) return;

    const message: EventDispatchMessage = {
      type: 'event:dispatch',
      id: createMessageId(),
      pluginId: this.config.pluginId,
      timestamp: Date.now(),
      eventType,
      data: sanitizeForSerialization(data),
      source,
    };
    this.worker.postMessage(message);
  }

  /**
   * Invoke a callback in the worker
   */
  invokeCallback(callbackId: string, invocationId: string, args: SerializableValue[]): void {
    if (!this.worker || !this.isRunning()) return;

    const message: CallbackInvokeMessage = {
      type: 'callback:invoke',
      id: createMessageId(),
      pluginId: this.config.pluginId,
      timestamp: Date.now(),
      callbackId,
      invocationId,
      args: args.map((arg) => sanitizeForSerialization(arg)),
    };
    this.worker.postMessage(message);
  }

  /**
   * Execute a tool in the worker
   */
  async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<SerializableValue> {
    if (!this.worker || !this.isRunning()) {
      throw new Error(`Worker ${this.config.pluginId} is not running`);
    }

    const executionId = createMessageId();

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener('tool-result', onResult);
        this.removeListener('crash', onCrash);
        this.removeListener('exited', onExited);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Tool ${toolName} execution timed out`));
      }, this.resourceLimits.toolTimeoutMs);

      const onResult = (
        resultExecutionId: string,
        result: SerializableValue,
        error?: Error
      ) => {
        if (resultExecutionId !== executionId) return;

        cleanup();

        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      // Without these, a worker that dies mid-call leaves the caller blocked
      // for the full tool timeout (up to 120s) instead of failing promptly.
      // Both endings have to be covered: a plugin that exits 0 while a call is
      // in flight is not a crash, but the call is just as dead.
      const onCrash = () => {
        cleanup();
        reject(new Error(`Plugin ${this.config.pluginId} crashed during tool ${toolName} execution`));
      };

      const onExited = () => {
        cleanup();
        reject(new Error(`Plugin ${this.config.pluginId} exited during tool ${toolName} execution`));
      };

      this.on('tool-result', onResult);
      this.once('crash', onCrash);
      this.once('exited', onExited);

      const message: ToolExecuteMessage = {
        type: 'tool:execute',
        id: createMessageId(),
        pluginId: this.config.pluginId,
        timestamp: Date.now(),
        executionId,
        toolName,
        args,
      };
      this.worker!.postMessage(message);
    });
  }

  /**
   * Get worker health information
   */
  getHealth(): WorkerHealth {
    return {
      state: this.state,
      memoryUsage: {
        heapUsed: 0, // Updated by health response
        heapTotal: 0,
        external: 0,
        percentUsed: 0,
      },
      activeRequests: this.rpcCorrelator.size,
      lastHealthCheck: this.lastHealthCheck,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      restartCount: this.restartCount,
    };
  }

  /**
   * Get resource limits
   */
  getResourceLimits(): ResourceLimits {
    return { ...this.resourceLimits };
  }

  /**
   * Get restart count
   */
  getRestartCount(): number {
    return this.restartCount;
  }

  /**
   * Reset restart count
   */
  resetRestartCount(): void {
    this.restartCount = 0;
  }
}
