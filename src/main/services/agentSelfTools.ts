import { tool } from 'ai';
import { z } from 'zod/v3';
import { getAgentRepository } from '../repositories';
import { DEFAULT_CHANNEL_BEHAVIOR } from '../types';

/**
 * Tools that let an agent read and update its own channel behavior settings.
 * Scoped to the calling agent — cannot modify other agents.
 */
export function createAgentSelfTools(callingAgentId: string) {
  return {
    get_my_channel_behavior: tool({
      description: 'Get your current channel behavior settings (when you respond and how verbose you are).',
      inputSchema: z.object({}),
      execute: async () => {
        const agentRepo = getAgentRepository();
        const agent = agentRepo.getById(callingAgentId);
        if (!agent) return { success: false, error: 'Agent not found' };

        const behavior = agent.channelBehavior || DEFAULT_CHANNEL_BEHAVIOR;
        return {
          success: true,
          channelBehavior: behavior,
          description: {
            respondTo: behavior.respondTo === 'mentions-only'
              ? 'You only respond when @mentioned'
              : 'You respond to all messages in channels you are in',
            verbosity: behavior.verbosity === 'brief'
              ? 'Keep responses to 1-3 sentences'
              : behavior.verbosity === 'normal'
                ? 'Normal conversational length'
                : 'Detailed, thorough responses',
          },
        };
      },
    }),

    update_my_channel_behavior: tool({
      description: 'Update your channel behavior settings. Controls when you respond in channels and how verbose your responses are.',
      inputSchema: z.object({
        respondTo: z.enum(['mentions-only', 'all']).optional()
          .describe("'mentions-only' = only respond when @mentioned. 'all' = respond to every message."),
        verbosity: z.enum(['brief', 'normal', 'verbose']).optional()
          .describe("'brief' = 1-3 sentences. 'normal' = conversational. 'verbose' = detailed."),
      }),
      execute: async (updates) => {
        const agentRepo = getAgentRepository();
        const agent = agentRepo.getById(callingAgentId);
        if (!agent) return { success: false, error: 'Agent not found' };

        const current = agent.channelBehavior || DEFAULT_CHANNEL_BEHAVIOR;
        const merged = { ...current, ...updates };
        agentRepo.update(callingAgentId, { channelBehavior: merged });

        return { success: true, channelBehavior: merged };
      },
    }),
  };
}
