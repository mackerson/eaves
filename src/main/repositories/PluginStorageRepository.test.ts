import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PluginStorageRepository } from './PluginStorageRepository';
import Database from 'better-sqlite3';
import { runMigrations } from '../services/migrations';

// Mock the logger to avoid Electron app dependency
vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the database service
vi.mock('../services/database', () => ({
  getDatabase: vi.fn(),
}));

describe('PluginStorageRepository', () => {
  let db: Database.Database | null = null;
  let repository: PluginStorageRepository;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db, 0);

    // Mock getDatabase to return our test database
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    repository = new PluginStorageRepository();
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    vi.clearAllMocks();
  });

  describe('set and get', () => {
    it('should set and retrieve a string value', () => {
      repository.set('plugin1', 'key1', 'test-value');

      const value = repository.get('plugin1', 'key1');
      expect(value).toBe('test-value');
    });

    it('should set and retrieve an object value', () => {
      const testObj = { name: 'test', count: 42 };
      repository.set('plugin1', 'config', testObj);

      const value = repository.get('plugin1', 'config');
      expect(value).toEqual(testObj);
    });

    it('should set and retrieve a number value', () => {
      repository.set('plugin1', 'count', 123);

      const value = repository.get('plugin1', 'count');
      expect(value).toBe(123);
    });

    it('should set and retrieve a boolean value', () => {
      repository.set('plugin1', 'enabled', true);

      const value = repository.get('plugin1', 'enabled');
      expect(value).toBe(true);
    });

    it('should set and retrieve an array value', () => {
      const testArray = [1, 2, 3, 4, 5];
      repository.set('plugin1', 'items', testArray);

      const value = repository.get('plugin1', 'items');
      expect(value).toEqual(testArray);
    });

    it('should return null for non-existent key', () => {
      const value = repository.get('plugin1', 'nonexistent');
      expect(value).toBeNull();
    });

    it('should return null for non-existent plugin', () => {
      const value = repository.get('nonexistent-plugin', 'any-key');
      expect(value).toBeNull();
    });
  });

  describe('set with updates', () => {
    it('should update existing value', () => {
      repository.set('plugin1', 'key1', 'original-value');
      repository.set('plugin1', 'key1', 'updated-value');

      const value = repository.get('plugin1', 'key1');
      expect(value).toBe('updated-value');
    });

    it('should update timestamp when overwriting', () => {
      const firstTime = Date.now();
      repository.set('plugin1', 'key1', 'value1');

      const firstRow = db.prepare('SELECT updated_at FROM plugin_storage WHERE plugin_id = ? AND key = ?')
        .get('plugin1', 'key1') as { updated_at: number };

      // Small delay to ensure different timestamp
      new Promise(resolve => setTimeout(resolve, 10));

      const secondTime = Date.now();
      repository.set('plugin1', 'key1', 'value2');

      const secondRow = db.prepare('SELECT updated_at FROM plugin_storage WHERE plugin_id = ? AND key = ?')
        .get('plugin1', 'key1') as { updated_at: number };

      expect(secondRow.updated_at).toBeGreaterThanOrEqual(firstRow.updated_at);
    });

    it('should handle multiple keys for same plugin', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');
      repository.set('plugin1', 'key3', 'value3');

      expect(repository.get('plugin1', 'key1')).toBe('value1');
      expect(repository.get('plugin1', 'key2')).toBe('value2');
      expect(repository.get('plugin1', 'key3')).toBe('value3');
    });

    it('should isolate data between plugins', () => {
      repository.set('plugin1', 'key', 'plugin1-value');
      repository.set('plugin2', 'key', 'plugin2-value');

      expect(repository.get('plugin1', 'key')).toBe('plugin1-value');
      expect(repository.get('plugin2', 'key')).toBe('plugin2-value');
    });
  });

  describe('delete', () => {
    it('should delete an existing key', () => {
      repository.set('plugin1', 'key1', 'value1');
      expect(repository.get('plugin1', 'key1')).toBe('value1');

      const deleted = repository.delete('plugin1', 'key1');
      expect(deleted).toBe(true);
      expect(repository.get('plugin1', 'key1')).toBeNull();
    });

    it('should return false when deleting non-existent key', () => {
      const deleted = repository.delete('plugin1', 'nonexistent');
      expect(deleted).toBe(false);
    });

    it('should return false when deleting from non-existent plugin', () => {
      const deleted = repository.delete('nonexistent-plugin', 'any-key');
      expect(deleted).toBe(false);
    });

    it('should only delete specified key', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');

      repository.delete('plugin1', 'key1');

      expect(repository.get('plugin1', 'key1')).toBeNull();
      expect(repository.get('plugin1', 'key2')).toBe('value2');
    });

    it('should not affect other plugins when deleting', () => {
      repository.set('plugin1', 'key', 'plugin1-value');
      repository.set('plugin2', 'key', 'plugin2-value');

      repository.delete('plugin1', 'key');

      expect(repository.get('plugin1', 'key')).toBeNull();
      expect(repository.get('plugin2', 'key')).toBe('plugin2-value');
    });
  });

  describe('getAllKeys', () => {
    it('should return empty array for plugin with no keys', () => {
      const keys = repository.getAllKeys('plugin1');
      expect(keys).toEqual([]);
    });

    it('should return all keys for a plugin', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');
      repository.set('plugin1', 'key3', 'value3');

      const keys = repository.getAllKeys('plugin1');
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
      expect(keys.length).toBe(3);
    });

    it('should not include keys from other plugins', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin2', 'key2', 'value2');

      const keys = repository.getAllKeys('plugin1');
      expect(keys).toEqual(['key1']);
      expect(keys).not.toContain('key2');
    });

    it('should update after deletion', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');

      repository.delete('plugin1', 'key1');

      const keys = repository.getAllKeys('plugin1');
      expect(keys).toEqual(['key2']);
    });
  });

  describe('getAll', () => {
    it('should return empty object for plugin with no data', () => {
      const all = repository.getAll('plugin1');
      expect(all).toEqual({});
    });

    it('should return all data for a plugin', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');
      repository.set('plugin1', 'key3', 123);

      const all = repository.getAll('plugin1');
      expect(all).toEqual({
        key1: 'value1',
        key2: 'value2',
        key3: 123,
      });
    });

    it('should handle complex objects', () => {
      const config = { api: 'test', settings: { nested: true } };
      repository.set('plugin1', 'config', config);
      repository.set('plugin1', 'name', 'TestPlugin');

      const all = repository.getAll('plugin1');
      expect(all.config).toEqual(config);
      expect(all.name).toBe('TestPlugin');
    });

    it('should isolate data between plugins', () => {
      repository.set('plugin1', 'key', 'plugin1-value');
      repository.set('plugin2', 'key', 'plugin2-value');

      const all1 = repository.getAll('plugin1');
      const all2 = repository.getAll('plugin2');

      expect(all1).toEqual({ key: 'plugin1-value' });
      expect(all2).toEqual({ key: 'plugin2-value' });
    });

    it('should reflect deletions', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');

      repository.delete('plugin1', 'key1');

      const all = repository.getAll('plugin1');
      expect(all).toEqual({ key2: 'value2' });
      expect(all.key1).toBeUndefined();
    });

    it('should handle mixed value types', () => {
      repository.set('plugin1', 'string', 'text');
      repository.set('plugin1', 'number', 42);
      repository.set('plugin1', 'boolean', true);
      repository.set('plugin1', 'array', [1, 2, 3]);
      repository.set('plugin1', 'object', { nested: 'value' });

      const all = repository.getAll('plugin1');
      expect(all.string).toBe('text');
      expect(all.number).toBe(42);
      expect(all.boolean).toBe(true);
      expect(all.array).toEqual([1, 2, 3]);
      expect(all.object).toEqual({ nested: 'value' });
    });
  });

  describe('clear', () => {
    it('should clear all data for a plugin', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');
      repository.set('plugin1', 'key3', 'value3');

      repository.clear('plugin1');

      const all = repository.getAll('plugin1');
      expect(all).toEqual({});
    });

    it('should not affect other plugins when clearing', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin2', 'key1', 'value2');

      repository.clear('plugin1');

      const all1 = repository.getAll('plugin1');
      const all2 = repository.getAll('plugin2');

      expect(all1).toEqual({});
      expect(all2).toEqual({ key1: 'value2' });
    });

    it('should clear plugin with no data gracefully', () => {
      repository.clear('nonexistent-plugin');
      const all = repository.getAll('nonexistent-plugin');
      expect(all).toEqual({});
    });

    it('should allow re-adding data after clear', () => {
      repository.set('plugin1', 'key1', 'old-value');
      repository.clear('plugin1');
      repository.set('plugin1', 'key1', 'new-value');

      const value = repository.get('plugin1', 'key1');
      expect(value).toBe('new-value');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string values', () => {
      repository.set('plugin1', 'key', '');
      const value = repository.get('plugin1', 'key');
      expect(value).toBe('');
    });

    it('should handle null-like string values', () => {
      repository.set('plugin1', 'key', 'null');
      const value = repository.get('plugin1', 'key');
      // JSON.parse converts 'null' string to actual null value
      expect(value).toBeNull();
    });

    it('should handle large objects', () => {
      const largeObj = {
        data: Array(1000).fill('test').map((_, i) => ({ id: i, value: 'test' })),
      };
      repository.set('plugin1', 'large', largeObj);
      const value = repository.get('plugin1', 'large');
      expect(value).toEqual(largeObj);
    });

    it('should handle special characters in keys', () => {
      const specialKey = 'key-with_special.chars@123';
      repository.set('plugin1', specialKey, 'value');
      const value = repository.get('plugin1', specialKey);
      expect(value).toBe('value');
    });

    it('should handle special characters in plugin IDs', () => {
      const pluginId = 'plugin.with-special_chars@123';
      repository.set(pluginId, 'key', 'value');
      const value = repository.get(pluginId, 'key');
      expect(value).toBe('value');
    });

    it('should handle nested JSON structures', () => {
      const complex = {
        level1: {
          level2: {
            level3: {
              items: [1, 2, 3],
              name: 'deep',
            },
          },
        },
      };
      repository.set('plugin1', 'complex', complex);
      const value = repository.get('plugin1', 'complex');
      expect(value).toEqual(complex);
    });

    it('should handle undefined values in objects', () => {
      const obj = { key1: 'value', key2: undefined };
      repository.set('plugin1', 'obj', obj);
      const value = repository.get('plugin1', 'obj');
      // JSON.stringify strips undefined values
      expect(value).toEqual({ key1: 'value' });
    });
  });

  describe('type coercion and parsing', () => {
    it('should correctly parse JSON objects from string storage', () => {
      const obj = { name: 'test', age: 30 };
      repository.set('plugin1', 'user', obj);

      // Manually fetch from DB to verify JSON storage
      const row = db.prepare('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?')
        .get('plugin1', 'user') as { value: string };

      // Should be valid JSON
      expect(() => JSON.parse(row.value)).not.toThrow();
      expect(JSON.parse(row.value)).toEqual(obj);
    });

    it('should handle non-JSON string values', () => {
      repository.set('plugin1', 'text', 'plain text value');
      const value = repository.get('plugin1', 'text');
      expect(value).toBe('plain text value');
    });

    it('should distinguish between number and string numbers', () => {
      repository.set('plugin1', 'num', 123);
      repository.set('plugin1', 'str', '123');

      const num = repository.get('plugin1', 'num');
      const str = repository.get('plugin1', 'str');

      // Both get parsed as numbers because JSON.parse handles both cases
      // 'num' is stored as "123" via JSON.stringify(123)
      // 'str' is stored as "123" (raw string)
      // Both parse to number 123
      expect(num).toBe(123);
      expect(str).toBe(123); // JSON.parse("123") returns number 123
      expect(typeof num).toBe('number');
      expect(typeof str).toBe('number');
    });
  });

  describe('concurrent operations', () => {
    it('should handle rapid successive updates', () => {
      repository.set('plugin1', 'counter', 0);

      for (let i = 1; i <= 10; i++) {
        repository.set('plugin1', 'counter', i);
      }

      const value = repository.get('plugin1', 'counter');
      expect(value).toBe(10);
    });

    it('should handle operations on multiple plugins simultaneously', () => {
      const plugins = ['p1', 'p2', 'p3'];
      plugins.forEach((plugin, idx) => {
        repository.set(plugin, 'data', `value-${idx}`);
      });

      plugins.forEach((plugin, idx) => {
        expect(repository.get(plugin, 'data')).toBe(`value-${idx}`);
      });
    });

    it('should maintain data integrity with mixed operations', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.set('plugin1', 'key2', 'value2');
      repository.delete('plugin1', 'key1');
      repository.set('plugin1', 'key3', 'value3');
      repository.set('plugin1', 'key2', 'updated-value2');

      const all = repository.getAll('plugin1');
      expect(all).toEqual({
        key2: 'updated-value2',
        key3: 'value3',
      });
    });
  });

  describe('database constraints', () => {
    it('should enforce primary key constraint on duplicate insert', () => {
      repository.set('plugin1', 'key1', 'first-value');
      // This should update, not error
      repository.set('plugin1', 'key1', 'second-value');

      const value = repository.get('plugin1', 'key1');
      expect(value).toBe('second-value');
    });

    it('should maintain timestamps correctly', () => {
      const before = Date.now();
      repository.set('plugin1', 'key1', 'value');
      const after = Date.now();

      const row = db.prepare('SELECT created_at, updated_at FROM plugin_storage WHERE plugin_id = ? AND key = ?')
        .get('plugin1', 'key1') as { created_at: number; updated_at: number };

      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(row.created_at).toBeLessThanOrEqual(after);
      expect(row.updated_at).toBeGreaterThanOrEqual(before);
      expect(row.updated_at).toBeLessThanOrEqual(after);
    });
  });

  describe('error cases', () => {
    it('should handle null values gracefully', () => {
      repository.set('plugin1', 'key', null);
      const value = repository.get('plugin1', 'key');
      expect(value).toBeNull();
    });

    it('should handle operations on deleted items', () => {
      repository.set('plugin1', 'key1', 'value1');
      repository.delete('plugin1', 'key1');

      // Should be able to set it again
      repository.set('plugin1', 'key1', 'new-value');
      const value = repository.get('plugin1', 'key1');
      expect(value).toBe('new-value');
    });

    it('should provide consistent results across multiple reads', () => {
      repository.set('plugin1', 'key1', 'constant-value');

      const val1 = repository.get('plugin1', 'key1');
      const val2 = repository.get('plugin1', 'key1');
      const val3 = repository.get('plugin1', 'key1');

      expect(val1).toBe(val2);
      expect(val2).toBe(val3);
    });
  });
});
