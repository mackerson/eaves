import { tool } from 'ai';
import { z } from 'zod/v3';
import { getMemoryBlockRepository } from '../repositories';

/**
 * Agent-scoped core-memory tools over `MemoryBlockRepository`.
 * Core-memory blocks are always in the agent's context, so there's no read tool
 * — only edits. Created per-agent and merged into the toolset alongside the
 * channel/self tools.
 */
export function createCoreMemoryTools(agentId: string) {
  const repo = () => getMemoryBlockRepository();

  return {
    core_memory_replace: tool({
      description:
        'Replace the entire value of one of your core-memory blocks (e.g. "human", "current_focus"). ' +
        'Core memory is always in your context — keep it a concise, current summary. Creates the block if it does not exist.',
      inputSchema: z.object({
        label: z.string().describe('The block to replace, e.g. "human" or "current_focus"'),
        value: z.string().describe('The new full value for the block (kept concise; truncated past the block limit)'),
      }),
      execute: async ({ label, value }) => {
        const row = repo().setValue(agentId, label, value);
        if (!row) return { success: false, message: `Block "${label}" is read-only` };
        return { success: true, label: row.label, length: row.value.length, charLimit: row.char_limit };
      },
    }),

    core_memory_append: tool({
      description:
        'Append a line to one of your core-memory blocks (creates it if absent). Use for adding a new fact ' +
        'without rewriting the whole block. Core memory is always in your context.',
      inputSchema: z.object({
        label: z.string().describe('The block to append to, e.g. "human" or "current_focus"'),
        text: z.string().describe('The line to append'),
      }),
      execute: async ({ label, text }) => {
        const row = repo().append(agentId, label, text);
        if (!row) return { success: false, message: `Block "${label}" is read-only` };
        return { success: true, label: row.label, length: row.value.length, charLimit: row.char_limit };
      },
    }),
  };
}
