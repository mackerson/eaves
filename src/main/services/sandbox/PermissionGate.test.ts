/**
 * PermissionGate Tests
 *
 * Tests for runtime permission enforcement in the sandbox system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger before importing PermissionGate
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  PermissionGate,
  PermissionDeniedError,
  getPermissionGate,
  resetPermissionGate,
} from './PermissionGate';
import { PluginPermission } from './types';

describe('PermissionGate', () => {
  let gate: PermissionGate;

  beforeEach(() => {
    gate = new PermissionGate();
  });

  describe('registerPlugin', () => {
    it('should register a plugin with permissions', () => {
      const permissions: PluginPermission[] = ['data:agents:read', 'storage:read'];
      gate.registerPlugin('test-plugin', permissions);

      const registered = gate.getPluginPermissions('test-plugin');
      expect(registered).toEqual(permissions);
    });

    it('should return null for unregistered plugin', () => {
      const permissions = gate.getPluginPermissions('nonexistent');
      expect(permissions).toBeNull();
    });

    it('should overwrite permissions on re-registration', () => {
      gate.registerPlugin('test-plugin', ['data:agents:read']);
      gate.registerPlugin('test-plugin', ['storage:write']);

      const permissions = gate.getPluginPermissions('test-plugin');
      expect(permissions).toEqual(['storage:write']);
    });

    it('should track multiple plugins independently', () => {
      gate.registerPlugin('plugin1', ['data:agents:read']);
      gate.registerPlugin('plugin2', ['storage:write']);

      expect(gate.getPluginPermissions('plugin1')).toEqual(['data:agents:read']);
      expect(gate.getPluginPermissions('plugin2')).toEqual(['storage:write']);
    });
  });

  describe('unregisterPlugin', () => {
    it('should remove plugin permissions', () => {
      gate.registerPlugin('test-plugin', ['data:agents:read']);
      gate.unregisterPlugin('test-plugin');

      expect(gate.getPluginPermissions('test-plugin')).toBeNull();
    });

    it('should handle unregistering non-existent plugin gracefully', () => {
      expect(() => gate.unregisterPlugin('nonexistent')).not.toThrow();
    });
  });

  describe('getRegisteredPlugins', () => {
    it('should return empty array when no plugins registered', () => {
      expect(gate.getRegisteredPlugins()).toEqual([]);
    });

    it('should return all registered plugin IDs', () => {
      gate.registerPlugin('plugin1', ['data:agents:read']);
      gate.registerPlugin('plugin2', ['storage:write']);
      gate.registerPlugin('plugin3', ['tools:register']);

      const plugins = gate.getRegisteredPlugins();
      expect(plugins).toContain('plugin1');
      expect(plugins).toContain('plugin2');
      expect(plugins).toContain('plugin3');
      expect(plugins.length).toBe(3);
    });
  });

  describe('checkPermission', () => {
    beforeEach(() => {
      gate.registerPlugin('test-plugin', [
        'data:agents:read',
        'data:projects:read',
        'storage:read',
        'storage:write',
      ]);
    });

    it('should allow access with matching permission', () => {
      const result = gate.checkPermission('test-plugin', 'data', 'agents.getAll');
      expect(result.allowed).toBe(true);
      expect(result.missingPermissions).toEqual([]);
    });

    it('should deny access without matching permission', () => {
      const result = gate.checkPermission('test-plugin', 'data', 'chats.getAll');
      expect(result.allowed).toBe(false);
      expect(result.missingPermissions).toContain('data:chats:read');
    });

    it('should deny access for unregistered plugin', () => {
      const result = gate.checkPermission('unknown-plugin', 'data', 'agents.getAll');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('no registered permissions');
    });

    it('should deny methods with no defined requirements (default-deny)', () => {
      const result = gate.checkPermission('test-plugin', 'data', 'unknownMethod');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('No permission requirements mapped');
    });

    it('should check storage permissions correctly', () => {
      const readResult = gate.checkPermission('test-plugin', 'storage', 'get');
      expect(readResult.allowed).toBe(true);

      const writeResult = gate.checkPermission('test-plugin', 'storage', 'set');
      expect(writeResult.allowed).toBe(true);
    });

    it('should deny tools:register without permission', () => {
      const result = gate.checkPermission('test-plugin', 'tools', 'register');
      expect(result.allowed).toBe(false);
      expect(result.missingPermissions).toContain('tools:register');
    });
  });

  describe('checkPermission with wildcards', () => {
    it('should match wildcard permissions', () => {
      // Register with a hypothetical wildcard permission
      gate.registerPlugin('wildcard-plugin', ['data:*:read' as PluginPermission]);

      // Should match any data:*:read permission
      const result = gate.checkPermission('wildcard-plugin', 'data', 'agents.getAll');
      expect(result.allowed).toBe(true);
    });

    it('should match exact permissions before wildcards', () => {
      gate.registerPlugin('mixed-plugin', [
        'data:agents:read',
        'data:*:read' as PluginPermission,
      ]);

      const result = gate.checkPermission('mixed-plugin', 'data', 'agents.getAll');
      expect(result.allowed).toBe(true);
    });
  });

  describe('assertPermission', () => {
    beforeEach(() => {
      gate.registerPlugin('test-plugin', ['data:agents:read']);
    });

    it('should not throw when permission is granted', () => {
      expect(() => {
        gate.assertPermission('test-plugin', 'data', 'agents.getAll');
      }).not.toThrow();
    });

    it('should throw PermissionDeniedError when permission is denied', () => {
      expect(() => {
        gate.assertPermission('test-plugin', 'data', 'chats.getAll');
      }).toThrow(PermissionDeniedError);
    });

    it('should include plugin ID in error', () => {
      try {
        gate.assertPermission('test-plugin', 'data', 'chats.getAll');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PermissionDeniedError);
        expect((error as PermissionDeniedError).pluginId).toBe('test-plugin');
      }
    });

    it('should include missing permissions in error', () => {
      try {
        gate.assertPermission('test-plugin', 'data', 'chats.getAll');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PermissionDeniedError);
        expect((error as PermissionDeniedError).missingPermissions).toContain('data:chats:read');
      }
    });
  });

  describe('getRequiredPermissions', () => {
    it('should return required permissions for known methods', () => {
      const perms = gate.getRequiredPermissions('data', 'agents.getAll');
      expect(perms).toContain('data:agents:read');
    });

    it('should return empty array for unknown methods', () => {
      const perms = gate.getRequiredPermissions('data', 'unknownMethod');
      expect(perms).toEqual([]);
    });

    it('should return correct permissions for storage methods', () => {
      expect(gate.getRequiredPermissions('storage', 'get')).toContain('storage:read');
      expect(gate.getRequiredPermissions('storage', 'set')).toContain('storage:write');
      expect(gate.getRequiredPermissions('storage', 'delete')).toContain('storage:write');
    });

    it('should return correct permissions for UI methods', () => {
      expect(gate.getRequiredPermissions('ui', 'showNotification')).toContain('ui:notifications:show');
      expect(gate.getRequiredPermissions('ui', 'registerView')).toContain('ui:views:register');
    });
  });

  describe('hasRequirements', () => {
    it('should return true for methods with requirements', () => {
      expect(gate.hasRequirements('data', 'agents.getAll')).toBe(true);
      expect(gate.hasRequirements('storage', 'get')).toBe(true);
    });

    it('should return false for methods without requirements', () => {
      expect(gate.hasRequirements('data', 'unknownMethod')).toBe(false);
    });
  });

  describe('denied call tracking', () => {
    beforeEach(() => {
      gate.registerPlugin('test-plugin', []); // No permissions
    });

    it('should track denied calls', () => {
      // Make several denied calls
      gate.checkPermission('test-plugin', 'data', 'agents.getAll');
      gate.checkPermission('test-plugin', 'data', 'agents.getAll');
      gate.checkPermission('test-plugin', 'data', 'agents.getAll');

      const stats = gate.getDeniedStats();
      expect(stats.get('test-plugin:data.agents.getAll')).toBe(3);
    });

    it('should track denied calls per method', () => {
      gate.checkPermission('test-plugin', 'data', 'agents.getAll');
      gate.checkPermission('test-plugin', 'storage', 'set');
      gate.checkPermission('test-plugin', 'storage', 'set');

      const stats = gate.getDeniedStats();
      expect(stats.get('test-plugin:data.agents.getAll')).toBe(1);
      expect(stats.get('test-plugin:storage.set')).toBe(2);
    });

    it('should clear denied stats', () => {
      gate.checkPermission('test-plugin', 'data', 'agents.getAll');
      gate.clearDeniedStats();

      const stats = gate.getDeniedStats();
      expect(stats.size).toBe(0);
    });

    it('should not track allowed calls', () => {
      gate.registerPlugin('allowed-plugin', ['data:agents:read']);
      gate.checkPermission('allowed-plugin', 'data', 'agents.getAll');

      const stats = gate.getDeniedStats();
      expect(stats.has('allowed-plugin:data.agents.getAll')).toBe(false);
    });
  });
});

describe('PermissionDeniedError', () => {
  it('should have correct error properties', () => {
    const error = new PermissionDeniedError(
      'test-plugin',
      'data',
      'agents.getAll',
      ['data:agents:read']
    );

    expect(error.name).toBe('PermissionDeniedError');
    expect(error.pluginId).toBe('test-plugin');
    expect(error.namespace).toBe('data');
    expect(error.method).toBe('agents.getAll');
    expect(error.missingPermissions).toEqual(['data:agents:read']);
  });

  it('should have descriptive message', () => {
    const error = new PermissionDeniedError(
      'my-plugin',
      'storage',
      'set',
      ['storage:write']
    );

    expect(error.message).toContain('my-plugin');
    expect(error.message).toContain('storage.set');
    expect(error.message).toContain('storage:write');
  });

  it('should be an instance of Error', () => {
    const error = new PermissionDeniedError('p', 'n' as any, 'm', []);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetPermissionGate();
  });

  it('getPermissionGate should return same instance', () => {
    const gate1 = getPermissionGate();
    const gate2 = getPermissionGate();
    expect(gate1).toBe(gate2);
  });

  it('resetPermissionGate should create new instance', () => {
    const gate1 = getPermissionGate();
    gate1.registerPlugin('test', ['storage:read']);

    resetPermissionGate();

    const gate2 = getPermissionGate();
    expect(gate2.getPluginPermissions('test')).toBeNull();
  });
});
