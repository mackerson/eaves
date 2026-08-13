import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { registerSettingsHandlers } from './settings';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn() },
}));

const { mockLogger, mockBackgroundCache, mockEventBus } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockBackgroundCache: {
    cacheLocalFile: vi.fn(),
    cacheUrl: vi.fn(),
    getCached: vi.fn(),
    clearCache: vi.fn(),
  },
  mockEventBus: { emitEvent: vi.fn() },
}));
vi.mock('../services/logger', () => ({
  logger: mockLogger,
  getLogger: () => mockLogger,
}));
vi.mock('../repositories', () => ({
  getSettingsRepository: vi.fn(),
}));
vi.mock('../services/BackgroundCache', () => ({
  backgroundCache: mockBackgroundCache,
  getBackgroundCache: () => mockBackgroundCache,
}));
vi.mock('../services/EventBus', () => ({
  eventBus: mockEventBus,
  getEventBus: () => mockEventBus,
}));

import { getSettingsRepository } from '../repositories';
import { backgroundCache } from '../services/BackgroundCache';
import { eventBus } from '../services/EventBus';

describe('Settings IPC Handlers', () => {
  let mockSettingsRepo: { update: Mock };
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks drops call history but keeps implementations, and the
    // failure-path tests install throwing ones. Left in place they leak into
    // whichever test runs next, which then sees an error it never arranged —
    // 'should clear cache successfully' fails only when it happens to run
    // after 'should handle clear failure gracefully'.
    for (const fn of Object.values(mockBackgroundCache)) fn.mockReset();

    mockSettingsRepo = { update: vi.fn() };
    (getSettingsRepository as Mock).mockReturnValue(mockSettingsRepo);

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerSettingsHandlers();
  });

  afterEach(() => vi.clearAllMocks());

  describe('update-settings', () => {
    it('should update settings and emit event', async () => {
      const handler = handlers.get('update-settings')!;
      const updated = { theme: 'dark', userName: 'Test' };
      mockSettingsRepo.update.mockReturnValue(updated);

      const result = await handler({}, { theme: 'dark' });

      expect(result).toEqual({ ...updated, apiKeys: {}, configuredProviders: [] });
      expect(eventBus.emitEvent).toHaveBeenCalledWith('settings:updated', {
        ...updated,
        configuredProviders: [],
      });
    });

    // The event reaches the activity feed (persisted and rendered verbatim) and
    // every plugin with `events:listen`. The return value reaches the renderer,
    // which shares its realm and preload bridge with every plugin UI bundle —
    // and UpdateSettingsSchema is entirely optional, so `updateSettings({})`
    // was a pure read of the user's decrypted keys.
    it('returns provider keys neither on the event bus nor to the caller', async () => {
      const handler = handlers.get('update-settings')!;
      const updated = {
        theme: 'dark',
        apiKeys: { anthropic: 'sk-ant-secret', openai: '', openrouter: 'sk-or-secret' },
      };
      mockSettingsRepo.update.mockReturnValue(updated);

      const result = await handler({}, { theme: 'dark' });

      const [, payload] = (eventBus.emitEvent as Mock).mock.calls.at(-1)!;
      expect(payload).not.toHaveProperty('apiKeys');
      expect(payload.configuredProviders).toEqual(['anthropic', 'openrouter']);
      expect(JSON.stringify(payload)).not.toContain('secret');

      expect(result.apiKeys.anthropic).toBeUndefined();
      expect(result.configuredProviders).toEqual(['anthropic', 'openrouter']);
      expect(JSON.stringify(result)).not.toContain('secret');
    });

    // Local providers store an endpoint URL in the same field. It isn't a
    // credential and the settings UI has to be able to show and edit it.
    it('keeps local-provider endpoints readable', async () => {
      const handler = handlers.get('update-settings')!;
      mockSettingsRepo.update.mockReturnValue({
        apiKeys: { anthropic: 'sk-ant-secret', ollama: 'http://localhost:11434' },
      });

      const result = await handler({}, { theme: 'dark' });

      expect(result.apiKeys.ollama).toBe('http://localhost:11434');
      expect(result.apiKeys.anthropic).toBeUndefined();
      expect(result.configuredProviders).toEqual(['anthropic', 'ollama']);
    });

    it('should reject invalid settings', async () => {
      const handler = handlers.get('update-settings')!;
      // Passing a non-object should fail validation
      const result = await handler({}, 'not-an-object');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('dialog:pick-background-image', () => {
    it('should return cached path on file selection', async () => {
      const handler = handlers.get('dialog:pick-background-image')!;
      const mockWindow = {} as BrowserWindow;
      (BrowserWindow.getFocusedWindow as Mock).mockReturnValue(mockWindow);
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: false,
        filePaths: ['/path/to/image.png'],
      });
      (backgroundCache.cacheLocalFile as Mock).mockReturnValue('enclave://bg/image.png');

      const result = await handler({});

      expect(result.canceled).toBe(false);
      expect(result.path).toBe('enclave://bg/image.png');
    });

    it('should return canceled when user cancels', async () => {
      const handler = handlers.get('dialog:pick-background-image')!;
      const mockWindow = {} as BrowserWindow;
      (BrowserWindow.getFocusedWindow as Mock).mockReturnValue(mockWindow);
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await handler({});

      expect(result.canceled).toBe(true);
    });

    it('should fall back to source path if caching returns null', async () => {
      const handler = handlers.get('dialog:pick-background-image')!;
      const mockWindow = {} as BrowserWindow;
      (BrowserWindow.getFocusedWindow as Mock).mockReturnValue(mockWindow);
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: false,
        filePaths: ['/path/to/image.png'],
      });
      (backgroundCache.cacheLocalFile as Mock).mockReturnValue(null);

      const result = await handler({});

      expect(result.path).toBe('/path/to/image.png');
    });
  });

  describe('cache-background-url', () => {
    it('should cache a valid URL', async () => {
      const handler = handlers.get('cache-background-url')!;
      (backgroundCache.cacheUrl as Mock).mockResolvedValue('enclave://bg/cached.png');

      const result = await handler({}, 'https://example.com/image.png');

      expect(result.success).toBe(true);
      expect(result.path).toBe('enclave://bg/cached.png');
    });

    it('should reject invalid URL', async () => {
      const handler = handlers.get('cache-background-url')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle cache failure gracefully', async () => {
      const handler = handlers.get('cache-background-url')!;
      (backgroundCache.cacheUrl as Mock).mockRejectedValue(new Error('Network error'));

      const result = await handler({}, 'https://example.com/image.png');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('get-cached-background', () => {
    it('should return cached background', async () => {
      const handler = handlers.get('get-cached-background')!;
      (backgroundCache.getCached as Mock).mockReturnValue('enclave://bg/cached.png');

      const result = await handler({}, 'https://example.com/image.png');

      expect(result.cached).toBe(true);
      expect(result.path).toBe('enclave://bg/cached.png');
    });

    it('should return not cached when missing', async () => {
      const handler = handlers.get('get-cached-background')!;
      (backgroundCache.getCached as Mock).mockReturnValue(null);

      const result = await handler({}, 'https://example.com/image.png');

      expect(result.cached).toBe(false);
    });

    it('should reject invalid URL', async () => {
      const handler = handlers.get('get-cached-background')!;
      const result = await handler({}, '');

      expect(result.cached).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('clear-background-cache', () => {
    it('should clear cache successfully', async () => {
      const handler = handlers.get('clear-background-cache')!;

      const result = await handler({});

      expect(result).toEqual({ success: true });
      expect(backgroundCache.clearCache).toHaveBeenCalled();
    });

    it('should handle clear failure gracefully', async () => {
      const handler = handlers.get('clear-background-cache')!;
      (backgroundCache.clearCache as Mock).mockImplementation(() => { throw new Error('IO error'); });

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('IO error');
    });
  });
});
