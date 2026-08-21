/**
 * A plugin passing the wrong shape to a UI call took the entire renderer down:
 * `showNotification({title, body, icon})` reached Toast.tsx, which renders its
 * message as a React child, which throws, and the only error boundary in the
 * tree is the app-level one. These are the coercions that make that
 * unreachable, and the reason each accepted shape is accepted.
 */
import { describe, it, expect } from 'vitest';
import { toDisplayText, toNotification } from './SandboxedPluginManager';

describe('toDisplayText', () => {
  it('passes a string through untouched', () => {
    expect(toDisplayText('🌈 activated')).toBe('🌈 activated');
  });

  it('never returns a non-string, whatever it is handed', () => {
    for (const value of [{ a: 1 }, [1, 2], 42, true, null, undefined, () => {}, Symbol('x')]) {
      expect(typeof toDisplayText(value)).toBe('string');
    }
  });

  it('prefers the field that carries the human-readable part', () => {
    expect(toDisplayText({ title: 'T', message: 'M' })).toBe('M');
    expect(toDisplayText({ title: 'T', body: 'B' })).toBe('B');
    expect(toDisplayText({ title: 'T' })).toBe('T');
  });

  it('falls back to JSON rather than "[object Object]"', () => {
    expect(toDisplayText({ count: 3 })).toBe('{"count":3}');
  });

  it('survives a value JSON cannot take', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toDisplayText(cyclic)).toBe('[unserializable]');
  });

  it('renders absence as empty, not as the word undefined', () => {
    expect(toDisplayText(undefined)).toBe('');
    expect(toDisplayText(null)).toBe('');
  });
});

describe('toNotification', () => {
  it('accepts the Web Notification shape an agent will reach for first', () => {
    expect(toNotification({ title: 'Silly Plugin', body: 'A visual test', icon: '🌈' }))
      .toEqual({ title: 'Silly Plugin', body: 'A visual test' });
  });

  it('accepts `message` as an alias for `body`, which bundled plugins use', () => {
    expect(toNotification({ title: 'Event Inspector', message: 'History cleared' }))
      .toEqual({ title: 'Event Inspector', body: 'History cleared' });
  });

  it('accepts a bare string as the body', () => {
    expect(toNotification('done')).toEqual({ title: '', body: 'done' });
  });

  it('promotes a lone title to the body rather than showing an empty notification', () => {
    expect(toNotification({ title: 'Heads up' })).toEqual({ title: '', body: 'Heads up' });
  });

  it('still produces something showable from a shape it does not know', () => {
    expect(toNotification({ nope: 1 })).toEqual({ title: '', body: '{"nope":1}' });
    expect(toNotification(undefined)).toEqual({ title: '', body: '' });
  });
});
