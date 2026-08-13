import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerActivityHandlers } from './activities';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../repositories', () => ({
  getActivityRepository: vi.fn(),
}));

import { getActivityRepository } from '../repositories';

describe('Activity IPC Handlers', () => {
  let mockActivityRepo: {
    getAll: Mock;
    getRecentCount: Mock;
    getCategories: Mock;
    clear: Mock;
    clearBefore: Mock;
    getCount: Mock;
  };
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockActivityRepo = {
      getAll: vi.fn(),
      getRecentCount: vi.fn(),
      getCategories: vi.fn(),
      clear: vi.fn(),
      clearBefore: vi.fn(),
      getCount: vi.fn(),
    };

    (getActivityRepository as Mock).mockReturnValue(mockActivityRepo);

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerActivityHandlers();
  });

  afterEach(() => vi.clearAllMocks());

  describe('activities:list', () => {
    it('should return activities with default limit', async () => {
      const handler = handlers.get('activities:list')!;
      const mockActivities = [{ id: 'a-1', type: 'message', timestamp: Date.now() }];
      mockActivityRepo.getAll.mockReturnValue(mockActivities);

      const result = await handler({});

      expect(result.success).toBe(true);
      expect(result.activities).toEqual(mockActivities);
      expect(mockActivityRepo.getAll).toHaveBeenCalledWith({ limit: 100 });
    });

    it('should filter with provided options', async () => {
      const handler = handlers.get('activities:list')!;
      mockActivityRepo.getAll.mockReturnValue([]);

      const result = await handler({}, { limit: 50, category: 'chat' });

      expect(result.success).toBe(true);
      expect(mockActivityRepo.getAll).toHaveBeenCalled();
    });

    it('should handle repository error', async () => {
      const handler = handlers.get('activities:list')!;
      mockActivityRepo.getAll.mockImplementation(() => { throw new Error('DB error'); });

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  describe('activities:recent-count', () => {
    it('should return recent count with default 24h window', async () => {
      const handler = handlers.get('activities:recent-count')!;
      mockActivityRepo.getRecentCount.mockReturnValue(42);

      const result = await handler({});

      expect(result.success).toBe(true);
      expect(result.count).toBe(42);
    });

    it('should use provided timestamp', async () => {
      const handler = handlers.get('activities:recent-count')!;
      const since = Date.now() - 3600000;
      mockActivityRepo.getRecentCount.mockReturnValue(5);

      const result = await handler({}, since);

      expect(result.success).toBe(true);
      expect(result.count).toBe(5);
      expect(mockActivityRepo.getRecentCount).toHaveBeenCalledWith(since);
    });
  });

  describe('activities:categories', () => {
    it('should return categories', async () => {
      const handler = handlers.get('activities:categories')!;
      const mockCategories = ['chat', 'system', 'plugin'];
      mockActivityRepo.getCategories.mockReturnValue(mockCategories);

      const result = await handler({});

      expect(result.success).toBe(true);
      expect(result.categories).toEqual(mockCategories);
    });
  });

  describe('activities:clear', () => {
    it('should clear all activities', async () => {
      const handler = handlers.get('activities:clear')!;

      const result = await handler({});

      expect(result).toEqual({ success: true });
      expect(mockActivityRepo.clear).toHaveBeenCalled();
    });

    it('should handle clear failure', async () => {
      const handler = handlers.get('activities:clear')!;
      mockActivityRepo.clear.mockImplementation(() => { throw new Error('IO error'); });

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('IO error');
    });
  });

  describe('activities:clear-before', () => {
    it('should clear activities before timestamp', async () => {
      const handler = handlers.get('activities:clear-before')!;
      mockActivityRepo.clearBefore.mockReturnValue(10);

      const result = await handler({}, Date.now() - 86400000);

      expect(result.success).toBe(true);
      expect(result.deleted).toBe(10);
    });

    it('should reject invalid timestamp', async () => {
      const handler = handlers.get('activities:clear-before')!;

      const result = await handler({}, 'not-a-number');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject missing timestamp', async () => {
      const handler = handlers.get('activities:clear-before')!;

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('activities:count', () => {
    it('should return total count', async () => {
      const handler = handlers.get('activities:count')!;
      mockActivityRepo.getCount.mockReturnValue(100);

      const result = await handler({});

      expect(result.success).toBe(true);
      expect(result.count).toBe(100);
    });
  });
});
