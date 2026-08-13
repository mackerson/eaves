import { describe, it, expect } from 'vitest';
import { renderPromptTemplate, DEFAULT_PROMPT_TEMPLATE } from './promptTemplate';

describe('renderPromptTemplate', () => {
  it('substitutes known variables', () => {
    const out = renderPromptTemplate('You are {{agent}}. User: {{user}}.', {
      agent: 'Test', user: 'Michael',
    });
    expect(out).toBe('You are Test. User: Michael.');
  });

  it('tolerates whitespace inside braces', () => {
    const out = renderPromptTemplate('Hi {{ user }} from {{  agent  }}', {
      user: 'Michael', agent: 'Test',
    });
    expect(out).toBe('Hi Michael from Test');
  });

  it('leaves unknown variables intact for downstream mustache passes', () => {
    // {{custom}} isn't in our known set; agent.contextVariables substitution
    // runs after this and should still see it.
    const out = renderPromptTemplate('Hello {{user}} — {{custom}}', { user: 'Michael' });
    expect(out).toBe('Hello Michael — {{custom}}');
  });

  it('collapses blank lines left by empty variables', () => {
    const out = renderPromptTemplate(
      'Persona\n\nProject: {{project}}\n\nParticipants:\n{{participants}}\n\nEnd',
      { project: 'Personal', participants: '' },
    );
    // The "Participants:" header still shows (author's literal), but the empty
    // {{participants}} doesn't leave a triple newline behind it.
    expect(out).toBe('Persona\n\nProject: Personal\n\nParticipants:\n\nEnd');
  });

  it('trims surrounding whitespace', () => {
    const out = renderPromptTemplate('\n\n{{systemPrompt}}\n\n', { systemPrompt: 'Hi' });
    expect(out).toBe('Hi');
  });

  it('renders the default template against a representative variable map', () => {
    const out = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      systemPrompt: 'You are a tester.',
      agent: 'Test',
      user: 'Michael',
      project: 'Personal',
      participants: '- Humans: Michael\n- Agents: Test (you)',
    });
    expect(out).toContain('You are a tester.');
    expect(out).toContain('You are Test. The user\'s name is Michael.');
    expect(out).toContain('Project: Personal');
    expect(out).toContain('- Humans: Michael');
    expect(out).toContain('- Agents: Test (you)');
  });
});
