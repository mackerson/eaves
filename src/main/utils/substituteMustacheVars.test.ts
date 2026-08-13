import { describe, it, expect } from 'vitest';
import { substituteMustacheVars } from './substituteMustacheVars';
import type { Agent } from '../../shared/types';

const baseAgent: Agent = {
  id: 'a1',
  name: 'Aria',
  description: '',
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  temperature: 0.7,
  mcpServers: [],
  color: '#fff',
  createdAt: 0,
};

describe('substituteMustacheVars', () => {
  it('replaces {{user}} with the user name', () => {
    expect(substituteMustacheVars('Hello {{user}}!', baseAgent, 'Robin')).toBe('Hello Robin!');
  });

  it('replaces {{agent}} and {{char}} with the agent name', () => {
    expect(substituteMustacheVars('I am {{agent}}.', baseAgent, 'Robin')).toBe('I am Aria.');
    expect(substituteMustacheVars('I am {{char}}.', baseAgent, 'Robin')).toBe('I am Aria.');
  });

  it('handles capitalized variants', () => {
    expect(substituteMustacheVars('{{User}} meets {{Char}}', baseAgent, 'Robin')).toBe('Robin meets Aria');
  });

  it('replaces every occurrence', () => {
    expect(substituteMustacheVars('{{user}} {{user}} {{user}}', baseAgent, 'Robin')).toBe('Robin Robin Robin');
  });

  it('supports custom contextVariables', () => {
    const agent = { ...baseAgent, contextVariables: { realm: 'Avalon', sword: 'Excalibur' } };
    expect(substituteMustacheVars('In {{realm}} with {{sword}}', agent, 'Robin')).toBe('In Avalon with Excalibur');
  });

  it('contextVariables override built-in keys on conflict', () => {
    const agent = { ...baseAgent, contextVariables: { user: 'Anonymous' } };
    expect(substituteMustacheVars('Hello {{user}}', agent, 'Robin')).toBe('Hello Anonymous');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(substituteMustacheVars('{{mystery}} is unset', baseAgent, 'Robin')).toBe('{{mystery}} is unset');
  });

  it('returns empty/falsy text as-is', () => {
    expect(substituteMustacheVars('', baseAgent, 'Robin')).toBe('');
  });

  it('handles a realistic character-card scenario line', () => {
    expect(substituteMustacheVars(
      'Scenario: {{user}} and {{agent}} are looking for a decently paying quest.',
      baseAgent,
      'Robin',
    )).toBe('Scenario: Robin and Aria are looking for a decently paying quest.');
  });
});
