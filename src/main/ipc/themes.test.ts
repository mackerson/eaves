import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { ipcMain, shell } from 'electron';
import { registerThemeHandlers } from './themes';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));

const { mockLogger, mockThemeManager } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockThemeManager: {
    getAllUserThemes: vi.fn(),
    getUserTheme: vi.fn(),
    generateThemeCSS: vi.fn(),
    isUserTheme: vi.fn(),
    loadUserThemes: vi.fn(),
    getThemesDirectory: vi.fn(),
  },
}));
vi.mock('../services/logger', () => ({
  logger: mockLogger,
  getLogger: () => mockLogger,
}));
vi.mock('../services/ThemeManager', () => ({
  themeManager: mockThemeManager,
  getThemeManager: () => mockThemeManager,
}));

import { themeManager } from '../services/ThemeManager';

describe('Theme IPC Handlers', () => {
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerThemeHandlers();
  });

  afterEach(() => vi.clearAllMocks());

  describe('get-user-themes', () => {
    it('should return all user themes', async () => {
      const handler = handlers.get('get-user-themes')!;
      const mockThemes = [{ id: 'theme-1', name: 'Dark' }];
      (themeManager.getAllUserThemes as Mock).mockReturnValue(mockThemes);

      const result = await handler({});

      expect(result).toEqual(mockThemes);
    });

    it('should return error on failure', async () => {
      const handler = handlers.get('get-user-themes')!;
      (themeManager.getAllUserThemes as Mock).mockImplementation(() => { throw new Error('Failed'); });

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed');
    });
  });

  describe('get-user-theme', () => {
    it('should return a specific theme by ID', async () => {
      const handler = handlers.get('get-user-theme')!;
      const mockTheme = { id: 'theme-1', name: 'Dark' };
      (themeManager.getUserTheme as Mock).mockReturnValue(mockTheme);

      const result = await handler({}, 'theme-1');

      expect(result).toEqual(mockTheme);
      expect(themeManager.getUserTheme).toHaveBeenCalledWith('theme-1');
    });

    it('should reject empty theme ID', async () => {
      const handler = handlers.get('get-user-theme')!;
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('get-user-theme-css', () => {
    it('should generate CSS for a valid theme', async () => {
      const handler = handlers.get('get-user-theme-css')!;
      const mockTheme = { id: 'theme-1', name: 'Dark' };
      (themeManager.getUserTheme as Mock).mockReturnValue(mockTheme);
      (themeManager.generateThemeCSS as Mock).mockReturnValue(':root { --bg: #000; }');

      const result = await handler({}, 'theme-1');

      expect(result).toBe(':root { --bg: #000; }');
    });

    it('should return null for non-existent theme', async () => {
      const handler = handlers.get('get-user-theme-css')!;
      (themeManager.getUserTheme as Mock).mockReturnValue(null);

      const result = await handler({}, 'non-existent');

      expect(result).toBeNull();
    });

    it('should return null on validation failure', async () => {
      const handler = handlers.get('get-user-theme-css')!;
      const result = await handler({}, '');

      expect(result).toBeNull();
    });
  });

  describe('is-user-theme', () => {
    it('should return true for user theme', async () => {
      const handler = handlers.get('is-user-theme')!;
      (themeManager.isUserTheme as Mock).mockReturnValue(true);

      const result = await handler({}, 'theme-1');

      expect(result).toBe(true);
    });

    it('should return false on validation failure', async () => {
      const handler = handlers.get('is-user-theme')!;
      const result = await handler({}, '');

      expect(result).toBe(false);
    });
  });

  describe('reload-user-themes', () => {
    it('should reload themes', async () => {
      const handler = handlers.get('reload-user-themes')!;
      const mockThemes = [{ id: 'theme-1' }];
      (themeManager.loadUserThemes as Mock).mockReturnValue(mockThemes);

      const result = await handler({});

      expect(result).toEqual(mockThemes);
    });
  });

  describe('get-themes-directory', () => {
    it('should return the themes directory path', async () => {
      const handler = handlers.get('get-themes-directory')!;
      (themeManager.getThemesDirectory as Mock).mockReturnValue('/Users/test/.config/eaves/themes');

      const result = await handler({});

      expect(result).toBe('/Users/test/.config/eaves/themes');
    });
  });

  describe('open-themes-directory', () => {
    it('should open themes directory successfully', async () => {
      const handler = handlers.get('open-themes-directory')!;
      (themeManager.getThemesDirectory as Mock).mockReturnValue('/path/to/themes');
      (shell.openPath as Mock).mockResolvedValue('');

      const result = await handler({});

      expect(result).toEqual({ success: true });
      expect(shell.openPath).toHaveBeenCalledWith('/path/to/themes');
    });

    it('should handle open failure gracefully', async () => {
      const handler = handlers.get('open-themes-directory')!;
      (themeManager.getThemesDirectory as Mock).mockImplementation(() => { throw new Error('Not found'); });

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not found');
    });
  });
});
