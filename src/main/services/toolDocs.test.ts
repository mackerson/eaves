import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod/v3';

// builtinTools transitively loads database.ts (reads app.getPath at load) and
// the event bus / logger. Stub them so the import graph resolves.
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));

import { TOOL_DOCS, TRIMMED_TOOLS, fullToolDescription } from './toolDocs';
import { createDiscoveryTools } from './discoveryTools';
import { builtinTools, assertValidGraph } from './builtinTools';
import { createTranscriptTools } from './transcriptTools';
import { WORKFLOW_NODE_TYPES } from '../../shared/workflowNodeTypes';

/**
 * The trim is only safe because the detail is still reachable. These tests hold
 * both halves of that bargain: the wire descriptions stay small, and
 * get_tool_info still hands back everything they gave up.
 *
 * Motivated by a measurement: 44 tools came to ~7,400 estimated tokens of
 * schema per request, roughly 88% of each step's input.
 */

/**
 * A ceiling per trimmed tool, in characters of wire description. Generous
 * against the trimmed sizes — this is a guard against the tutorial creeping
 * back in, not a style rule.
 */
const WIRE_DESCRIPTION_BUDGET: Record<string, number> = {
  create_workflow: 500,
  update_workflow: 350,
  create_routine: 300,
  update_routine: 250,
  execute_code: 600,
};

// TRIMMED_TOOLS spans builtins and agent-scoped tools; both are on the wire,
// so both owe the model the same pointer to where the detail went.
const allDescribedTools: Record<string, { description?: string }> = {
  ...(builtinTools as Record<string, { description?: string }>),
  ...(createTranscriptTools('agent-1') as unknown as Record<string, { description?: string }>),
};

describe('trimmed tool descriptions', () => {
  for (const [name, budget] of Object.entries(WIRE_DESCRIPTION_BUDGET)) {
    it(`${name} stays within its wire budget`, () => {
      const description = allDescribedTools[name].description as string;
      expect(description.length).toBeLessThanOrEqual(budget);
    });
  }

  it('points at get_tool_info wherever detail was removed', () => {
    for (const name of TRIMMED_TOOLS) {
      const description = allDescribedTools[name].description as string;
      expect(description, `${name} must tell the model where the detail went`).toContain('get_tool_info');
    }
  });

  it('has extended docs for every trimmed tool', () => {
    for (const name of TRIMMED_TOOLS) {
      expect(TOOL_DOCS[name], `${name} was trimmed with nothing to serve in its place`).toBeTruthy();
    }
  });

  it('keeps the two execute_code rules whose violation is expensive', () => {
    const description = (builtinTools as any).execute_code.description as string;
    expect(description).toContain('FRESH process');
    expect(description).toMatch(/large output/i);
  });

  it('does not carry the node-type grammar on the wire', () => {
    const description = (builtinTools as any).create_workflow.description as string;
    expect(description).not.toContain('webscraper');
    expect(description).not.toContain('maxIterations');
  });
});

describe('fullToolDescription', () => {
  it('appends the extended docs for a documented tool', () => {
    const merged = fullToolDescription('create_workflow', 'headline');
    expect(merged.startsWith('headline')).toBe(true);
    expect(merged).toContain('Canonical node types');
  });

  it('returns the description untouched for an undocumented tool', () => {
    expect(fullToolDescription('web_fetch', 'headline')).toBe('headline');
  });

  it('documents every node type, generated from the spec map', () => {
    for (const type of WORKFLOW_NODE_TYPES) {
      expect(TOOL_DOCS.create_workflow).toContain(`- ${type.padEnd(11)}:`);
    }
  });
});

describe('assertValidGraph', () => {
  const node = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, data });

  it('accepts a graph whose nodes carry their required data', () => {
    expect(() =>
      assertValidGraph({
        nodes: [
          node('n1', 'start', { label: 'Begin' }),
          node('n2', 'http', { label: 'Fetch', url: 'https://example.com' }),
          node('n3', 'end', { label: 'Done' }),
        ],
      })
    ).not.toThrow();
  });

  it('accepts an empty or absent graph', () => {
    expect(() => assertValidGraph({ nodes: [] })).not.toThrow();
    expect(() => assertValidGraph(undefined)).not.toThrow();
  });

  it('rejects a node missing required data, naming the node and the shape', () => {
    expect(() =>
      assertValidGraph({ nodes: [node('crunch', 'code', { label: 'Crunch' })] })
    ).toThrow(/node "crunch".*`code`/s);
  });

  it('reports every bad node, not just the first', () => {
    let message = '';
    try {
      assertValidGraph({
        nodes: [
          node('a', 'code', { label: 'A' }),
          node('b', 'webscraper', { label: 'B' }),
        ],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('2 node(s)');
    expect(message).toContain('node "a"');
    expect(message).toContain('node "b"');
  });
});

describe('get_tool_info', () => {
  it('serves the detail the wire description no longer carries', async () => {
    const stub = {
      create_workflow: tool({
        description: 'Create a new workflow. Call get_tool_info for the node-type grammar.',
        inputSchema: z.object({ name: z.string() }),
        execute: async () => 0,
      }),
    };
    const metadata = new Map([['create_workflow', { category: 'builtin', origin: 'enclave-core' }]]);

    const { get_tool_info } = createDiscoveryTools(stub, { enabledTools: new Set() }, metadata);
    const info = await (get_tool_info.execute as any)({ toolName: 'create_workflow' }, {} as never);

    expect(info.description).toContain('Canonical node types');
    expect(info.description).toContain('conditional');
    expect(info.description).toContain('${node-id}');
  });
});
