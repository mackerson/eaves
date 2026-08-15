import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import * as os from 'os';
import * as path from 'path';

/**
 * A default stub for the `electron` module, for main-process code under test.
 *
 * Forty-eight test files already mock this by hand and thirty of them only
 * ever needed `app.getPath`. Providing a default means a test that merely
 * touches a repository does not have to know that somewhere underneath, a
 * project directory gets created.
 *
 * Paths land in a temp directory, never the real profile — main-process code
 * under test writes files, and it must never write them into ~/.config/eaves.
 *
 * A test file that calls `vi.mock('electron', ...)` itself still wins; this is
 * only the floor.
 */
vi.mock('electron', () => {
  const root = path.join(os.tmpdir(), 'eaves-vitest');
  return {
    app: {
      getPath: (name: string) => path.join(root, name),
      getAppPath: () => root,
      getVersion: () => '0.0.0-test',
      isPackaged: false,
      on: vi.fn(),
      whenReady: () => Promise.resolve(),
      quit: vi.fn(),
      exit: vi.fn(),
    },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    shell: { openExternal: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    },
    BrowserWindow: class {},
  };
});

// Cleanup after each test case
afterEach(() => {
  cleanup();
});

// Mock Electron APIs for renderer tests
global.window = global.window || {};
global.window.electron = {
  // Memory operations
  getMemory: vi.fn(),

  // Agent operations
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  switchAgent: vi.fn(),

  // Project operations
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  switchProject: vi.fn(),

  // Channel operations
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  deleteChannel: vi.fn(),
  switchChannel: vi.fn(),
  addChannelParticipant: vi.fn(),

  // Message operations
  sendMessage: vi.fn(),
  addAgentMessage: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),

  // Chat operations
  chat: vi.fn(),
  onChatStream: vi.fn(() => vi.fn()), // Returns cleanup function
  stopStream: vi.fn(),

  // Settings operations
  getSettings: vi.fn(),
  updateSettings: vi.fn(),

  // User operations
  createUser: vi.fn(),
  switchUser: vi.fn(),

  // MCP Server operations
  addMCPServer: vi.fn(),
  updateMCPServer: vi.fn(),
  deleteMCPServer: vi.fn(),
  fetchModels: vi.fn(),

  // Plugin operations
  getPluginViews: vi.fn(),

  // Logging operations
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  openLogDir: vi.fn(),
  clearLogs: vi.fn(),
} as any;
