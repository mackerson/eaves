import { describe, it, expect } from 'vitest';
import { buildRoleplayNote } from './buildRoleplayNote';
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

describe('buildRoleplayNote', () => {
  it('returns undefined when the agent has no archetype', () => {
    expect(buildRoleplayNote(baseAgent)).toBeUndefined();
  });

  it('returns undefined for non-roleplay archetypes', () => {
    expect(buildRoleplayNote({ ...baseAgent, archetype: { type: 'task-oriented' } })).toBeUndefined();
    expect(buildRoleplayNote({ ...baseAgent, archetype: { type: 'shadow' } })).toBeUndefined();
  });

  it('returns the framing block for roleplay archetype with no persona', () => {
    const note = buildRoleplayNote({ ...baseAgent, archetype: { type: 'roleplay' } });
    expect(note).toBeDefined();
    expect(note).toMatch(/Stay in character/i);
    expect(note).toMatch(/fourth wall/i);
    expect(note).not.toMatch(/The user is playing/i);
  });

  it('appends the persona line when chat.userPersona is set', () => {
    const note = buildRoleplayNote(
      { ...baseAgent, archetype: { type: 'roleplay' } },
      { userPersona: 'Kael, a wandering scribe' },
    );
    expect(note).toMatch(/The user is playing: Kael, a wandering scribe/);
  });

  it('ignores blank/whitespace personas', () => {
    const note = buildRoleplayNote(
      { ...baseAgent, archetype: { type: 'roleplay' } },
      { userPersona: '   ' },
    );
    expect(note).toBeDefined();
    expect(note).not.toMatch(/The user is playing/i);
  });
});
