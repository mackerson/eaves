/**
 * Sandboxed Plugin Manager
 *
 * Main orchestrator for the sandboxed plugin system.
 * Manages plugin discovery, loading, lifecycle, and coordinates
 * between workers, bridges, and the permission system.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { PluginManifest } from '../../types';
import { PluginManifestSchema, validateWithSchema, isValidationFailure } from '../../../shared/validation';
import { eventBus } from '../EventBus';
import { logger } from '../logger';
import { getPluginConfigManager } from '../PluginConfigManager';

import { PluginWorker } from './PluginWorker';
import {
  PluginPermission,
  WorkerConfig,
  RPCRequest,
  SerializableValue
} from './types';
import { getPermissionGate } from './PermissionGate';
import { getCallbackRegistry } from './CallbackRegistry';
import { getEventBridge } from './EventBridge';
import { getToolBridge } from './ToolBridge';
import { getServiceBridge } from './ServiceBridge';
import { getResourceMonitor } from './ResourceMonitor';
import { readInstalledPluginId, sanitizeFolderName } from './pathContainment';

import {
  getPluginStorageRepository,
  getPluginStateRepository,
} from '../../repositories';
import { dispatchDataMethod } from '../PluginDataAccess';

// ============================================================================
// Types
// ============================================================================

interface LoadedPlugin {
  manifest: PluginManifest;
  worker: PluginWorker;
  enabled: boolean;
  loadedAt: number;
}

interface RegisteredView {
  id: string;
  title: string;
  icon?: string;
  component: string;
  showInSidebar?: boolean;
  pluginId: string;
}

interface RegisteredTerminalView {
  id: string;
  title: string;
  icon?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  pluginId: string;
}

interface RegisteredTool {
  name: string;
  tool: {
    description: string;
    inputSchema?: unknown;
    execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
    needsApproval?: boolean;
  };
  pluginId: string;
}

// ============================================================================
// Sandboxed Plugin Manager
// ============================================================================

/**
 * SandboxedPluginManager handles sandboxed plugin lifecycle
 */
export class SandboxedPluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private bundledPluginsDir: string;
  private userPluginsDir: string;
  private sourcePluginsDir: string | null = null;

  // Centralized registries for views, terminal views, and tools
  private registeredViews = new Map<string, RegisteredView>();
  private viewCache = new Map<string, RegisteredView[]>();
  private registeredTerminalViews = new Map<string, RegisteredTerminalView>();
  private registeredTools = new Map<string, RegisteredTool>();
  private reloadingPlugins = new Set<string>();

  // Bridges and services
  private permissionGate = getPermissionGate();
  private callbackRegistry = getCallbackRegistry();
  private eventBridge = getEventBridge();
  private toolBridge = getToolBridge();
  private serviceBridge = getServiceBridge();
  private resourceMonitor = getResourceMonitor();

  constructor() {
    const appPath = app.getAppPath();

    // Bundled plugins: {appPath}/dist/plugins/
    this.bundledPluginsDir = path.join(appPath, 'dist', 'plugins');

    // User plugins: {userData}/plugins/
    this.userPluginsDir = path.join(app.getPath('userData'), 'plugins');

    // Source plugins (dev only): {appPath}/plugins/
    if (!app.isPackaged) {
      this.sourcePluginsDir = path.join(appPath, 'plugins');
      logger.info('[SandboxedPluginManager] Dev mode: Source plugins enabled');
    }

    logger.info('[SandboxedPluginManager] Initialized', {
      bundledPluginsDir: this.bundledPluginsDir,
      userPluginsDir: this.userPluginsDir,
      sourcePluginsDir: this.sourcePluginsDir,
    });

    this.ensurePluginsDirectory();

    // View registrations arrive as bus events, not direct calls — a worker's
    // `registerView` action is re-emitted here (see handleUIRequest), and this
    // listener owns the registry the renderer reads.
    eventBus.onEvent('plugin:view:registered', (event) => {
      const data = event.data as Record<string, unknown> | undefined;
      const view = data?.view as RegisteredView | undefined;
      const pluginId = data?.pluginId as string | undefined;
      if (view && pluginId) {
        const registeredView: RegisteredView = { ...view, pluginId };
        this.registeredViews.set(view.id, registeredView);
        // Update cache
        const cached = this.viewCache.get(pluginId) || [];
        const idx = cached.findIndex(v => v.id === view.id);
        if (idx >= 0) cached[idx] = registeredView; else cached.push(registeredView);
        this.viewCache.set(pluginId, cached);
      }
    });

    // Listen for terminal view registrations
    eventBus.onEvent('plugin:terminal-view:registered', (event) => {
      const data = event.data as Record<string, unknown> | undefined;
      const view = data?.view as RegisteredTerminalView | undefined;
      const pluginId = data?.pluginId as string | undefined;
      if (view && pluginId) {
        this.registeredTerminalViews.set(view.id, { ...view, pluginId });
      }
    });

    // Listen for plugin tool registrations
    eventBus.onEvent('plugin:tool:registered', (event) => {
      const data = event.data as Record<string, unknown> | undefined;
      const name = data?.name as string | undefined;
      const tool = data?.tool as RegisteredTool['tool'] | undefined;
      const pluginId = data?.pluginId as string | undefined;
      if (name && tool && pluginId) {
        this.registeredTools.set(name, { name, tool, pluginId });
      }
    });

    // Listen for plugin tool unregistrations
    eventBus.onEvent('plugin:tool:unregistered', (event) => {
      const data = event.data as Record<string, unknown> | undefined;
      const name = data?.name as string | undefined;
      if (name) {
        this.registeredTools.delete(name);
      }
    });

    // ResourceMonitor force-stops a worker with worker.stop(false), which
    // intentionally suppresses PluginWorker's own 'crash' event (a policy
    // termination isn't a crash) — so without this we'd keep listing the
    // plugin as loaded+enabled after the kill and keep handing its tools to
    // the AI SDK, which would then throw "not running" on every call with no
    // signal anything happened. Drop it from the live surface the same way
    // disablePlugin does.
    eventBus.onEvent('plugin:resource-violation', (event) => {
      const data = event.data as { pluginId?: string; action?: string } | undefined;
      if (data?.action === 'terminated' && data.pluginId) {
        this.handleResourceTermination(data.pluginId);
      }
    });
  }

  /**
   * React to a ResourceMonitor-initiated kill: the worker is already stopped,
   * so just tear down the bridges/gate that still think it's live and flip
   * the in-memory `enabled` flag (not persisted — this is a transient policy
   * action, not the user choosing to disable the plugin, so it should come
   * back on next launch).
   */
  private handleResourceTermination(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.enabled) return;

    plugin.enabled = false;
    this.eventBridge.unregisterWorker(pluginId);
    this.toolBridge.unregisterWorker(pluginId);
    this.serviceBridge.unregisterWorker(pluginId);
    this.permissionGate.unregisterPlugin(pluginId);

    logger.warn(`[SandboxedPluginManager] Plugin ${pluginId} disabled after resource termination`);
    eventBus.emitEvent('plugin:disabled', { pluginId, manifest: plugin.manifest, reason: 'resource-violation' });
  }

  /**
   * Ensure user plugins directory exists
   */
  private ensurePluginsDirectory(): void {
    if (!fs.existsSync(this.userPluginsDir)) {
      fs.mkdirSync(this.userPluginsDir, { recursive: true });
      logger.info('[SandboxedPluginManager] Created user plugins directory');
    }
  }

  /**
   * Initialize the sandbox system
   */
  async initialize(): Promise<void> {
    // Start resource monitoring
    this.resourceMonitor.start();

    // Discover and load plugins
    await this.discoverAndLoadPlugins();

    logger.info('[SandboxedPluginManager] Initialization complete');
  }

  /**
   * Shutdown the sandbox system
   */
  async shutdown(): Promise<void> {
    logger.info('[SandboxedPluginManager] Shutting down...');

    // Stop all plugins
    for (const pluginId of this.plugins.keys()) {
      await this.unloadPlugin(pluginId);
    }

    // Stop monitoring
    this.resourceMonitor.stop();

    logger.info('[SandboxedPluginManager] Shutdown complete');
  }

  /**
   * Discover and load all plugins
   */
  async discoverAndLoadPlugins(): Promise<void> {
    const manifests = await this.discoverPlugins();

    for (const manifest of manifests) {
      if (!manifest.sandboxVersion) {
        logger.info(`[SandboxedPluginManager] Skipping non-sandboxed plugin: ${manifest.id}`);
        continue;
      }
      try {
        await this.loadPlugin(manifest);
      } catch (error) {
        logger.error(
          `[SandboxedPluginManager] Failed to load plugin ${manifest.id}:`,
          error
        );
      }
    }
  }

  /**
   * Discover plugins from all directories
   */
  async discoverPlugins(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];
    const seenIds = new Set<string>();

    // Priority: dev > user > bundled
    const directories: Array<{ dir: string; source: 'bundled' | 'user' | 'dev' }> = [];

    if (this.sourcePluginsDir && fs.existsSync(this.sourcePluginsDir)) {
      directories.push({ dir: this.sourcePluginsDir, source: 'dev' });
    }
    if (fs.existsSync(this.userPluginsDir)) {
      directories.push({ dir: this.userPluginsDir, source: 'user' });
    }
    if (fs.existsSync(this.bundledPluginsDir)) {
      directories.push({ dir: this.bundledPluginsDir, source: 'bundled' });
    }

    for (const { dir, source } of directories) {
      const discovered = await this.discoverPluginsInDirectory(dir, source);
      for (const manifest of discovered) {
        if (!seenIds.has(manifest.id)) {
          seenIds.add(manifest.id);
          manifests.push(manifest);
        }
      }
    }

    return manifests;
  }

  /**
   * Discover plugins in a directory
   */
  private async discoverPluginsInDirectory(
    directory: string,
    source: 'bundled' | 'user' | 'dev'
  ): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true });

      for (const entry of entries) {
        // `withFileTypes` reports from lstat, so a symlink is never isDirectory()
        // — which silently disabled the entire dev-symlink load path, since
        // `yarn setup:plugins` populates plugins/ with symlinks to sibling repos.
        // Dev appeared to work only because the same plugins were also present in
        // dist/plugins, so edits in a linked repo did nothing until a rebuild.
        // Resolve links and ask the filesystem what they actually point at.
        const pluginDir = path.join(directory, entry.name);
        if (!entry.isDirectory()) {
          if (!entry.isSymbolicLink()) continue;
          try {
            if (!fs.statSync(pluginDir).isDirectory()) continue;
          } catch {
            continue; // dangling link — a stale sibling checkout, not a plugin
          }
        }

        const manifestPath = path.join(pluginDir, 'plugin.json');

        if (!fs.existsSync(manifestPath)) continue;

        try {
          const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
          const manifestData = JSON.parse(manifestContent);

          // Validate manifest
          const validation = validateWithSchema(PluginManifestSchema, manifestData);
          if (isValidationFailure(validation)) {
            logger.warn(
              `[SandboxedPluginManager] Invalid manifest in ${pluginDir}:`,
              validation.error
            );
            continue;
          }

          const manifest = {
            ...validation.data,
            path: pluginDir,
            source,
            folderName: entry.name,
          } as PluginManifest;

          manifests.push(manifest);
        } catch (error) {
          logger.warn(
            `[SandboxedPluginManager] Failed to read manifest in ${pluginDir}:`,
            error
          );
        }
      }
    } catch (error) {
      logger.warn(
        `[SandboxedPluginManager] Failed to read directory ${directory}:`,
        error
      );
    }

    return manifests;
  }

  /**
   * Load a sandboxed plugin
   */
  async loadPlugin(manifest: PluginManifest): Promise<void> {
    const pluginId = manifest.id;

    if (this.plugins.has(pluginId)) {
      logger.warn(`[SandboxedPluginManager] Plugin ${pluginId} already loaded`);
      return;
    }

    logger.info(`[SandboxedPluginManager] Loading plugin: ${manifest.name} (${pluginId})`);

    const pluginPath = manifest.path!;
    const entryPath = path.join(pluginPath, manifest.entry || 'index.js');

    if (!fs.existsSync(entryPath)) {
      throw new Error(`Plugin entry point not found: ${entryPath}`);
    }

    const worker = await this.spawnWorker(manifest);

    const persistedState = getPluginStateRepository().isEnabled(pluginId);
    const enabled = persistedState !== null ? persistedState : true;

    this.plugins.set(pluginId, {
      manifest,
      worker,
      enabled,
      loadedAt: Date.now(),
    });

    eventBus.emitEvent('plugin:loaded', { pluginId, manifest });

    logger.info(`[SandboxedPluginManager] Plugin ${pluginId} loaded successfully`);
  }

  /**
   * Build a worker config for a manifest: resolves Electron paths (worker
   * threads can't `require('electron').app` themselves) and the plugin's
   * persisted user config.
   */
  private buildWorkerConfig(manifest: PluginManifest): WorkerConfig {
    const pluginPath = manifest.path!;
    const configManager = getPluginConfigManager();
    const userDataPath = app.getPath('userData');

    return {
      pluginId: manifest.id,
      manifestPath: path.join(pluginPath, 'plugin.json'),
      entryPath: path.join(pluginPath, manifest.entry || 'index.js'),
      permissions: (manifest.permissions || []) as PluginPermission[],
      config: configManager.getConfig(manifest.id),
      userDataPath,
      avatarsPath: path.join(userDataPath, 'avatars'),
    };
  }

  /**
   * Register a plugin's permissions/bridges/monitoring and start its worker.
   * Shared by loadPlugin and enablePlugin so both spin a worker up the same
   * way. On failure, tears all of that back down — worker.start() itself
   * already terminates the underlying thread and detaches its own listeners
   * (see PluginWorker.terminateOrphan), so a failed spawn never leaves an
   * orphan worker holding a permissioned surface; this only needs to detach
   * the PluginWorker-level listeners setupWorkerHandlers installed.
   */
  private async spawnWorker(manifest: PluginManifest): Promise<PluginWorker> {
    const pluginId = manifest.id;
    const workerConfig = this.buildWorkerConfig(manifest);

    this.permissionGate.registerPlugin(pluginId, workerConfig.permissions);

    const worker = new PluginWorker(workerConfig);
    this.setupWorkerHandlers(pluginId, worker);

    // EventBridge gets the permission gate so plugin event subscribe/emit are
    // permission-checked (events:listen / events:emit) just like the RPC surface.
    this.eventBridge.registerWorker(pluginId, worker, this.permissionGate);
    this.toolBridge.registerWorker(pluginId, worker);
    this.serviceBridge.registerWorker(pluginId, worker);
    this.resourceMonitor.track(pluginId, worker);

    try {
      await worker.start();
    } catch (error) {
      this.permissionGate.unregisterPlugin(pluginId);
      this.eventBridge.unregisterWorker(pluginId);
      this.toolBridge.unregisterWorker(pluginId);
      this.serviceBridge.unregisterWorker(pluginId);
      this.resourceMonitor.untrack(pluginId);
      worker.removeAllListeners();
      throw error;
    }

    return worker;
  }

  /**
   * Set up message handlers for a worker
   */
  private setupWorkerHandlers(pluginId: string, worker: PluginWorker): void {
    // Handle RPC requests from worker
    worker.on('rpc-request', async (request: RPCRequest) => {
      try {
        const result = await this.handleRPCRequest(pluginId, request);
        worker.sendRPCResponse(request.id, result as SerializableValue);
      } catch (error) {
        worker.sendRPCError(
          request.id,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    // Handle crashes
    worker.on('crash', (code: number | null) => {
      logger.error(
        `[SandboxedPluginManager] Plugin ${pluginId} crashed with code ${code}`
      );
      eventBus.emitEvent('plugin:crash', { pluginId, code });
    });

    // Handle errors
    worker.on('error', (error: Error) => {
      logger.error(`[SandboxedPluginManager] Plugin ${pluginId} error:`, error);
      eventBus.emitEvent('plugin:error', { pluginId, error: error.message });
    });
  }

  /**
   * Handle an RPC request from a worker
   */
  private async handleRPCRequest(
    pluginId: string,
    request: RPCRequest
  ): Promise<unknown> {
    // Check permissions
    this.permissionGate.assertPermission(
      pluginId,
      request.namespace,
      request.method
    );

    // Route to appropriate handler
    switch (request.namespace) {
      case 'data':
        return this.handleDataRequest(request.method, request.args);
      case 'actions':
        return this.handleActionsRequest(pluginId, request.method, request.args);
      case 'ui':
        return this.handleUIRequest(pluginId, request.method, request.args);
      case 'tools':
        return this.handleToolsRequest(pluginId, request.method, request.args);
      case 'services':
        return this.handleServicesRequest(pluginId, request.method, request.args);
      case 'storage':
        return this.handleStorageRequest(pluginId, request.method, request.args);
      default:
        throw new Error(`Unknown namespace: ${request.namespace}`);
    }
  }

  /**
   * Handle data namespace requests
   */
  private async handleDataRequest(
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return dispatchDataMethod(method, args);
  }

  /**
   * Handle actions namespace requests
   */
  private async handleActionsRequest(
    pluginId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (method) {
      case 'createAgent': {
        // Plugins call this to actually persist a new agent. Earlier this
        // case just fired a plugin:action:createAgent event into the void
        // and returned {success: true} — no listener ever wrote to the DB,
        // so character-card-import "completed" without an agent existing.
        // Validate against the same schema agents IPC uses, then go straight
        // through AgentRepository so plugin-created agents get the same
        // shape as user-created ones.
        const { CreateAgentIPCSchema } = await import('../../../shared/validation');
        const { getAgentRepository, getChannelRepository } = await import('../../repositories');
        const validation = CreateAgentIPCSchema.safeParse(args[0]);
        if (!validation.success) {
          logger.warn('[SandboxedPluginManager] createAgent rejected by validator', {
            pluginId, errors: validation.error.flatten(),
          });
          return { success: false, error: validation.error.message };
        }
        const data = validation.data as unknown as Record<string, unknown>;
        const agent = getAgentRepository().create({
          ...data,
          color: (data.color as string | undefined) ?? '#667eea',
          temperature: (data.temperature as number | undefined) ?? 0.7,
        } as Parameters<ReturnType<typeof getAgentRepository>['create']>[0]);

        // Mirror the agents IPC: auto-add to #general so the agent shows up
        // in the channels list immediately.
        try {
          const channelRepo = getChannelRepository();
          const channels = channelRepo.getAll({ includeMessages: false });
          const general = channels.find(c => c.name === 'general' && c.type === 'public');
          if (general && !general.participants.some(p => p.id === agent.id)) {
            channelRepo.addParticipant(general.id, {
              id: agent.id,
              type: 'agent',
              displayName: agent.name,
              color: agent.color,
              joinedAt: Date.now(),
            });
          }
        } catch (e) {
          logger.warn('[SandboxedPluginManager] could not add agent to #general', {
            pluginId, agentId: agent.id, error: e instanceof Error ? e.message : String(e),
          });
        }

        eventBus.emitEvent('plugin:action:createAgent', { pluginId, args, agentId: agent.id });
        // Tell the renderer to refresh its agent list — its store didn't
        // hear about this create through the usual window.electron.createAgent
        // path, since the plugin went through the sandbox actions surface.
        eventBus.emitEvent('agent:created', { id: agent.id, name: agent.name });
        return agent;
      }
      case 'createTask': {
        // Persist through ProjectRepository (same path as builtinTools' add_task)
        // and emit the host `task:created` from HERE. A sandboxed plugin cannot
        // emit host-owned events itself (anti-forgery deny-list), so the
        // authoritative event must originate in the host after a real write —
        // otherwise the create is a no-op and no renderer refresh fires.
        const [projectId, content] = args as [string, string];
        if (typeof projectId !== 'string' || typeof content !== 'string') {
          return { success: false, error: 'createTask expects (projectId, content)' };
        }
        const { getProjectRepository } = await import('../../repositories');
        const task = getProjectRepository().createTask(projectId, { content });
        eventBus.emitEvent('task:created', { taskId: task.id, projectId });
        return task;
      }
      case 'createNote': {
        const [projectId, content] = args as [string, string];
        if (typeof projectId !== 'string' || typeof content !== 'string') {
          return { success: false, error: 'createNote expects (projectId, content)' };
        }
        const { getProjectRepository } = await import('../../repositories');
        const note = getProjectRepository().createNote(projectId, { content });
        eventBus.emitEvent('note:created', { noteId: note.id, projectId });
        return note;
      }
      case 'createChat': {
        // chatgpt-import creates one direct chat per imported conversation.
        // A "chat" IS a type='direct' channel, so route to
        // ChannelRepository.createDirectChat (event-silent by design — the
        // import wizard reloads the renderer on completion). Returns the Chat;
        // the plugin reads `.id`.
        const params = args[0] as { name?: unknown; agentId?: unknown; tags?: unknown };
        if (!params || typeof params.name !== 'string' || typeof params.agentId !== 'string') {
          return { success: false, error: 'createChat expects { name, agentId, tags? }' };
        }
        const { getChannelRepository } = await import('../../repositories');
        return getChannelRepository().createDirectChat({
          name: params.name,
          agentId: params.agentId,
          tags: typeof params.tags === 'string' ? params.tags : undefined,
        });
      }
      case 'bulkImportMessages': {
        // Two-pass, event-silent bulk insert built for imports (parent links
        // remapped via each message's originalId). Messages carry their own id
        // + originalId + parentMessageId from the converter; inject the chatId.
        const [chatId, messages] = args as [string, Array<Record<string, unknown>>];
        if (typeof chatId !== 'string' || !Array.isArray(messages)) {
          return { success: false, error: 'bulkImportMessages expects (chatId, messages[])' };
        }
        const { getChannelRepository } = await import('../../repositories');
        const repo = getChannelRepository();
        const withChatId = messages.map(m => ({ ...m, chatId }));
        return repo.bulkCreateDirectMessages(
          withChatId as unknown as Parameters<typeof repo.bulkCreateDirectMessages>[0]
        );
      }
      case 'bulkImportAttachments': {
        // Attachment rows already carry the deterministic messageId the bulk
        // message insert used, so FKs resolve (import runs messages first).
        const attachments = args[0] as Array<Record<string, unknown>>;
        if (!Array.isArray(attachments)) {
          return { success: false, error: 'bulkImportAttachments expects an array of attachments' };
        }
        const { getMessageAttachmentRepository } = await import('../../repositories');
        const repo = getMessageAttachmentRepository();
        return repo.bulkCreate(
          attachments as unknown as Parameters<typeof repo.bulkCreate>[0]
        );
      }
      default:
        // sendMessage / switchProject / switchChannel / switchChat were
        // never-implemented placeholders from the initial sandbox API and had
        // no plugin consumer; removed rather than left returning fake success.
        throw new Error(`Unknown actions method: ${method}`);
    }
  }

  /**
   * Handle UI namespace requests
   */
  private async handleUIRequest(
    pluginId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (method) {
      case 'showNotification':
        eventBus.emitEvent('plugin:ui:notification', {
          pluginId,
          message: args[0],
          type: args[1],
        });
        return { success: true };
      case 'showToast':
        eventBus.emitEvent('plugin:ui:toast', {
          pluginId,
          message: args[0],
          duration: args[1],
        });
        return { success: true };
      case 'registerView':
        eventBus.emitEvent('plugin:view:registered', {
          pluginId,
          view: args[0],
        });
        return { success: true };
      case 'registerTerminalView':
        eventBus.emitEvent('plugin:terminal-view:registered', {
          pluginId,
          view: args[0],
        });
        return { success: true };
      case 'registerSidebarItem':
        eventBus.emitEvent('plugin:sidebar:registered', {
          pluginId,
          item: args[0],
        });
        return { success: true };
      case 'registerCommand':
        eventBus.emitEvent('plugin:command:registered', {
          pluginId,
          command: args[0],
        });
        return { success: true };
      default:
        throw new Error(`Unknown UI method: ${method}`);
    }
  }

  /**
   * Handle tools namespace requests
   */
  private async handleToolsRequest(
    pluginId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (method) {
      case 'register': {
        const [toolName, rawToolDef] = args as [string, Record<string, unknown>];
        // worker-entry normalizes to `inputSchema`; tolerate `parameters` so
        // a plugin built against an older worker shim still registers.
        const schema = (rawToolDef.inputSchema ?? rawToolDef.parameters) as
          { type: string; properties?: Record<string, unknown>; required?: string[] } | undefined;
        const toolDef = {
          description: String(rawToolDef.description || ''),
          inputSchema: schema,
          needsApproval: rawToolDef.needsApproval === true,
        };
        this.toolBridge.registerTool(pluginId, toolName, toolDef);
        return { success: true };
      }
      case 'unregister':
        this.toolBridge.unregisterTool(pluginId, args[0] as string);
        return { success: true };
      default:
        throw new Error(`Unknown tools method: ${method}`);
    }
  }

  /**
   * Handle services namespace requests
   */
  private async handleServicesRequest(
    pluginId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (method) {
      case 'register':
        const [serviceType, methodNames, metadata] = args as [
          string,
          string[],
          Record<string, unknown> | undefined
        ];
        this.serviceBridge.registerService(pluginId, serviceType, methodNames, metadata);
        return { success: true };
      case 'unregister':
        this.serviceBridge.unregisterService(pluginId, args[0] as string);
        return { success: true };
      case 'discover':
        return this.serviceBridge.discover(args[0] as string);
      case 'get':
        const methods = this.serviceBridge.getServiceMethods(
          args[0] as string,
          args[1] as string
        );
        return methods ? { methods } : null;
      case 'getDefault': {
        // Mirrors the shape 'get' returns ({ methods }) plus the resolved
        // provider id, which worker-entry.ts's getDefault() uses to build the
        // same callable proxy get() does. This case was previously unhandled
        // and fell through to a throw, which chatgpt-import swallowed — every
        // import then completed with zero memories extracted and no error.
        const serviceType = args[0] as string;
        const provider = this.serviceBridge.getDefaultProvider(serviceType);
        if (!provider) return null;
        const defaultMethods = this.serviceBridge.getServiceMethods(serviceType, provider.pluginId);
        return defaultMethods ? { pluginId: provider.pluginId, methods: defaultMethods } : null;
      }
      case 'call': {
        // Two different call shapes land here under the same RPC method:
        // - context.services.get(type, providerId)'s returned proxy sends
        //   [serviceType, providerPluginId, methodName, ...args] (4 fixed
        //   positions before the spread).
        // - context.services.call(type, method, ...args) sends
        //   [serviceType, method, ...args] (3 fixed positions) — this used to
        //   be destructured as if it were always the 4-element form, shifting
        //   every real argument by one and reliably failing.
        // worker-entry.ts is out of scope for this fix, so disambiguate here:
        // if `second` names an actually-registered provider for serviceType,
        // treat it as the proxy form; otherwise treat it as the method name
        // and resolve the default provider, matching what
        // context.services.call() is documented to do.
        const [serviceType, second, ...rest] = args as [string, string, ...unknown[]];
        if (this.serviceBridge.getServiceMethods(serviceType, second)) {
          const [methodName, ...callArgs] = rest as [string, ...unknown[]];
          return this.serviceBridge.callServiceMethod(serviceType, second, methodName, callArgs);
        }
        return this.serviceBridge.callDefault(serviceType, second, ...rest);
      }
      case 'hasProviders':
        return this.serviceBridge.hasProviders(args[0] as string);
      default:
        throw new Error(`Unknown services method: ${method}`);
    }
  }

  /**
   * Handle storage namespace requests
   */
  private async handleStorageRequest(
    pluginId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const storageRepo = getPluginStorageRepository();

    switch (method) {
      case 'get':
        return storageRepo.get(pluginId, args[0] as string);
      case 'set':
        return storageRepo.set(pluginId, args[0] as string, args[1]);
      case 'delete':
        return storageRepo.delete(pluginId, args[0] as string);
      case 'clear':
        return storageRepo.clear(pluginId);
      case 'keys':
        return storageRepo.getAllKeys(pluginId);
      default:
        throw new Error(`Unknown storage method: ${method}`);
    }
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      logger.warn(`[SandboxedPluginManager] Plugin ${pluginId} not loaded`);
      return;
    }

    logger.info(`[SandboxedPluginManager] Unloading plugin: ${pluginId}`);

    try {
      // Stop worker
      await plugin.worker.stop();

      // Cleanup bridges
      this.eventBridge.unregisterWorker(pluginId);
      this.toolBridge.unregisterWorker(pluginId);
      this.serviceBridge.unregisterWorker(pluginId);

      // Cleanup permissions and callbacks
      this.permissionGate.unregisterPlugin(pluginId);
      this.callbackRegistry.unregisterPlugin(pluginId);

      // Stop tracking
      this.resourceMonitor.untrack(pluginId);

      // Cleanup registry entries for this plugin
      for (const [id, view] of this.registeredViews) {
        if (view.pluginId === pluginId) this.registeredViews.delete(id);
      }
      for (const [id, view] of this.registeredTerminalViews) {
        if (view.pluginId === pluginId) this.registeredTerminalViews.delete(id);
      }
      for (const [name, tool] of this.registeredTools) {
        if (tool.pluginId === pluginId) this.registeredTools.delete(name);
      }

      // Remove from loaded plugins
      this.plugins.delete(pluginId);

      eventBus.emitEvent('plugin:unloaded', { pluginId });

      logger.info(`[SandboxedPluginManager] Plugin ${pluginId} unloaded`);
    } catch (error) {
      logger.error(
        `[SandboxedPluginManager] Failed to unload plugin ${pluginId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Reload a plugin
   */
  async reloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not loaded`);
    }

    const manifest = plugin.manifest;
    this.reloadingPlugins.add(pluginId);

    try {
      await this.unloadPlugin(pluginId);
      await this.loadPlugin(manifest);
      // Sync cache with latest views
      const activeViews = Array.from(this.registeredViews.values()).filter(v => v.pluginId === pluginId);
      this.viewCache.set(pluginId, activeViews);
    } catch (error) {
      this.viewCache.delete(pluginId);
      throw error;
    } finally {
      this.reloadingPlugins.delete(pluginId);
    }
  }

  /** Absolute path to the user plugins dir (marketplace installs land here). */
  getUserPluginsDir(): string {
    return this.userPluginsDir;
  }

  /**
   * Load a single plugin from a folder under userData/plugins (used by the
   * marketplace install flow). Reads + validates its manifest, stamps it as a
   * `user` plugin, and loads it — replacing a running instance of the same id
   * first (so install-over-existing acts as an update). No app restart.
   */
  async loadUserPlugin(folderName: string): Promise<PluginManifest> {
    const pluginDir = path.join(this.userPluginsDir, folderName);
    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No plugin.json in ${pluginDir}`);
    }
    const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const validation = validateWithSchema(PluginManifestSchema, manifestData);
    if (isValidationFailure(validation)) {
      throw new Error(`Invalid plugin manifest: ${validation.error}`);
    }
    const manifest = {
      ...validation.data,
      path: pluginDir,
      source: 'user',
      folderName,
    } as PluginManifest;

    if (this.plugins.has(manifest.id)) {
      await this.unloadPlugin(manifest.id); // replace on update
    }
    await this.loadPlugin(manifest);
    return manifest;
  }

  /**
   * Uninstall a user-installed plugin: stop its worker, delete its folder from
   * userData/plugins, and drop its persisted state. Refuses to touch bundled
   * plugins (only `user`-source plugins live under userData/plugins).
   */
  async removeUserPlugin(pluginId: string): Promise<void> {
    const manifest = this.getPluginManifest(pluginId);
    const loadedFrom = manifest && (manifest as any).source;
    if (loadedFrom && loadedFrom !== 'user') {
      // Only userData installs are ours to delete. Bundled ships with the app;
      // 'dev' is a symlink into the author's own checkout.
      throw new Error(`Cannot uninstall ${loadedFrom} plugin ${pluginId}`);
    }
    // Prefer the folder the plugin was actually discovered in; fall back to
    // the same derivation the installer uses, so uninstall can always name
    // what install wrote (see sanitizeFolderName).
    const folderName = (manifest as any)?.folderName || sanitizeFolderName(pluginId);

    if (this.plugins.has(pluginId)) {
      await this.unloadPlugin(pluginId);
    }
    if (folderName) {
      const dir = path.join(this.userPluginsDir, folderName);
      const rel = path.relative(this.userPluginsDir, dir);
      // Containment: only ever delete inside userData/plugins.
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(dir)) {
        // Ownership, not just containment. With no loaded manifest the folder
        // name is derived from the id — a guess about what occupies that path,
        // and the next line is an unconditional recursive delete. Installing
        // already refuses to overwrite a directory claimed by someone else
        // (assertDestOwnership); uninstalling has to refuse to delete one.
        //
        // Only the derived path needs this. A folderName that came from a
        // loaded manifest is where that plugin was actually discovered.
        if (!manifest) {
          const occupant = readInstalledPluginId(dir);
          if (occupant !== pluginId) {
            throw new Error(
              `Refusing to uninstall "${pluginId}": ${dir} is ` +
              (occupant
                ? `occupied by a different plugin ("${occupant}")`
                : 'not identifiable as that plugin (no readable plugin.json)') +
              '. Remove the directory by hand if that is really what you want.'
            );
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    getPluginStateRepository().delete(pluginId);
    // Plugin configs are where plugin API keys and tokens live; without this
    // they outlived the uninstall in plugin-configs.json indefinitely.
    getPluginConfigManager().deleteConfig(pluginId);
  }

  /**
   * Get loaded plugin IDs
   */
  getLoadedPluginIds(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Get plugin manifest
   */
  getPluginManifest(pluginId: string): PluginManifest | null {
    return this.plugins.get(pluginId)?.manifest ?? null;
  }

  /**
   * Check if plugin is loaded
   */
  isPluginLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /**
   * Check if plugin is enabled
   */
  isPluginEnabled(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    return plugin ? plugin.enabled : false;
  }

  /**
   * Get plugin count
   */
  get pluginCount(): number {
    return this.plugins.size;
  }

  // ============================================================================
  // Plugin State & Registry (IPC-facing API)
  // ============================================================================

  getLoadedPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values()).map(p => p.manifest);
  }

  getPluginsWithState(): Array<PluginManifest & { enabled: boolean }> {
    return Array.from(this.plugins.values()).map(p => ({
      ...p.manifest,
      enabled: p.enabled,
    }));
  }

  async enablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} not found`);
    if (plugin.enabled) return;

    // disablePlugin tears the worker + bridges/gate all the way down (not
    // just a UI flag) — spawn a fresh worker the same way loadPlugin does
    // rather than trying to resume one that no longer exists.
    plugin.worker = await this.spawnWorker(plugin.manifest);
    plugin.enabled = true;

    getPluginStateRepository().setEnabled(pluginId, true);
    eventBus.emitEvent('plugin:enabled', { pluginId, manifest: plugin.manifest });
  }

  async disablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} not found`);
    if (!plugin.enabled) return;

    // Previously this only flipped `enabled`: the worker kept running,
    // PermissionGate kept its grants, EventBridge kept dispatching into it,
    // and ServiceBridge kept routing calls to it — a plugin holding
    // network:http kept making network calls while the UI showed it as off.
    // Actually stop it and unregister its surface.
    await plugin.worker.stop();
    this.eventBridge.unregisterWorker(pluginId);
    this.toolBridge.unregisterWorker(pluginId);
    this.serviceBridge.unregisterWorker(pluginId);
    this.permissionGate.unregisterPlugin(pluginId);
    this.resourceMonitor.untrack(pluginId);

    plugin.enabled = false;
    getPluginStateRepository().setEnabled(pluginId, false);
    eventBus.emitEvent('plugin:disabled', { pluginId, manifest: plugin.manifest });
  }

  getRegisteredViews(): RegisteredView[] {
    const views = Array.from(this.registeredViews.values());

    // During reload, preserve cached views so UI doesn't flicker
    for (const pluginId of this.reloadingPlugins) {
      const cachedViews = this.viewCache.get(pluginId) || [];
      for (const cachedView of cachedViews) {
        if (!views.some(v => v.id === cachedView.id)) {
          views.push(cachedView);
        }
      }
    }

    return views;
  }

  /** Returns terminal views from enabled plugins only */
  getRegisteredTerminalViews(): RegisteredTerminalView[] {
    return Array.from(this.registeredTerminalViews.values()).filter(view => {
      const plugin = this.plugins.get(view.pluginId);
      return plugin && plugin.enabled;
    });
  }

  /** Returns tool definitions compatible with Vercel AI SDK */
  getRegisteredTools(): Record<string, unknown> {
    const { tool } = require('ai');
    const { z } = require('zod');
    const tools: Record<string, unknown> = {};

    for (const [toolName, registeredTool] of this.registeredTools.entries()) {
      const plugin = this.plugins.get(registeredTool.pluginId);
      if (!plugin || !plugin.enabled) continue;

      const pluginTool = registeredTool.tool;
      const zodSchema = jsonSchemaToZod(z, pluginTool.inputSchema);
      // Plugins can opt into HITL by declaring `needsApproval: true`.
      // The SDK then emits tool-approval-request, the main process registers
      // it, and ApprovalCard surfaces in chat/channel — same path as bash.
      tools[toolName] = tool({
        description: pluginTool.description,
        inputSchema: zodSchema,
        execute: pluginTool.execute,
        needsApproval: pluginTool.needsApproval === true,
      });
    }

    return tools;
  }

  async executePluginTool(pluginId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    // Look up by namespaced key (matching ToolBridge sanitization), fall back to bare name
    const namespacedKey = `${pluginId}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const registeredTool = this.registeredTools.get(namespacedKey) || this.registeredTools.get(toolName);
    if (!registeredTool) throw new Error(`Tool "${toolName}" not found`);
    if (registeredTool.pluginId !== pluginId) throw new Error(`Tool "${toolName}" does not belong to plugin "${pluginId}"`);

    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.enabled) throw new Error(`Plugin "${pluginId}" is not enabled`);

    return registeredTool.tool.execute(args);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert JSON Schema to Zod schema for Vercel AI SDK compatibility */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonSchemaToZod(z: any, jsonSchema: unknown): any {
  const schema = jsonSchema as Record<string, unknown> | undefined;
  if (!schema || schema.type !== 'object') return z.object({});

  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required || []) as string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape: Record<string, any> = {};

  for (const [key, prop] of Object.entries(properties)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let zodType: any;

    switch (prop.type) {
      case 'string':  zodType = z.string(); break;
      case 'number':  zodType = z.number(); break;
      case 'boolean': zodType = z.boolean(); break;
      case 'array': {
        const items = prop.items as Record<string, unknown> | undefined;
        if (items?.type === 'string') zodType = z.array(z.string());
        else if (items?.type === 'number') zodType = z.array(z.number());
        else zodType = z.array(z.any());
        break;
      }
      case 'object':  zodType = jsonSchemaToZod(z, prop); break;
      default:        zodType = z.any();
    }

    if (prop.description) zodType = zodType.describe(prop.description as string);
    if (!required.includes(key)) zodType = zodType.optional();

    shape[key] = zodType;
  }

  return z.object(shape);
}

// ============================================================================
// Singleton
// ============================================================================

let sandboxedPluginManagerInstance: SandboxedPluginManager | null = null;

/**
 * Get the global SandboxedPluginManager instance
 */
export function getSandboxedPluginManager(): SandboxedPluginManager {
  if (!sandboxedPluginManagerInstance) {
    sandboxedPluginManagerInstance = new SandboxedPluginManager();
  }
  return sandboxedPluginManagerInstance;
}

/**
 * Reset the global SandboxedPluginManager instance (for testing)
 */
export async function resetSandboxedPluginManager(): Promise<void> {
  if (sandboxedPluginManagerInstance) {
    await sandboxedPluginManagerInstance.shutdown();
  }
  sandboxedPluginManagerInstance = null;
}
