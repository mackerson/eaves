import { app, BrowserWindow, crashReporter, dialog, ipcMain, protocol } from 'electron';
import * as path from 'path';
import { registerProtocolHandlers } from './protocols';
import { MODULE_SHIM_SCHEME, moduleShimRedirectTarget } from './protocols/moduleShim';
import { PLUGIN_BUNDLE_SCHEME } from './protocols/pluginBundle';
import { loadAppState, initializeAppState } from './services/appStateLoader';
import { registerCoreMemoryBackend, backfillCoreVectors } from './services/CoreMemoryBackend';
import { ipcResult } from './utils/ipcValidation';
import { closeDatabase } from './services/database';
import { registerAgentHandlers } from './ipc/agents';
import { registerChannelHandlers } from './ipc/channels';
import { registerChatHandlers } from './ipc/chats';
import { registerApprovalHandlers } from './ipc/approvals';
import { registerProjectHandlers } from './ipc/projects';
import { registerTaskHandlers } from './ipc/tasks';
import { registerNoteHandlers } from './ipc/notes';
import { registerSettingsHandlers, redactSettingsForRenderer } from './ipc/settings';
import { registerThemeHandlers } from './ipc/themes';
import { registerLogHandlers } from './ipc/logs';
import { registerAppHandlers } from './ipc/app';
import { registerWindowHandlers } from './ipc/window';
import { registerPluginHandlers } from './ipc/plugins';
import { registerUserHandlers } from './ipc/users';
import { registerSchedulingHandlers } from './ipc/scheduling';
import { registerWorkflowHandlers } from './ipc/workflows';
import { registerWorkSessionHandlers } from './ipc/workSessions';
import { registerRoutineHandlers } from './ipc/routines';
import { registerFileHandlers } from './ipc/files';
import { registerTerminalHandlers, unregisterTerminalHandlers } from './ipc/terminal';
import { registerActivityHandlers } from './ipc/activities';
import { registerOOBEHandlers } from './ipc/oobe';
import { registerMessagingHandlers, autoStartBridges } from './ipc/messaging';
import { registerMemoryHandlers } from './ipc/memories';
import { registerMemoryBackendHandlers } from './ipc/memoryBackend';
import { registerBackupHandlers } from './ipc/backups';
import { registerSyncHandlers } from './ipc/sync';
import { getSyncService } from './services/sync/SyncService';
import { getAutoUpdater } from './services/AutoUpdater';
import { registerUpdateHandlers } from './ipc/updates';
import { ActivityPersistenceService } from './services/ActivityPersistenceService';
import { getActiveWorkRegistry } from './services/ActiveWorkRegistry';
import { getTerminalManager } from './services/TerminalManager';
import { getSandboxedPluginManager } from './services/sandbox';
import { PluginWatcher } from './services/PluginWatcher';
import { getThemeManager } from './services/ThemeManager';
import { getTrayManager } from './services/TrayManager';
import { getThemeWatcher } from './services/ThemeWatcher';
import { getRoutineScheduler } from './services/RoutineScheduler';
import { getChannelDispatcher } from './services/ChannelDispatcher';
import { getShadowService } from './services/ShadowService';
import { getBackupService } from './services/BackupService';
import { getEventBus } from './services/EventBus';
import { getLogger } from './services/logger';
import { ApplicationMenu } from './services/ApplicationMenu';

const logger = getLogger();
const eventBus = getEventBus();
const themeManager = getThemeManager();
const themeWatcher = getThemeWatcher();
const TerminalManager = getTerminalManager();

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', { reason, promise });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

// Privileged scheme used to serve React shims to sandboxed plugin UI bundles in
// packaged builds (see protocols/moduleShim.ts). Must run before
// app `ready`; `standard` + `secure` make the renderer treat responses as real
// ES modules, `supportFetchAPI` lets dynamic import() fetch them.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MODULE_SHIM_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  // Serves installed-plugin UI bundles from userData/plugins/ so the renderer
  // can import() them as ES modules in packaged builds (see protocols/pluginBundle.ts).
  {
    scheme: PLUGIN_BUNDLE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let applicationMenu: ApplicationMenu | null = null;
let pluginWatcher: PluginWatcher | null = null;
// Module-scoped so before-quit can stop the EventBus subscription it owns.
// Local-scoped would leak the subscription past shutdown.
let activityPersistenceService: ActivityPersistenceService | null = null;
let isQuitting = false;

function getIconPath(): string {
  // Try to find appropriate icon based on platform
  // In both dev and production, assets are in dist/assets/ relative to main.js
  // __dirname is dist/main/main/, so we go up 2 levels to dist/, then into assets/
  const iconBasePath = path.join(__dirname, '..', '..', 'assets', 'icons');

  if (process.platform === 'darwin') {
    return path.join(iconBasePath, 'icon.icns');
  } else if (process.platform === 'win32') {
    return path.join(iconBasePath, 'icon.ico');
  } else {
    return path.join(iconBasePath, 'icon.png');
  }
}

// Windows paints the native caption bar with the *system* accent color, which
// has nothing to do with the active Enclave theme — a user running a yellow
// Windows accent gets a bright yellow band above a black app. Taking over the
// frame with a Window Controls Overlay lets TopMenuBar own that row and keeps
// the caption buttons themed. Seeded with the dark --bg-secondary default and
// re-colored from the renderer once the real theme resolves (see
// 'window:set-title-bar-overlay').
const USES_TITLE_BAR_OVERLAY = process.platform === 'win32';
const DEFAULT_OVERLAY = { color: '#242424', symbolColor: '#ffffff', height: 48 };

// Linux has no Window Controls Overlay — that API is Windows-only — so getting
// the same themed single-row chrome means dropping the frame entirely and
// drawing the caption buttons in the renderer (see WindowControls.tsx).
// macOS keeps its native frame: the traffic lights and the system menu bar are
// load-bearing there, and hiding them buys nothing.
const USES_CUSTOM_FRAME = process.platform === 'linux';

function createWindow() {
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath, // Set window icon
    // No autoHideMenuBar / setMenuBarVisibility here any more. Both existed to
    // hide Electron's default menu bar — and to let Alt reveal it — back when
    // one was installed. ApplicationMenu now clears the application menu
    // outright off macOS (Menu.setApplicationMenu(null), run before this
    // window is created), so there is no menu bar to hide and Alt reveals
    // nothing. Linux is frameless besides, and has no menu bar area at all.
    ...(USES_TITLE_BAR_OVERLAY
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: DEFAULT_OVERLAY }
      : {}),
    ...(USES_CUSTOM_FRAME ? { frame: false } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Explicit even though it's the default — flagged on every security
      // audit and trivial to flip accidentally, so keep it stated.
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // The custom caption button has to show restore-vs-maximise correctly even
  // when the change came from somewhere else — a double-click on the drag
  // region, a keyboard shortcut, or the window manager's own tiling.
  if (USES_CUSTOM_FRAME) {
    const emitMaximizeState = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('window:maximize-changed', {
        maximized: mainWindow.isMaximized(),
      });
    };
    mainWindow.on('maximize', emitMaximizeState);
    mainWindow.on('unmaximize', emitMaximizeState);
  }

  // Set Content Security Policy
  // In development, Vite needs 'unsafe-inline' and 'unsafe-eval' for HMR
  const isDev = !app.isPackaged;
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Shared hardening directives — added to both dev and prod. object-src
    // blocks <object>/<embed>/<applet>; base-uri blocks <base> hijack;
    // form-action keeps <form> submissions same-origin.
    const sharedHardening = [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ];
    const cspDirectives = isDev
      ? [
        "default-src 'self'",
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${PLUGIN_BUNDLE_SCHEME}:`, // Vite HMR needs unsafe-*; plugin: serves installed-plugin bundles
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https: avatar: file-service: background: plugin:", // avatar/file-service/background as noted; plugin: for installed-plugin UI assets
        "font-src 'self' data:",
        "connect-src 'self' ws://localhost:* http://localhost:* https://api.anthropic.com https://api.openai.com", // Vite dev server + APIs
        "frame-src 'self' http: https:", // Allow external iframes for WebView plugin
        ...sharedHardening,
      ]
      : [
        "default-src 'self'",
        // enclave-module: serves React shims to plugin UI bundles;
        // plugin: serves installed-plugin UI bundles from userData/plugins/
        `script-src 'self' ${MODULE_SHIM_SCHEME}: ${PLUGIN_BUNDLE_SCHEME}:`,
        "style-src 'self' 'unsafe-inline'", // Tailwind requires inline styles
        "img-src 'self' data: https: avatar: file-service: background: plugin:", // avatar/file-service/background as noted; plugin: for installed-plugin UI assets
        "font-src 'self' data:",
        "connect-src 'self' https://api.anthropic.com https://api.openai.com",
        "frame-src 'self' http: https:", // Allow external iframes for WebView plugin
        ...sharedHardening,
      ];

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspDirectives.join('; ')],
      },
    });
  });

  // In packaged builds the renderer loads over file://, so plugin UI bundles'
  // externalized `/node_modules/react*` imports would resolve to a nonexistent
  // file:///node_modules/react and 404. Redirect those three to the
  // enclave-module: scheme, which serves React shims. Dev is handled
  // by vite.config.ts middleware instead.
  if (!isDev) {
    // Match all file:// requests and decide precisely in the handler — match
    // patterns can't reliably target file URLs (empty host, Windows drive
    // letters in the path). Non-React requests pass through unchanged.
    mainWindow.webContents.session.webRequest.onBeforeRequest(
      { urls: ['file:///*'] },
      (details, callback) => {
        const redirectURL = moduleShimRedirectTarget(details.url);
        callback(redirectURL ? { redirectURL } : {});
      }
    );
  }

  if (isDev) {
    // Development mode - try to find available Vite server
    const tryPorts = async () => {
      const ports = ['5173', '5174', '5175', '5176', '5177', '5178', '5179'];
      for (const port of ports) {
        try {
          const response = await fetch(`http://localhost:${port}`);
          if (response.ok) {
            logger.info(`[Main] Found Vite server on port ${port}`);
            return port;
          }
        } catch (e) {
          // Port not available, try next
        }
      }
      logger.warn('[Main] No Vite server found, falling back to 5173');
      return '5173'; // fallback
    };

    tryPorts().then(port => {
      const url = `http://localhost:${port}`;
      logger.info(`[Main] Loading URL: ${url}`);
      mainWindow?.loadURL(url);
      mainWindow?.webContents.openDevTools();
    }).catch(err => {
      logger.error('[Main] Failed to load URL:', err);
    });
  } else {
    // Production mode - load from bundled files
    // __dirname is dist/main/main/, renderer is at dist/renderer/
    // So we need to go up 2 levels to get to dist/, then into renderer/
    const indexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');
    logger.info(`[Main] Loading file: ${indexPath}`);

    mainWindow?.loadFile(indexPath)
      .then(() => {
        logger.info(`[Main] Successfully loaded index.html`);
      })
      .catch((err) => {
        logger.error(`[Main] Failed to load index.html:`, err);
        logger.error(`[Main] Error name: ${err.name}, message: ${err.message}`);
      });
  }

  // Add webContents error listeners for debugging
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error(`[Main] did-fail-load: code=${errorCode}, desc=${errorDescription}, url=${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[Main] Render process gone:`, details);
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // In packaged builds only forward warning/error (levels 2 + 3). Verbose
    // and info from plugins or third-party iframes (webview plugin) could
    // otherwise leak chat content into the log file. Dev keeps everything
    // for debugging.
    if (app.isPackaged && level < 2) return;
    const levelStr = ['verbose', 'info', 'warning', 'error'][level] || 'unknown';
    logger.info(`[Renderer Console][${levelStr}] ${message} (${sourceId}:${line})`);
  });

  // Log when DOM is ready
  mainWindow.webContents.on('dom-ready', () => {
    logger.info(`[Main] DOM ready`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info(`[Main] did-finish-load`);
  });

  // Handle window close button - minimize to tray instead of quitting (except on macOS)
  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform !== 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // A PTY's id lived only in the renderer that created it, so once this
    // window is gone nothing can ever reach these sessions again — including
    // the window `app.on('activate')` builds next. Leaving them running
    // orphans a shell child holding its cwd and whatever command was in
    // flight. On macOS, where close destroys the window but the app lives on,
    // that was permanent.
    getTerminalManager().cleanup();
  });
}

// A main-process abort — a Chromium CHECK, a V8 fatal like OOM — is delivered
// as SIGILL, because Chromium crashes deliberately by executing an undefined
// instruction. No JS handler runs, nothing reaches the app log, and the process
// is simply gone: exactly the shape of the 2026-08-15 crash, which left no
// evidence at all. Collecting minidumps is the only way such a crash is
// diagnosable after the fact.
//
// `uploadToServer: false` keeps them entirely local (userData/crashDumps).
// Note a minidump is a memory image and can contain whatever the process held
// at the time — conversation text, and in principle API keys. It never leaves
// the machine, but treat the directory as sensitive.
crashReporter.start({ uploadToServer: false });

// The main process cannot report its own abort, and `render-process-gone` on a
// webContents only covers the renderer. This catches the GPU and utility
// children, whose death is otherwise invisible.
app.on('child-process-gone', (_event, details) => {
  logger.error('[Main] Child process gone:', details);
});

// Single-instance lock. Enclave has no multi-window feature, so a second launch
// only ever means a rival OS process on the same SQLite DB — two writers with no
// busy_timeout can silently drop each other's writes, and a post-update
// double-launch can race the boot migration. The common trigger is benign: the
// window is hidden to the system tray (close = hide on Win/Linux), the user
// can't see it, and relaunches to "find" it. So a second launch should surface
// the existing (possibly tray-hidden) window, not boot a second instance.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show(); // un-hide from tray
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  // A losing second instance is already quitting — never initialize services or
  // open the DB from it (that's the whole point of the lock above).
  if (!gotSingleInstanceLock) return;

  // Initialize database and run migration if needed.
  //
  // Guarded because everything below — including createWindow() — lives in
  // this same callback. A throw here used to reject the promise and stop, with
  // no window ever created and the process still running: the app looked like
  // it had launched and then simply showed nothing. That is how a database too
  // old for the build presented, and it took a tester and a round trip to
  // identify something the log had already written down.
  //
  // A dialog is the only surface that exists this early. It is deliberately
  // not a silent quit: a user who double-clicks and sees nothing has no reason
  // to suspect their data, and no idea the log is worth reading.
  try {
    initializeAppState();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error('[Main] Fatal error during startup — cannot continue', error);
    dialog.showErrorBox(
      'Enclave could not start',
      `${detail}\n\nA log with the full details is in:\n${app.getPath('userData')}/logs`,
    );
    app.exit(1);
    return;
  }

  // Register the core default memory-backend as the fallback floor. Must run
  // after the DB is up and BEFORE plugins load, so a plugin backend still
  // overrides it (see ServiceRegistry isFallback handling).
  registerCoreMemoryBackend();
  // Catch up any memories missing a vector (e.g. stored before embeddings were
  // enabled, or embedded under a since-changed model). Self-guards to a no-op
  // when semantic search is off; runs in the background so it never blocks boot.
  void backfillCoreVectors().catch(() => { /* best-effort */ });

  registerProtocolHandlers();

  // Register all IPC handlers BEFORE creating window
  // This ensures handlers are ready when renderer loads
  ipcMain.handle('get-memory', ipcResult('get-memory', async () => {
    const state = loadAppState();
    // loadAppState is also called by main-process consumers that need the real
    // keys (ChatService, notes), so redact here at the boundary rather than in
    // the loader. See redactSettingsForRenderer.
    return { ...state, settings: redactSettingsForRenderer(state.settings) };
  }));

  // Re-tint the Windows caption buttons to match the active theme. No-op on
  // platforms without an overlay. Colors are validated as 6-digit hex before
  // they reach Electron — setTitleBarOverlay throws on anything else, and this
  // is renderer-supplied input.
  ipcMain.handle('window:set-title-bar-overlay', ipcResult('window:set-title-bar-overlay', async (_event, params: { color: string; symbolColor: string }) => {
    if (!USES_TITLE_BAR_OVERLAY || !mainWindow || mainWindow.isDestroyed()) {
      return { applied: false };
    }
    const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
    if (!isHex(params?.color) || !isHex(params?.symbolColor)) {
      throw new Error('color and symbolColor must be 6-digit hex strings');
    }
    mainWindow.setTitleBarOverlay({
      color: params.color,
      symbolColor: params.symbolColor,
      height: DEFAULT_OVERLAY.height,
    });
    return { applied: true };
  }));

  // What is running right now, across every agent — the read side of the
  // command view. Deliberately not on the activity feed: that is a historical
  // log, and live work is neither appended nor durable.
  // ipcResult only supplies `success: false` on a throw — the success half is
  // the handler's to state, and the preload type promises it.
  ipcMain.handle('work:list-active', ipcResult('work:list-active', async () => {
    return { success: true, work: getActiveWorkRegistry().list() };
  }));

  ipcMain.handle('work:cancel', ipcResult('work:cancel', async (_event, params: { id: string }) => {
    if (!params?.id || typeof params.id !== 'string') {
      throw new Error('id is required');
    }
    // False means nothing was stopped — unknown id, or work that exposes no
    // cancel hook. Never report a stop that did not happen.
    return { success: true, cancelled: getActiveWorkRegistry().cancel(params.id) };
  }));

  registerAgentHandlers();
  registerChannelHandlers(() => mainWindow);
  registerChatHandlers(() => mainWindow);
  registerApprovalHandlers(() => mainWindow);
  registerProjectHandlers();
  registerTaskHandlers();
  registerNoteHandlers();
  registerSettingsHandlers();
  registerThemeHandlers();
  registerLogHandlers();
  registerAppHandlers();
  registerWindowHandlers(() => mainWindow);
  registerPluginHandlers(() => mainWindow);
  registerUserHandlers();
  registerSchedulingHandlers();
  registerWorkflowHandlers();
  registerWorkSessionHandlers(() => mainWindow);
  registerRoutineHandlers();
  registerFileHandlers();
  registerTerminalHandlers();
  registerActivityHandlers();
  registerOOBEHandlers(() => mainWindow);
  registerMessagingHandlers(() => mainWindow);
  registerMemoryHandlers();
  registerMemoryBackendHandlers();
  registerBackupHandlers();
  registerSyncHandlers();
  registerUpdateHandlers(() => mainWindow);

  // Application menu. On macOS this installs the real menu bar; everywhere
  // else it explicitly clears the application menu so Electron's default does
  // not linger behind the renderer's own bar. Setting no menu at all is what
  // previously left mac users looking at a stock Electron menu.
  applicationMenu = new ApplicationMenu(() => mainWindow);
  applicationMenu.apply();

  // The renderer owns checkbox and submenu state; it pushes changes here so
  // the native menu can redraw with the correct ticks and lists.
  ipcMain.handle('menu:sync-state', (_event, state) => {
    if (!applicationMenu) return { success: false };
    if (state?.checkboxes) {
      for (const [id, checked] of Object.entries(state.checkboxes)) {
        applicationMenu.setCheckboxState(id as never, Boolean(checked));
      }
    }
    if (state?.dynamic) {
      for (const [source, entries] of Object.entries(state.dynamic)) {
        applicationMenu.setDynamicEntries(source as never, entries as never);
      }
    }
    return { success: true };
  });

  // Initialize activity persistence service
  activityPersistenceService = new ActivityPersistenceService(() => mainWindow);
  activityPersistenceService.start();

  // Initialize plugin system
  try {
    const sandboxedPluginManager = getSandboxedPluginManager();
    await sandboxedPluginManager.initialize();

    eventBus.emitEvent('app:ready');

    // Start plugin hot reload watcher
    pluginWatcher = new PluginWatcher();
    const bundledPluginsDir = path.join(app.getAppPath(), 'dist', 'plugins');
    const userPluginsDir = path.join(app.getPath('userData'), 'plugins');
    pluginWatcher.start(bundledPluginsDir, 'bundled');
    pluginWatcher.start(userPluginsDir, 'user');

    // In development, also watch the source plugins directory
    if (!app.isPackaged) {
      const sourcePluginsDir = path.join(app.getAppPath(), 'plugins');
      pluginWatcher.start(sourcePluginsDir, 'dev');
      logger.info('[Main] Dev mode: Also watching source plugins directory');
    }

    logger.info('[Main] Plugin hot reload enabled');
    logger.info(`[Main] Plugins loaded: ${sandboxedPluginManager.pluginCount}`);
  } catch (error) {
    logger.error('Failed to initialize plugin system:', error);
  }

  // Auto-start messaging bridges (Telegram, etc.) if configured
  autoStartBridges(() => mainWindow);

  // Initialize user theme system
  try {
    themeManager.loadUserThemes();
    themeWatcher.start();
    logger.info('[Main] User theme system initialized');
  } catch (error) {
    logger.error('[Main] Failed to initialize theme system:', error);
  }

  // Start routine scheduler
  try {
    const scheduler = getRoutineScheduler();
    scheduler.start();
    logger.info('[Main] Routine scheduler started');
  } catch (error) {
    logger.error('[Main] Failed to start routine scheduler:', error);
  }

  // Start channel dispatcher for @mention-based agent responses
  try {
    const dispatcher = getChannelDispatcher(() => mainWindow);
    dispatcher.start();
    logger.info('[Main] Channel dispatcher started');
  } catch (error) {
    logger.error('[Main] Failed to start channel dispatcher:', error);
  }

  // Start shadow service for background memory distillation
  try {
    const shadowService = getShadowService();
    shadowService.start();
    logger.info('[Main] Shadow service started');
  } catch (error) {
    logger.error('[Main] Failed to start shadow service:', error);
  }

  // Start backup service (takes startup snapshot if stale, schedules 24h timer).
  // Fire-and-forget — start() is async because it takes the snapshot before
  // returning, but a slow disk shouldn't block app boot.
  getBackupService().start().catch((error) => {
    logger.error('[Main] Failed to start backup service:', error);
  });

  // Start LAN sync (no-op unless the user enabled it in Settings → Sync).
  // Fire-and-forget — cert generation on first enable can take a moment.
  getSyncService(() => mainWindow).start().catch((error) => {
    logger.error('[Main] Failed to start sync service:', error);
  });

  // Create window AFTER handlers are registered
  createWindow();

  // Start auto-updater in packaged builds only
  if (app.isPackaged) {
    try {
      const updater = getAutoUpdater(() => mainWindow);
      updater.start();
      logger.info('[Main] Auto-updater started');
    } catch (error) {
      logger.error('[Main] Failed to start auto-updater:', error);
    }
  }

  // Accessor, not the window itself — `activate` replaces mainWindow and
  // nothing re-runs this. See TerminalManager.initialize.
  TerminalManager.initialize(() => mainWindow);

  // Create system tray
  getTrayManager().init({
    getMainWindow: () => mainWindow,
    createWindow,
    onNavigate: (view) => {
      mainWindow?.webContents.send('tray:navigate', view);
    },
  });
});

app.on('window-all-closed', () => {
  // Keep running on all platforms — macOS keeps app in dock, Windows/Linux can use tray
});

/** Bound an awaited teardown step so a wedged one can't hold the quit open. */
const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

async function boundedStep(label: string, work: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), SHUTDOWN_STEP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.error(`Error during ${label}:`, error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * True once runShutdown has finished, so the `app.quit()` that follows it
 * doesn't re-enter teardown.
 */
let shutdownComplete = false;

/**
 * `before-quit` is synchronous — Electron does not await a promise returned
 * from the handler. This one used to be `async` with two `await`s in the
 * middle of it and no `preventDefault()`, so everything after the first await
 * (plugin shutdown, tray destroy, the PTY kill, `closeDatabase()`) was
 * scheduled as a microtask and dropped when the process exited. PTY children
 * were orphaned to the OS and SQLite closed by process teardown rather than
 * `db.close()`, leaving the WAL uncheckpointed.
 *
 * So hold the quit open explicitly and quit for real once teardown is done,
 * with every awaited step bounded — a wedged Telegram bridge must not turn
 * "quit" into "hang".
 */
app.on('before-quit', (event) => {
  // Set flag to allow window to close
  isQuitting = true;
  if (shutdownComplete) return;

  event.preventDefault();
  runShutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

async function runShutdown(): Promise<void> {
  // Stop auto-updater
  try {
    getAutoUpdater().stop();
  } catch (error) {
    logger.error('Error stopping auto-updater:', error);
  }

  // Stop shadow service
  try {
    getShadowService().stop();
  } catch (error) {
    logger.error('Error stopping shadow service:', error);
  }

  // Stop backup service timer so it doesn't fire mid-shutdown.
  try {
    getBackupService().stop();
  } catch (error) {
    logger.error('Error stopping backup service:', error);
  }

  // Stop LAN sync (closes peer connections, TLS server, mDNS sockets, timers).
  try {
    getSyncService().stop();
  } catch (error) {
    logger.error('Error stopping sync service:', error);
  }

  // Stop activity persistence (drops the EventBus wildcard subscription).
  try {
    activityPersistenceService?.stop();
  } catch (error) {
    logger.error('Error stopping activity persistence:', error);
  }

  // Stop theme watcher (chokidar handle on the themes directory).
  try {
    themeWatcher.stop();
  } catch (error) {
    logger.error('Error stopping theme watcher:', error);
  }

  // Stop routine scheduler timer.
  try {
    getRoutineScheduler().stop();
  } catch (error) {
    logger.error('Error stopping routine scheduler:', error);
  }

  // Stop channel dispatcher (drops its EventBus subscriptions).
  try {
    getChannelDispatcher(() => mainWindow).stop();
  } catch (error) {
    logger.error('Error stopping channel dispatcher:', error);
  }

  // Stop messaging bridges. Real network teardown (the Telegram bridge), which
  // is why it is bounded rather than awaited outright.
  await boundedStep('messaging bridge shutdown', async () => {
    const { getMessagingBridgeService } = require('./services/messaging');
    await getMessagingBridgeService().stopAll();
  });

  // Shutdown plugin system. Before closeDatabase below — plugin workers reach
  // the DB through the RPC bridge, and a write landing after the close would
  // reopen the handle we just shut.
  await boundedStep('plugin shutdown', async () => {
    await getSandboxedPluginManager().shutdown();
  });
  try {
    eventBus.emitEvent('app:shutdown');
  } catch (error) {
    logger.error('Error emitting app:shutdown:', error);
  }

  // Close pooled MCP servers. They are stdio children that deliberately outlive
  // the turn that spawned them, so nothing else would reap them on the way out.
  await boundedStep('mcp pool shutdown', async () => {
    const { shutdownMCPPool } = await import('./services/mcp');
    await shutdownMCPPool();
  });

  // Stop plugin watcher
  if (pluginWatcher) {
    pluginWatcher.stop();
    pluginWatcher = null;
  }

  // Destroy tray icon
  getTrayManager().destroy();

  // Cleanup terminal sessions
  try {
    unregisterTerminalHandlers();
  } catch (error) {
    logger.error('Error during terminal cleanup:', error);
  }

  try {
    closeDatabase();
  } catch (error) {
    logger.error('Error closing database:', error);
  }
}

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
