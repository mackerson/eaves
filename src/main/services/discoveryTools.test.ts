import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod/v3';
import { createDiscoveryTools, ToolSessionState } from './discoveryTools';

/**
 * Focused tests for the compact / verbose list_tools output. The point of the
 * compact default is keeping a single list_tools result inside a tiny model's
 * context budget, so verbose descriptions (e.g. multi-paragraph DAG vocab)
 * have to collapse to a one-line teaser without losing structure.
 */

function makeStubTools() {
  return {
    short_tool: tool({
      description: 'Add two numbers.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async () => 0,
    }),
    verbose_tool: tool({
      description: `Create a new workflow for the current project. A workflow is a DAG of nodes and edges.

IMPORTANT: Workflows you create are queued for human review and cannot execute until the user approves them.

Canonical node types and required data fields:
- start: entry marker
- end: exit marker
- code: run a script in a subprocess`,
      inputSchema: z.object({ name: z.string() }),
      execute: async () => 0,
    }),
  };
}

function makeSession(...names: string[]): ToolSessionState {
  return { enabledTools: new Set(names) };
}

describe('list_tools (compact mode)', () => {
  it('trims multi-paragraph descriptions to a one-line teaser', async () => {
    const allTools = makeStubTools();
    const metadata = new Map<string, { category: string; origin: string }>();
    metadata.set('short_tool', { category: 'builtin', origin: 'enclave-core' });
    metadata.set('verbose_tool', { category: 'builtin', origin: 'enclave-core' });

    const { list_tools } = createDiscoveryTools(allTools, makeSession(), metadata);
    const result = await (list_tools.execute as any)({}, {} as never);

    const verbose = result.tools.find((t: any) => t.name === 'verbose_tool');
    expect(verbose.description.length).toBeLessThan(120);
    // First sentence kept; rest dropped.
    expect(verbose.description).toContain('Create a new workflow');
    expect(verbose.description).not.toContain('IMPORTANT');
    expect(verbose.description).not.toContain('Canonical node types');
  });

  it('keeps short descriptions intact', async () => {
    const allTools = makeStubTools();
    const metadata = new Map<string, { category: string; origin: string }>();
    metadata.set('short_tool', { category: 'builtin', origin: 'enclave-core' });

    const { list_tools } = createDiscoveryTools(allTools, makeSession(), metadata);
    const result = await (list_tools.execute as any)({}, {} as never);

    const short = result.tools.find((t: any) => t.name === 'short_tool');
    expect(short.description).toBe('Add two numbers.');
  });

  it('returns the flat compact shape and omits inputSchema', async () => {
    const allTools = makeStubTools();
    const metadata = new Map<string, { category: string; origin: string }>();
    metadata.set('short_tool', { category: 'builtin', origin: 'enclave-core' });

    const { list_tools } = createDiscoveryTools(allTools, makeSession('short_tool'), metadata);
    const result = await (list_tools.execute as any)({}, {} as never);

    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.counts).toBeDefined();
    expect(result.enabledCount).toBe(1);
    expect(result.tools[0].inputSchema).toBeUndefined();
    expect(result.hint).toMatch(/verbose: true/);
  });

  it('verbose: true restores nested categories + schemas', async () => {
    const allTools = makeStubTools();
    const metadata = new Map<string, { category: string; origin: string }>();
    metadata.set('short_tool', { category: 'builtin', origin: 'enclave-core' });
    metadata.set('verbose_tool', { category: 'builtin', origin: 'enclave-core' });

    const { list_tools } = createDiscoveryTools(allTools, makeSession(), metadata);
    const result = await (list_tools.execute as any)({ verbose: true }, {} as never);

    expect(result.categories).toBeDefined();
    expect(result.categories.builtin.count).toBe(2);
    const verbose = result.categories.builtin.tools.find((t: any) => t.name === 'verbose_tool');
    // Full description preserved (multi-paragraph).
    expect(verbose.description).toContain('IMPORTANT');
    expect(verbose.inputSchema).toEqual(['name']);
  });
});
