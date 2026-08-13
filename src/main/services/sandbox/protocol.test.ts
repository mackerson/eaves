/**
 * Protocol Tests
 *
 * Tests for message serialization, validation, and request correlation.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isSerializable,
  sanitizeForSerialization,
  serializeError,
  deserializeError,
  createRPCRequest,
  createRPCResponse,
  createRPCError,
  validateMessage,
  validateRPCRequest,
  validateRPCResponse,
  validateRPCError,
  RequestCorrelator,
  parseMethodPath,
  createMethodPath,
} from './protocol';

describe('isSerializable', () => {
  describe('primitives', () => {
    it('should return true for null', () => {
      expect(isSerializable(null)).toBe(true);
    });

    it('should return true for undefined', () => {
      expect(isSerializable(undefined)).toBe(true);
    });

    it('should return true for booleans', () => {
      expect(isSerializable(true)).toBe(true);
      expect(isSerializable(false)).toBe(true);
    });

    it('should return true for valid numbers', () => {
      expect(isSerializable(0)).toBe(true);
      expect(isSerializable(42)).toBe(true);
      expect(isSerializable(-3.14)).toBe(true);
    });

    it('should return false for NaN', () => {
      expect(isSerializable(NaN)).toBe(false);
    });

    it('should return false for Infinity', () => {
      expect(isSerializable(Infinity)).toBe(false);
      expect(isSerializable(-Infinity)).toBe(false);
    });

    it('should return true for strings', () => {
      expect(isSerializable('')).toBe(true);
      expect(isSerializable('hello')).toBe(true);
    });
  });

  describe('non-serializable values', () => {
    it('should return false for functions', () => {
      expect(isSerializable(() => {})).toBe(false);
      expect(isSerializable(function named() {})).toBe(false);
    });

    it('should return false for symbols', () => {
      expect(isSerializable(Symbol('test'))).toBe(false);
    });
  });

  describe('objects', () => {
    it('should return true for plain objects', () => {
      expect(isSerializable({})).toBe(true);
      expect(isSerializable({ name: 'test', count: 42 })).toBe(true);
    });

    it('should return true for arrays', () => {
      expect(isSerializable([])).toBe(true);
      expect(isSerializable([1, 2, 3])).toBe(true);
      expect(isSerializable(['a', 'b', 'c'])).toBe(true);
    });

    it('should return true for nested objects', () => {
      expect(isSerializable({
        level1: {
          level2: {
            value: 'deep',
          },
        },
      })).toBe(true);
    });

    it('should return false for circular references', () => {
      const obj: any = { name: 'test' };
      obj.self = obj;
      expect(isSerializable(obj)).toBe(false);
    });

    it('should return false for Date objects', () => {
      expect(isSerializable(new Date())).toBe(false);
    });

    it('should return false for Map objects', () => {
      expect(isSerializable(new Map())).toBe(false);
    });

    it('should return false for Set objects', () => {
      expect(isSerializable(new Set())).toBe(false);
    });

    it('should return false for class instances', () => {
      class TestClass {
        value = 42;
      }
      expect(isSerializable(new TestClass())).toBe(false);
    });

    it('should return true for CallbackRef objects', () => {
      expect(isSerializable({
        __type: 'CallbackRef',
        callbackId: 'cb-123',
      })).toBe(true);
    });

    it('should return false for objects containing functions', () => {
      expect(isSerializable({
        name: 'test',
        handler: () => {},
      })).toBe(false);
    });
  });
});

describe('sanitizeForSerialization', () => {
  describe('primitives', () => {
    it('should pass through primitives unchanged', () => {
      expect(sanitizeForSerialization(null)).toBe(null);
      expect(sanitizeForSerialization(undefined)).toBe(undefined);
      expect(sanitizeForSerialization(true)).toBe(true);
      expect(sanitizeForSerialization(42)).toBe(42);
      expect(sanitizeForSerialization('hello')).toBe('hello');
    });

    it('should convert NaN to null', () => {
      expect(sanitizeForSerialization(NaN)).toBe(null);
    });

    it('should convert Infinity to null', () => {
      expect(sanitizeForSerialization(Infinity)).toBe(null);
      expect(sanitizeForSerialization(-Infinity)).toBe(null);
    });
  });

  describe('functions and symbols', () => {
    it('should convert functions to null', () => {
      expect(sanitizeForSerialization(() => {})).toBe(null);
    });

    it('should convert symbols to null', () => {
      expect(sanitizeForSerialization(Symbol('test'))).toBe(null);
    });
  });

  describe('objects', () => {
    it('should deep clone plain objects', () => {
      const obj = { name: 'test', count: 42 };
      const result = sanitizeForSerialization(obj);
      expect(result).toEqual(obj);
      expect(result).not.toBe(obj);
    });

    it('should deep clone arrays', () => {
      const arr = [1, 2, 3];
      const result = sanitizeForSerialization(arr);
      expect(result).toEqual(arr);
      expect(result).not.toBe(arr);
    });

    it('should handle nested objects', () => {
      const obj = {
        level1: {
          level2: {
            value: 'deep',
          },
        },
      };
      const result = sanitizeForSerialization(obj);
      expect(result).toEqual(obj);
    });

    it('should handle circular references', () => {
      const obj: any = { name: 'test' };
      obj.self = obj;
      const result = sanitizeForSerialization(obj);
      expect(result).toEqual({ name: 'test', self: '[Circular]' });
    });

    it('should convert Date to ISO string', () => {
      const date = new Date('2024-01-01T00:00:00Z');
      const result = sanitizeForSerialization(date);
      expect(result).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should serialize Error objects', () => {
      const error = new Error('test error');
      const result = sanitizeForSerialization(error) as any;
      expect(result.name).toBe('Error');
      expect(result.message).toBe('test error');
    });

    it('should convert Map to object', () => {
      const map = new Map([['key1', 'value1'], ['key2', 'value2']]);
      const result = sanitizeForSerialization(map);
      expect(result).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should convert Set to array', () => {
      const set = new Set([1, 2, 3]);
      const result = sanitizeForSerialization(set);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should strip functions from objects', () => {
      const obj = {
        name: 'test',
        handler: () => {},
      };
      const result = sanitizeForSerialization(obj);
      expect(result).toEqual({ name: 'test', handler: null });
    });

    it('should preserve CallbackRef objects', () => {
      const callbackRef = {
        __type: 'CallbackRef' as const,
        callbackId: 'cb-123',
      };
      const result = sanitizeForSerialization(callbackRef);
      expect(result).toEqual(callbackRef);
    });
  });
});

describe('serializeError', () => {
  it('should serialize Error objects', () => {
    const error = new Error('test message');
    const result = serializeError(error);

    expect(result.name).toBe('Error');
    expect(result.message).toBe('test message');
    expect(result.stack).toBeDefined();
  });

  it('should include error code if present', () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    const result = serializeError(error);

    expect(result.code).toBe('ENOENT');
  });

  it('should serialize string errors', () => {
    const result = serializeError('string error');
    expect(result.name).toBe('Error');
    expect(result.message).toBe('string error');
  });

  it('should serialize unknown errors', () => {
    const result = serializeError(42);
    expect(result.name).toBe('UnknownError');
    expect(result.message).toBe('42');
  });

  it('should preserve error name', () => {
    const error = new TypeError('type error');
    const result = serializeError(error);
    expect(result.name).toBe('TypeError');
  });
});

describe('deserializeError', () => {
  it('should deserialize to Error object', () => {
    const serialized = {
      name: 'Error',
      message: 'test message',
    };
    const error = deserializeError(serialized);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('Error');
    expect(error.message).toBe('test message');
  });

  it('should restore error code', () => {
    const serialized = {
      name: 'Error',
      message: 'ENOENT',
      code: 'ENOENT',
    };
    const error = deserializeError(serialized) as NodeJS.ErrnoException;

    expect(error.code).toBe('ENOENT');
  });

  it('should restore stack trace', () => {
    const serialized = {
      name: 'Error',
      message: 'test',
      stack: 'Error: test\n    at test.js:1:1',
    };
    const error = deserializeError(serialized);

    expect(error.stack).toBe('Error: test\n    at test.js:1:1');
  });
});

describe('createRPCRequest', () => {
  it('should create valid RPC request', () => {
    const request = createRPCRequest('plugin-1', 'data', 'agents.getAll', []);

    expect(request.type).toBe('rpc:request');
    expect(request.pluginId).toBe('plugin-1');
    expect(request.namespace).toBe('data');
    expect(request.method).toBe('agents.getAll');
    expect(request.args).toEqual([]);
    expect(request.id).toBeDefined();
    expect(request.timestamp).toBeDefined();
  });

  it('should include args', () => {
    const request = createRPCRequest('plugin-1', 'storage', 'get', ['key1']);
    expect(request.args).toEqual(['key1']);
  });
});

describe('createRPCResponse', () => {
  it('should create valid RPC response', () => {
    const response = createRPCResponse('plugin-1', 'req-123', { value: 'test' });

    expect(response.type).toBe('rpc:response');
    expect(response.pluginId).toBe('plugin-1');
    expect(response.requestId).toBe('req-123');
    expect(response.result).toEqual({ value: 'test' });
    expect(response.id).toBeDefined();
    expect(response.timestamp).toBeDefined();
  });

  it('should sanitize result', () => {
    const response = createRPCResponse('plugin-1', 'req-123', {
      fn: () => {},
      value: 'test',
    });
    expect(response.result).toEqual({ fn: null, value: 'test' });
  });
});

describe('createRPCError', () => {
  it('should create valid RPC error', () => {
    const error = createRPCError('plugin-1', 'req-123', new Error('test error'));

    expect(error.type).toBe('rpc:error');
    expect(error.pluginId).toBe('plugin-1');
    expect(error.requestId).toBe('req-123');
    expect(error.error.name).toBe('Error');
    expect(error.error.message).toBe('test error');
  });

  it('should handle string errors', () => {
    const error = createRPCError('plugin-1', 'req-123', 'string error');
    expect(error.error.message).toBe('string error');
  });
});

describe('validateMessage', () => {
  it('should validate correct messages', () => {
    const message = {
      type: 'rpc:request',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
    };
    expect(validateMessage(message)).toBe(true);
  });

  it('should reject non-objects', () => {
    expect(validateMessage(null)).toBe(false);
    expect(validateMessage('string')).toBe(false);
    expect(validateMessage(42)).toBe(false);
  });

  it('should reject missing type', () => {
    expect(validateMessage({
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
    })).toBe(false);
  });

  it('should reject missing id', () => {
    expect(validateMessage({
      type: 'rpc:request',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
    })).toBe(false);
  });

  it('should reject missing pluginId', () => {
    expect(validateMessage({
      type: 'rpc:request',
      id: 'msg-123',
      timestamp: Date.now(),
    })).toBe(false);
  });

  it('should reject missing timestamp', () => {
    expect(validateMessage({
      type: 'rpc:request',
      id: 'msg-123',
      pluginId: 'plugin-1',
    })).toBe(false);
  });
});

describe('validateRPCRequest', () => {
  it('should validate correct RPC request', () => {
    const request = {
      type: 'rpc:request',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      namespace: 'data',
      method: 'agents.getAll',
      args: [],
    };
    expect(validateRPCRequest(request)).toBe(true);
  });

  it('should reject invalid namespace', () => {
    const request = {
      type: 'rpc:request',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      namespace: 'invalid',
      method: 'test',
      args: [],
    };
    expect(validateRPCRequest(request)).toBe(false);
  });

  it('should reject empty method', () => {
    const request = {
      type: 'rpc:request',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      namespace: 'data',
      method: '',
      args: [],
    };
    expect(validateRPCRequest(request)).toBe(false);
  });

  it('should reject non-array args', () => {
    const request = {
      type: 'rpc:request',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      namespace: 'data',
      method: 'test',
      args: 'not an array',
    };
    expect(validateRPCRequest(request)).toBe(false);
  });
});

describe('validateRPCResponse', () => {
  it('should validate correct RPC response', () => {
    const response = {
      type: 'rpc:response',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      requestId: 'req-123',
      result: { value: 'test' },
    };
    expect(validateRPCResponse(response)).toBe(true);
  });

  it('should reject missing requestId', () => {
    const response = {
      type: 'rpc:response',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      result: { value: 'test' },
    };
    expect(validateRPCResponse(response)).toBe(false);
  });
});

describe('validateRPCError', () => {
  it('should validate correct RPC error', () => {
    const error = {
      type: 'rpc:error',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      requestId: 'req-123',
      error: { name: 'Error', message: 'test' },
    };
    expect(validateRPCError(error)).toBe(true);
  });

  it('should reject missing error object', () => {
    const error = {
      type: 'rpc:error',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      requestId: 'req-123',
    };
    expect(validateRPCError(error)).toBe(false);
  });

  it('should reject null error', () => {
    const error = {
      type: 'rpc:error',
      id: 'msg-123',
      pluginId: 'plugin-1',
      timestamp: Date.now(),
      requestId: 'req-123',
      error: null,
    };
    expect(validateRPCError(error)).toBe(false);
  });
});

describe('RequestCorrelator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should register and resolve requests', async () => {
    const correlator = new RequestCorrelator<string>(1000);

    const promise = correlator.register('req-1');
    correlator.resolve('req-1', 'result');

    await expect(promise).resolves.toBe('result');
  });

  it('should register and reject requests', async () => {
    const correlator = new RequestCorrelator(1000);

    const promise = correlator.register('req-1');
    correlator.reject('req-1', new Error('test error'));

    await expect(promise).rejects.toThrow('test error');
  });

  it('should timeout requests', async () => {
    const correlator = new RequestCorrelator(100);

    const promise = correlator.register('req-1');

    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toThrow('timed out');
  });

  it('should track pending requests', () => {
    const correlator = new RequestCorrelator(1000);

    expect(correlator.size).toBe(0);

    correlator.register('req-1');
    correlator.register('req-2');

    expect(correlator.size).toBe(2);

    correlator.resolve('req-1', 'result');

    expect(correlator.size).toBe(1);
  });

  it('should check if request exists', () => {
    const correlator = new RequestCorrelator(1000);

    correlator.register('req-1');

    expect(correlator.has('req-1')).toBe(true);
    expect(correlator.has('req-2')).toBe(false);
  });

  it('should cancel all pending requests', async () => {
    const correlator = new RequestCorrelator(1000);

    const promise1 = correlator.register('req-1');
    const promise2 = correlator.register('req-2');

    correlator.cancelAll('Shutdown');

    await expect(promise1).rejects.toThrow('Shutdown');
    await expect(promise2).rejects.toThrow('Shutdown');
    expect(correlator.size).toBe(0);
  });

  it('should return stats', () => {
    const correlator = new RequestCorrelator(1000);

    const stats1 = correlator.getStats();
    expect(stats1.count).toBe(0);
    expect(stats1.oldest).toBeNull();

    vi.setSystemTime(1000);
    correlator.register('req-1');

    vi.setSystemTime(2000);
    correlator.register('req-2');

    const stats2 = correlator.getStats();
    expect(stats2.count).toBe(2);
    expect(stats2.oldest).toBe(1000);
  });

  it('should return false when resolving unknown request', () => {
    const correlator = new RequestCorrelator(1000);

    const result = correlator.resolve('unknown', 'value');
    expect(result).toBe(false);
  });

  it('should return false when rejecting unknown request', () => {
    const correlator = new RequestCorrelator(1000);

    const result = correlator.reject('unknown', new Error('test'));
    expect(result).toBe(false);
  });

  it('should use custom timeout', async () => {
    const correlator = new RequestCorrelator(1000);

    const promise = correlator.register('req-1', 50);

    vi.advanceTimersByTime(60);

    await expect(promise).rejects.toThrow('timed out');
  });
});

describe('Method path utilities', () => {
  describe('parseMethodPath', () => {
    it('should parse valid method paths', () => {
      const result = parseMethodPath('agents.getAll');
      expect(result).toEqual({ namespace: 'agents', method: 'getAll' });
    });

    it('should handle nested method paths', () => {
      const result = parseMethodPath('data.agents.getById');
      expect(result).toEqual({ namespace: 'data', method: 'agents.getById' });
    });

    it('should return null for invalid paths', () => {
      expect(parseMethodPath('singleSegment')).toBeNull();
      expect(parseMethodPath('')).toBeNull();
    });
  });

  describe('createMethodPath', () => {
    it('should create method paths', () => {
      expect(createMethodPath('data', 'agents.getAll')).toBe('data.agents.getAll');
      expect(createMethodPath('storage', 'get')).toBe('storage.get');
    });
  });
});
