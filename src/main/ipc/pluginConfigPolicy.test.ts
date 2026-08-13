import { describe, it, expect } from 'vitest';

import { rejectUndeclaredConfig } from './pluginConfigPolicy';

const openMemorySchema = {
  baseURL: { type: 'string', default: 'http://localhost:8080' },
  userId: { type: 'string', default: 'default-user' },
};

describe('rejectUndeclaredConfig', () => {
  it('accepts the settings a plugin declares', () => {
    expect(rejectUndeclaredConfig(openMemorySchema, { baseURL: 'https://memory.internal' }))
      .toBeNull();
  });

  it('accepts an empty write', () => {
    expect(rejectUndeclaredConfig(openMemorySchema, {})).toBeNull();
  });

  // Without this, `set-plugin-config` wrote whatever it was handed, and the
  // reload that follows fed it straight to the worker.
  it('refuses a key the manifest never declared', () => {
    expect(rejectUndeclaredConfig(openMemorySchema, { proxy: 'http://attacker' }))
      .toMatch(/not a setting this plugin declares/);
  });

  it('refuses a declared key written with the wrong type', () => {
    expect(rejectUndeclaredConfig(openMemorySchema, { baseURL: { toString: 'evil' } }))
      .toMatch(/must be a string/);
    expect(rejectUndeclaredConfig({ port: { type: 'number' } }, { port: '8080' }))
      .toMatch(/must be a number/);
    expect(rejectUndeclaredConfig({ on: { type: 'boolean' } }, { on: 'yes' }))
      .toMatch(/must be a boolean/);
  });

  // "Declares no settings" must not read as "accepts any setting".
  it('refuses any write to a plugin with no config block', () => {
    expect(rejectUndeclaredConfig(undefined, { anything: 1 }))
      .toMatch(/not a setting this plugin declares/);
    expect(rejectUndeclaredConfig(undefined, {})).toBeNull();
  });

  it('passes values whose declared type it does not model', () => {
    // The manifest format belongs to the plugin author; rejecting a type we
    // have no rule for would break valid settings. Unknown keys still fail.
    expect(rejectUndeclaredConfig({ mode: { type: 'select' } }, { mode: 'fast' })).toBeNull();
    expect(rejectUndeclaredConfig({ mode: {} }, { mode: 42 })).toBeNull();
  });

  /**
   * The limit of this check, asserted so nobody reads it as ownership: a
   * plugin UI shares the renderer's window.electron, so it can still write
   * another plugin's *declared* key. openmemory declares baseURL, and
   * redirecting it is the attack the audit described. Closing that needs
   * per-plugin renderer isolation, not validation here.
   */
  it('does not pretend to stop a write to another plugin\'s declared key', () => {
    expect(rejectUndeclaredConfig(openMemorySchema, { baseURL: 'https://attacker.example' }))
      .toBeNull();
  });
});
