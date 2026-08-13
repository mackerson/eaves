import { describe, it, expect, vi } from 'vitest';

// AgentTurnService pulls a heavy import graph; stub the edges we never exercise.
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  BrowserWindow: class {},
}));
vi.mock('../repositories', () => ({
  getChannelRepository: vi.fn(),
  getAgentRepository: vi.fn(),
  getSettingsRepository: vi.fn(),
  getProjectRepository: vi.fn(),
}));
vi.mock('../ipc/chatHelpers', () => ({
  buildToolset: vi.fn(),
  buildSystemPrompt: vi.fn(),
  runStream: vi.fn(),
  systemPromptPlumbing: vi.fn(),
  activeToolsFor: vi.fn(),
  buildRequestInfo: vi.fn(),
}));
vi.mock('./MessageFormatter', () => ({ MessageFormatter: class {} }));
vi.mock('./compaction', () => ({ maybeCompactHistory: vi.fn() }));
vi.mock('./contextBudget', () => ({
  resolveContextBudget: vi.fn(),
  estimateTokens: vi.fn(),
}));
vi.mock('./modelContext', () => ({ detectModelContext: vi.fn() }));
vi.mock('../utils/stickyProvider', () => ({ resolveStickyProvider: vi.fn() }));
vi.mock('./streamEventRouter', () => ({
  emitStreamStart: vi.fn(),
  emitStreamComplete: vi.fn(),
  emitAgentSpend: vi.fn(),
  routeStreamEvent: vi.fn(),
  createStreamMetrics: vi.fn(),
}));

import { buildChannelBehaviorNote } from './AgentTurnService';
import type { Agent, ChannelBehavior } from '../types';

const agent = { id: 'a1', name: 'Ada' } as Agent;

describe('buildChannelBehaviorNote', () => {
  it.each([
    ['mentions-only', 'brief', ['@mentioned', '1-3 sentences']],
    ['all', 'normal', ['normal conversational length']],
    ['all', 'verbose', [] as string[]],
  ] as const)('respondTo=%s verbosity=%s', (respondTo, verbosity, snippets) => {
    const behavior = { respondTo, verbosity } as ChannelBehavior;
    const note = buildChannelBehaviorNote(agent, behavior);
    expect(note).toContain('You are Ada');
    expect(note).toContain('channel_send_message');
    if (respondTo === 'mentions-only') {
      expect(note).toContain('@mentioned');
    } else {
      expect(note).not.toContain('@mentioned');
    }
    for (const s of snippets) expect(note.toLowerCase()).toContain(s.toLowerCase());
    if (verbosity === 'verbose') {
      expect(note).not.toContain('1-3 sentences');
      expect(note).not.toContain('normal conversational length');
    }
  });
});
