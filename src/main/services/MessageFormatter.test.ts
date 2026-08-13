import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { MessageFormatter } from './MessageFormatter';
import type { Agent, InstructTemplate, ContextFormatting } from '../types';

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

const template: InstructTemplate = {
  name: 'ChatML',
  stopSequence: { prefix: '<|im_start|>', suffix: '<|im_end|>' },
  separatorSequence: '\n\n',
} as InstructTemplate;

describe('MessageFormatter.collectStoppingStrings', () => {
  it('returns empty array when nothing is configured', () => {
    expect(MessageFormatter.collectStoppingStrings(baseAgent)).toEqual([]);
  });

  it('includes agent-defined stopping strings', () => {
    const agent = { ...baseAgent, stoppingStrings: ['Human:', '###'] };
    expect(MessageFormatter.collectStoppingStrings(agent)).toEqual(['Human:', '###']);
  });

  it('includes template stop sequence prefix and suffix', () => {
    expect(MessageFormatter.collectStoppingStrings(baseAgent, template)).toEqual([
      '<|im_start|>',
      '<|im_end|>',
    ]);
  });

  it('adds separator as stop string only when formatting enables it', () => {
    const formatting: ContextFormatting = { separatorsAsStopStrings: true } as ContextFormatting;
    expect(
      MessageFormatter.collectStoppingStrings(baseAgent, template, formatting)
    ).toContain('\n\n');
    expect(
      MessageFormatter.collectStoppingStrings(baseAgent, template, {} as ContextFormatting)
    ).not.toContain('\n\n');
  });

  it('deduplicates overlapping agent and template strings', () => {
    const agent = { ...baseAgent, stoppingStrings: ['<|im_end|>'] };
    const result = MessageFormatter.collectStoppingStrings(agent, template);
    expect(result.filter(s => s === '<|im_end|>')).toHaveLength(1);
  });

  it('matches what formatMessages returns, so chat and channel paths agree', () => {
    const agent = { ...baseAgent, stoppingStrings: ['Human:'], instructTemplate: template };
    const viaFormat = MessageFormatter.formatMessages(agent, [], 'sys', 'Robin').stoppingStrings;
    const direct = MessageFormatter.collectStoppingStrings(agent, agent.instructTemplate, agent.contextFormatting);
    expect(direct).toEqual(viaFormat);
  });
});

// ollama/lmstudio are the rawPrompt-capable providers in the registry, so the
// instruct-template path is reachable without stubbing getProviderAdapter.
const localAgent = { ...baseAgent, provider: 'ollama', model: 'llama3' } as Agent;

const chatml: InstructTemplate = {
  name: 'ChatML',
  systemPromptSequence: { prefix: '<|im_start|>system\n', suffix: '<|im_end|>' },
  userMessageSequence: { prefix: '<|im_start|>user\n', suffix: '<|im_end|>' },
  assistantMessageSequence: { prefix: '<|im_start|>assistant\n', suffix: '<|im_end|>' },
  separatorSequence: '\n',
} as InstructTemplate;

describe('MessageFormatter.formatMessages — context formatting', () => {
  it('leaves text untouched when no formatting is configured', () => {
    const out = MessageFormatter.formatMessages(baseAgent, [], '  padded  ', 'Robin');
    expect(out.systemPrompt).toBe('  padded  ');
  });

  it('trims surrounding whitespace when trimSpaces is set', () => {
    const agent = { ...baseAgent, contextFormatting: { trimSpaces: true } as ContextFormatting };
    expect(MessageFormatter.formatMessages(agent, [], '  padded  ').systemPrompt).toBe('padded');
  });

  it('collapses three or more newlines down to two', () => {
    const agent = {
      ...baseAgent,
      contextFormatting: { collapseConsecutiveNewlines: true } as ContextFormatting,
    };
    expect(MessageFormatter.formatMessages(agent, [], 'a\n\n\n\n\nb').systemPrompt).toBe('a\n\nb');
  });

  it('drops a trailing incomplete sentence', () => {
    const agent = {
      ...baseAgent,
      contextFormatting: { trimIncompleteSentences: true } as ContextFormatting,
    };
    expect(MessageFormatter.formatMessages(agent, [], 'Done. And then wha').systemPrompt).toBe(
      'Done.',
    );
  });

  it.each([
    ['already ends on punctuation', 'All done.'],
    ['has no punctuation at all', 'no punctuation here'],
    ['starts with the only punctuation', '.leading'],
  ])('leaves text alone when it %s', (_label, text) => {
    const agent = {
      ...baseAgent,
      contextFormatting: { trimIncompleteSentences: true } as ContextFormatting,
    };
    expect(MessageFormatter.formatMessages(agent, [], text).systemPrompt).toBe(text);
  });

  it('does not trim when the trailing remainder is only more punctuation', () => {
    const agent = {
      ...baseAgent,
      contextFormatting: { trimIncompleteSentences: true } as ContextFormatting,
    };
    expect(MessageFormatter.formatMessages(agent, [], 'Wait!?').systemPrompt).toBe('Wait!?');
  });

  it('applies formatting to message content too, not just the system prompt', () => {
    const agent = { ...baseAgent, contextFormatting: { trimSpaces: true } as ContextFormatting };
    const out = MessageFormatter.formatMessages(
      agent,
      [{ role: 'user', content: '  hi  ' }],
      'sys',
    );
    expect(out.messages[0].content).toBe('hi');
  });
});

describe('MessageFormatter.formatMessages — context variables', () => {
  it('substitutes {{user}}, {{char}} and {{description}}', () => {
    const agent = {
      ...baseAgent,
      description: 'a helpful sort',
      contextVariables: { mood: 'cheerful' },
    } as Agent;
    const out = MessageFormatter.formatMessages(
      agent,
      [],
      '{{char}} is {{mood}} with {{user}} — {{description}}',
      'Robin',
    );
    expect(out.systemPrompt).toBe('Aria is cheerful with Robin — a helpful sort');
  });

  it('prefers the first assistant message name for {{char}}', () => {
    const agent = { ...baseAgent, contextVariables: {} } as Agent;
    const out = MessageFormatter.formatMessages(
      agent,
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello', name: 'Nova' },
      ],
      '{{char}}',
      'Robin',
    );
    expect(out.systemPrompt).toBe('Nova');
  });

  it('prefers the first user message displayName for {{user}}', () => {
    const agent = { ...baseAgent, contextVariables: {} } as Agent;
    const out = MessageFormatter.formatMessages(
      agent,
      [{ role: 'user', content: 'hi', metadata: { displayName: 'Ada' } }],
      '{{user}}',
      'Robin',
    );
    expect(out.systemPrompt).toBe('Ada');
  });

  it('skips mustache substitution entirely when nothing enables it', () => {
    const out = MessageFormatter.formatMessages(baseAgent, [], '{{char}}', 'Robin');
    expect(out.systemPrompt).toBe('{{char}}');
  });
});

describe('MessageFormatter.formatMessages — template activation', () => {
  const withRegex = (activationRegex?: string) =>
    ({ ...localAgent, instructTemplate: { ...chatml, activationRegex } }) as Agent;

  it('activates when no activation regex is set', () => {
    expect(MessageFormatter.formatMessages(withRegex(), [], 'sys').useRawPrompt).toBe(true);
  });

  it('activates on a /pattern/flags regex that matches the model', () => {
    expect(MessageFormatter.formatMessages(withRegex('/LLAMA/i'), [], 'sys').useRawPrompt).toBe(
      true,
    );
  });

  it('does not activate when the regex misses the model', () => {
    expect(MessageFormatter.formatMessages(withRegex('/mistral/'), [], 'sys').useRawPrompt).toBe(
      false,
    );
  });

  it('treats a non-regex activation string as a substring match', () => {
    expect(MessageFormatter.formatMessages(withRegex('llama'), [], 'sys').useRawPrompt).toBe(true);
    expect(MessageFormatter.formatMessages(withRegex('qwen'), [], 'sys').useRawPrompt).toBe(false);
  });

  it('falls back to active when the regex is malformed', () => {
    expect(MessageFormatter.formatMessages(withRegex('/[unclosed/'), [], 'sys').useRawPrompt).toBe(
      true,
    );
  });

  it('keeps the standard message shape for providers without rawPrompt', () => {
    const agent = { ...baseAgent, instructTemplate: chatml } as Agent;
    const out = MessageFormatter.formatMessages(agent, [{ role: 'user', content: 'hi' }], 'sys');
    expect(out.useRawPrompt).toBe(false);
    expect(out.messages).toHaveLength(1);
    expect(out.systemPrompt).toBe('sys');
  });
});

describe('MessageFormatter.formatMessages — raw instruct prompt', () => {
  const messages = [
    { role: 'user' as const, content: 'hi there' },
    { role: 'assistant' as const, content: 'hello back' },
  ];

  it('assembles system, user and assistant sequences plus the trailing prefix', () => {
    const agent = { ...localAgent, instructTemplate: chatml } as Agent;
    const out = MessageFormatter.formatMessages(agent, messages, 'be nice');

    expect(out.useRawPrompt).toBe(true);
    expect(out.messages).toEqual([]);
    expect(out.systemPrompt).toBeUndefined();
    expect(out.rawPrompt).toBe(
      '<|im_start|>system\nbe nice<|im_end|>' +
        '<|im_start|>user\nhi there<|im_end|>\n' +
        '<|im_start|>assistant\nhello back<|im_end|>\n' +
        '<|im_start|>assistant\n',
    );
  });

  it('carries stopping strings through the raw-prompt return', () => {
    const agent = {
      ...localAgent,
      stoppingStrings: ['<|end|>'],
      instructTemplate: chatml,
    } as Agent;
    expect(MessageFormatter.formatMessages(agent, messages, 'sys').stoppingStrings).toEqual([
      '<|end|>',
    ]);
  });

  it('omits the system block when there is no system prompt', () => {
    const agent = { ...localAgent, instructTemplate: chatml } as Agent;
    const out = MessageFormatter.formatMessages(agent, messages, '');
    expect(out.rawPrompt?.startsWith('<|im_start|>user\n')).toBe(true);
  });

  it('omits the system block when the template has no system sequence', () => {
    const agent = {
      ...localAgent,
      instructTemplate: { ...chatml, systemPromptSequence: undefined },
    } as Agent;
    expect(MessageFormatter.formatMessages(agent, messages, 'be nice').rawPrompt).not.toContain(
      'be nice',
    );
  });

  it('skips messages whose role has no configured sequence', () => {
    const agent = {
      ...localAgent,
      instructTemplate: { ...chatml, userMessageSequence: undefined },
    } as Agent;
    const { rawPrompt } = MessageFormatter.formatMessages(agent, messages, '');
    expect(rawPrompt).not.toContain('hi there');
    expect(rawPrompt).toContain('hello back');
  });

  it('emits no separators when the template defines none', () => {
    const agent = {
      ...localAgent,
      instructTemplate: { ...chatml, separatorSequence: undefined },
    } as Agent;
    expect(MessageFormatter.formatMessages(agent, messages, '').rawPrompt).not.toContain(
      '<|im_end|>\n<|im_start|>',
    );
  });

  it('wraps each sequence in newlines when wrapSequencesWithNewline is set', () => {
    const agent = {
      ...localAgent,
      instructTemplate: { ...chatml, wrapSequencesWithNewline: true },
    } as Agent;
    expect(MessageFormatter.formatMessages(agent, messages, 'sys').rawPrompt).toContain(
      '\n<|im_start|>user\nhi there<|im_end|>\n',
    );
  });

  it('expands mustache variables inside sequences when enabled', () => {
    const agent = {
      ...localAgent,
      contextVariables: {},
      instructTemplate: {
        ...chatml,
        replaceMacroInSequences: true,
        includeNames: 'always',
        userMessageSequence: { prefix: '[{{name}}] ', suffix: '' },
        assistantMessageSequence: { prefix: '[{{name}}] ', suffix: '' },
        systemPromptSequence: undefined,
        separatorSequence: undefined,
      },
    } as Agent;
    const raw = MessageFormatter.formatMessages(agent, messages, '', 'Robin').rawPrompt;
    expect(raw).toContain('[Robin] hi there');
    expect(raw).toContain('[Aria] hello back');
  });

  it('prefers explicit message names over the {{user}}/{{char}} defaults', () => {
    const agent = {
      ...localAgent,
      contextVariables: {},
      instructTemplate: {
        ...chatml,
        replaceMacroInSequences: true,
        includeNames: 'auto',
        userMessageSequence: { prefix: '[{{name}}] ', suffix: '' },
        assistantMessageSequence: { prefix: '[{{name}}] ', suffix: '' },
        systemPromptSequence: undefined,
        separatorSequence: undefined,
      },
    } as Agent;
    const raw = MessageFormatter.formatMessages(
      agent,
      [
        { role: 'user', content: 'q', name: 'Ada' },
        { role: 'assistant', content: 'a', name: 'Nova' },
      ],
      '',
      'Robin',
    ).rawPrompt;
    expect(raw).toContain('[Ada] q');
    expect(raw).toContain('[Nova] a');
  });

  it('leaves sequence macros literal when replaceMacroInSequences is off', () => {
    const agent = {
      ...localAgent,
      contextVariables: {},
      instructTemplate: {
        ...chatml,
        includeNames: 'always',
        userMessageSequence: { prefix: '[{{name}}] ', suffix: '' },
        systemPromptSequence: undefined,
        separatorSequence: undefined,
      },
    } as Agent;
    expect(MessageFormatter.formatMessages(agent, messages, '', 'Robin').rawPrompt).toContain(
      '[{{name}}] hi there',
    );
  });
});
