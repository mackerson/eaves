import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

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
