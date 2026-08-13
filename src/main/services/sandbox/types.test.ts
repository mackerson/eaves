/**
 * Types Tests
 *
 * Tests for utility functions and type guards in the types module.
 */

import { describe, it, expect } from 'vitest';
import {
  isCallbackRef,
  createMessageId,
  PermissionGroups,
  DEFAULT_RESOURCE_LIMITS,
} from './types';

describe('isCallbackRef', () => {
  it('should return true for valid CallbackRef', () => {
    const ref = {
      __type: 'CallbackRef' as const,
      callbackId: 'cb-123',
    };
    expect(isCallbackRef(ref)).toBe(true);
  });

  it('should return true for CallbackRef with signature', () => {
    const ref = {
      __type: 'CallbackRef' as const,
      callbackId: 'cb-123',
      signature: {
        paramCount: 2,
        isAsync: true,
      },
    };
    expect(isCallbackRef(ref)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isCallbackRef(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isCallbackRef(undefined)).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(isCallbackRef('string')).toBe(false);
    expect(isCallbackRef(42)).toBe(false);
    expect(isCallbackRef(true)).toBe(false);
  });

  it('should return false for plain objects without __type', () => {
    expect(isCallbackRef({ callbackId: 'cb-123' })).toBe(false);
  });

  it('should return false for objects with wrong __type', () => {
    expect(isCallbackRef({ __type: 'Other', callbackId: 'cb-123' })).toBe(false);
  });

  it('should return false for arrays', () => {
    expect(isCallbackRef([{ __type: 'CallbackRef' }])).toBe(false);
  });
});

describe('createMessageId', () => {
  it('should create unique IDs', () => {
    const id1 = createMessageId();
    const id2 = createMessageId();
    const id3 = createMessageId();

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  it('should create string IDs', () => {
    const id = createMessageId();
    expect(typeof id).toBe('string');
  });

  it('should create non-empty IDs', () => {
    const id = createMessageId();
    expect(id.length).toBeGreaterThan(0);
  });

  it('should include timestamp component', () => {
    // IDs should contain a timestamp-like number
    const id = createMessageId();
    const parts = id.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(Number(parts[0])).toBeGreaterThan(0);
  });
});

describe('PermissionGroups', () => {
  describe('readOnly', () => {
    it('should only contain read permissions', () => {
      for (const perm of PermissionGroups.readOnly) {
        // All permissions should be read-related
        expect(
          perm.includes(':read') ||
          perm === 'events:listen' ||
          perm === 'storage:read'
        ).toBe(true);
      }
    });

    it('should not contain write permissions', () => {
      for (const perm of PermissionGroups.readOnly) {
        expect(perm.includes(':write')).toBe(false);
      }
    });
  });

  describe('standard', () => {
    it('should include UI permissions', () => {
      expect(PermissionGroups.standard).toContain('ui:views:register');
      expect(PermissionGroups.standard).toContain('ui:notifications:show');
    });

    it('should include storage permissions', () => {
      expect(PermissionGroups.standard).toContain('storage:read');
      expect(PermissionGroups.standard).toContain('storage:write');
    });

    it('should include event permissions', () => {
      expect(PermissionGroups.standard).toContain('events:listen');
      expect(PermissionGroups.standard).toContain('events:emit');
    });
  });

  describe('tool', () => {
    it('should include tools:register', () => {
      expect(PermissionGroups.tool).toContain('tools:register');
    });

    it('should include storage permissions', () => {
      expect(PermissionGroups.tool).toContain('storage:read');
      expect(PermissionGroups.tool).toContain('storage:write');
    });

    it('should include event permissions', () => {
      expect(PermissionGroups.tool).toContain('events:listen');
      expect(PermissionGroups.tool).toContain('events:emit');
    });
  });

  describe('service', () => {
    it('should include service permissions', () => {
      expect(PermissionGroups.service).toContain('services:register');
      expect(PermissionGroups.service).toContain('services:call');
    });

    it('should include storage permissions', () => {
      expect(PermissionGroups.service).toContain('storage:read');
      expect(PermissionGroups.service).toContain('storage:write');
    });
  });
});

describe('DEFAULT_RESOURCE_LIMITS', () => {
  it('should have reasonable memory limits', () => {
    expect(DEFAULT_RESOURCE_LIMITS.maxHeapMB).toBeGreaterThan(0);
    expect(DEFAULT_RESOURCE_LIMITS.maxHeapMB).toBeLessThanOrEqual(512);

    expect(DEFAULT_RESOURCE_LIMITS.maxOldGenerationMB).toBeGreaterThan(0);
    expect(DEFAULT_RESOURCE_LIMITS.maxOldGenerationMB).toBeLessThanOrEqual(DEFAULT_RESOURCE_LIMITS.maxHeapMB);
  });

  it('should have reasonable timeout values', () => {
    // API timeout should be at least 5 seconds
    expect(DEFAULT_RESOURCE_LIMITS.apiTimeoutMs).toBeGreaterThanOrEqual(5000);

    // Tool timeout should be longer than API timeout
    expect(DEFAULT_RESOURCE_LIMITS.toolTimeoutMs).toBeGreaterThan(DEFAULT_RESOURCE_LIMITS.apiTimeoutMs);

    // Health check interval should be reasonable
    expect(DEFAULT_RESOURCE_LIMITS.healthCheckIntervalMs).toBeGreaterThanOrEqual(1000);
  });

  it('should have all required fields', () => {
    expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty('maxHeapMB');
    expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty('maxOldGenerationMB');
    expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty('apiTimeoutMs');
    expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty('toolTimeoutMs');
    expect(DEFAULT_RESOURCE_LIMITS).toHaveProperty('healthCheckIntervalMs');
  });
});
