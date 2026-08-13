import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceRegistry } from './ServiceRegistry';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));

const api = (tag: string) => ({ whoami: () => tag });

describe('ServiceRegistry fallback / override direction', () => {
  let reg: ServiceRegistry;
  beforeEach(() => { reg = new ServiceRegistry(); });

  it('a fallback provider holds the default while it is alone', async () => {
    reg.register('core', 'memory-backend', api('core'), { isFallback: true });
    expect(reg.getDefault('memory-backend')?.pluginId).toBe('core');
    expect(await reg.call('memory-backend', 'whoami')).toBe('core');
  });

  it('a real provider overrides a fallback default, even registering later', async () => {
    reg.register('core', 'memory-backend', api('core'), { isFallback: true });
    reg.register('plugin', 'memory-backend', api('plugin')); // no isFallback
    expect(reg.getDefault('memory-backend')?.pluginId).toBe('plugin');
    expect(await reg.call('memory-backend', 'whoami')).toBe('plugin');
  });

  it('a fallback never displaces an already-selected real provider', () => {
    reg.register('plugin', 'memory-backend', api('plugin'));
    reg.register('core', 'memory-backend', api('core'), { isFallback: true });
    expect(reg.getDefault('memory-backend')?.pluginId).toBe('plugin');
  });

  it('first real provider wins; a second real provider does not steal the default', () => {
    reg.register('p1', 'memory-backend', api('p1'));
    reg.register('p2', 'memory-backend', api('p2'));
    expect(reg.getDefault('memory-backend')?.pluginId).toBe('p1');
  });

  it('unregistering the real default hands off to another real provider, not the fallback', () => {
    reg.register('core', 'memory-backend', api('core'), { isFallback: true });
    reg.register('p1', 'memory-backend', api('p1'));
    reg.register('p2', 'memory-backend', api('p2'));
    expect(reg.getDefault('memory-backend')?.pluginId).toBe('p1');
    reg.unregister('p1', 'memory-backend');
    expect(reg.getDefault('memory-backend')?.pluginId).toBe('p2'); // not 'core'
  });

  it('unregistering the last real provider drops back to the fallback floor', () => {
    reg.register('core', 'memory-backend', api('core'), { isFallback: true });
    reg.register('plugin', 'memory-backend', api('plugin'));
    reg.unregister('plugin', 'memory-backend');
    expect(reg.getDefault('memory-backend')?.pluginId).toBe('core');
  });
});
