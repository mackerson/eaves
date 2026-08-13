/**
 * Regression tests for PluginConfigManager security fixes:
 *  - secrets no longer logged (config values dropped from the update log line)
 *  - deleteConfig exists, so uninstall can drop persisted secrets
 *  - a `__proto__`/`constructor`/`prototype` plugin id can't pollute the
 *    config map's prototype and leak into other plugins' getConfig() results
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const getPathMock = vi.fn();
vi.mock('electron', () => ({
  app: { getPath: (...args: unknown[]) => getPathMock(...args) },
}));

const loggerInfoMock = vi.fn();
vi.mock('./logger', () => ({
  logger: { info: (...args: unknown[]) => loggerInfoMock(...args), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PluginConfigManager } from './PluginConfigManager';

describe('PluginConfigManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-plugin-config-'));
    getPathMock.mockReturnValue(tmpDir);
    loggerInfoMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a normal plugin config', () => {
    const manager = new PluginConfigManager();
    manager.setConfig('com.alice.notes', { apiKey: 'secret-value' });
    expect(manager.getConfig('com.alice.notes')).toEqual({ apiKey: 'secret-value' });
  });

  it('never logs config values, only key names', () => {
    const manager = new PluginConfigManager();
    manager.setConfig('com.alice.notes', { apiKey: 'super-secret-token' });

    for (const call of loggerInfoMock.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('super-secret-token');
    }
  });

  it('deleteConfig removes a plugin config from memory and disk', () => {
    const manager = new PluginConfigManager();
    manager.setConfig('com.alice.notes', { apiKey: 'secret-value' });
    manager.deleteConfig('com.alice.notes');

    expect(manager.getConfig('com.alice.notes')).toEqual({});

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugin-configs.json'), 'utf-8'));
    expect(onDisk).not.toHaveProperty('com.alice.notes');
  });

  it('rejects __proto__ as a plugin id instead of polluting the config map', () => {
    const manager = new PluginConfigManager();

    expect(() => manager.setConfig('__proto__', { evil: 'injected' })).toThrow();
    expect(() => manager.setConfig('constructor', { evil: 'injected' })).toThrow();
    expect(() => manager.setConfig('prototype', { evil: 'injected' })).toThrow();

    // A plugin that was never configured must still resolve to an empty
    // config, not to keys leaked in from Object.prototype.
    expect(manager.getConfig('some-other-plugin')).toEqual({});
    expect((manager.getConfig('some-other-plugin') as Record<string, unknown>).evil).toBeUndefined();
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it('does not let a __proto__ entry in an on-disk config file pollute lookups after reload', () => {
    // A file written before this fix (or by a hostile actor with filesystem
    // access) could contain a "__proto__" top-level key. loadConfigs must not
    // resurrect it as a live prototype link.
    //
    // Written as a raw string, not `JSON.stringify({ __proto__: ... })` — an
    // object *literal* with a literal `__proto__` key sets the prototype at
    // construction time instead of creating an own property, so it would
    // never round-trip through JSON.stringify and this test would pass
    // vacuously. `JSON.parse`, unlike object-literal syntax, has no such
    // special case: it creates "__proto__" as an ordinary own property.
    fs.writeFileSync(
      path.join(tmpDir, 'plugin-configs.json'),
      '{"__proto__":{"evil":"injected"},"com.alice.notes":{"apiKey":"a"}}'
    );

    const manager = new PluginConfigManager();

    expect(manager.getConfig('some-other-plugin')).toEqual({});
    expect(manager.getConfig('com.alice.notes')).toEqual({ apiKey: 'a' });
  });
});
