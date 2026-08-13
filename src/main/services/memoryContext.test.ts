import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../repositories', () => ({ getMemoryBlockRepository: vi.fn() }));
vi.mock('./ServiceRegistry', () => ({ getServiceRegistry: vi.fn() }));

import { buildMemoryContext } from './memoryContext';
import { getMemoryBlockRepository } from '../repositories';
import { getServiceRegistry } from './ServiceRegistry';

const blocks = [
  { label: 'human', value: '', description: 'Who you are working with' },
  { label: 'current_focus', value: 'Shipping the memory layer', description: 'What is active' },
];
const ensureDefaults = vi.fn();

beforeEach(() => {
  vi.mocked(getMemoryBlockRepository).mockReturnValue({
    ensureDefaults,
    getByAgent: () => blocks,
  } as never);
});

function mockBackend(memories: unknown[] | null, total?: number) {
  vi.mocked(getServiceRegistry).mockReturnValue({
    hasProviders: () => memories !== null,
    call: async () => (memories === null ? { success: false } : { success: true, memories, total: total ?? memories.length }),
  } as never);
}

describe('buildMemoryContext', () => {
  it('seeds defaults and renders core blocks (empty → guidance placeholder, filled → value)', async () => {
    mockBackend([]);
    const out = await buildMemoryContext('a1');
    expect(ensureDefaults).toHaveBeenCalledWith('a1');
    expect(out).toContain('## Core memory');
    expect(out).toContain('### human\n(empty — Who you are working with)');
    expect(out).toContain('### current_focus\nShipping the memory layer');
    // No memories → no manifest section.
    expect(out).not.toContain('## Memory index');
  });

  it('renders the manifest with key, tags, and description — but never values', async () => {
    mockBackend([
      { key: 'daniel-webster', metadata: { tags: ['research', 'people'], description: 'person of interest' } },
      { key: 'bizarre-sop', metadata: { tags: ['bizarre'] } },
    ]);
    const out = await buildMemoryContext('a1');
    expect(out).toContain('## Memory index (search_memories to pull full content; store_memory to add)');
    expect(out).toContain('- daniel-webster [research, people] — person of interest');
    expect(out).toContain('- bizarre-sop [bizarre]');
    expect(out).toContain('(2 stored)');
  });

  it('flags truncation when total exceeds the returned page', async () => {
    mockBackend([{ key: 'k1', metadata: {} }], 130);
    const out = await buildMemoryContext('a1');
    expect(out).toContain('… and 129 more (130 total)');
  });

  it('degrades gracefully to core-only when no backend is present', async () => {
    mockBackend(null);
    const out = await buildMemoryContext('a1');
    expect(out).toContain('## Core memory');
    expect(out).not.toContain('## Memory index');
  });
});
