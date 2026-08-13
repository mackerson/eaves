import { describe, it, expect } from 'vitest';
import { curateTags } from './curateTags';

describe('curateTags', () => {
  it('normalizes case and whitespace', () => {
    expect(curateTags('React,  TypeScript ,  state   management')).toBe('react, typescript, state management');
  });

  it('drops generic register tags', () => {
    expect(curateTags('greeting, casual, conversation')).toBe('');
    expect(curateTags('rust, conversation, embedded')).toBe('rust, embedded');
  });

  it('dedups after normalization', () => {
    expect(curateTags('Docker, docker,  DOCKER')).toBe('docker');
  });

  it('caps at maxTags after filtering', () => {
    expect(curateTags('chat, one, two, three, four')).toBe('one, two, three');
  });

  it('drops empty and overlong tags', () => {
    expect(curateTags(', , sqlite, ' + 'x'.repeat(51))).toBe('sqlite');
  });

  it('returns empty string for empty input', () => {
    expect(curateTags('')).toBe('');
  });
});
