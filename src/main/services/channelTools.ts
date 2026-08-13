import { tool } from 'ai';
import { z } from 'zod/v3';
import { getChannelRepository, getAgentRepository, getUserRepository } from '../repositories';
import { eventBus } from './EventBus';

/**
 * Channel management tools scoped to a specific calling agent.
 * These let agents send messages, create channels, invite participants,
 * and read channel history — enabling agent-to-agent communication.
 */
export function createChannelTools(callingAgentId: string, currentChannelId?: string) {
  return {
    channel_send_message: tool({
      description: 'Send a message to a different channel (not the one you are currently in). For cross-channel communication only. IMPORTANT: Use @AgentName in the content to trigger another agent to respond.',
      inputSchema: z.object({
        channelId: z.string().describe('The ID of the target channel (must be different from your current channel)'),
        content: z.string().describe('The message content. Use @AgentName to trigger a response from that agent.'),
      }),
      execute: async ({ channelId, content }) => {
        // Hard block: cannot use this tool to post in the current channel
        if (currentChannelId && channelId === currentChannelId) {
          return { success: false, error: 'Cannot send to your current channel with this tool. Just write your response directly — use @AgentName in your reply text to mention other agents.' };
        }

        const channelRepo = getChannelRepository();
        const agentRepo = getAgentRepository();
        const channel = channelRepo.getById(channelId, { includeMessages: false });
        const agent = agentRepo.getById(callingAgentId);

        if (!channel) return { success: false, error: 'Channel not found' };
        if (!agent) return { success: false, error: 'Agent not found' };
        if (!channel.participants.some(p => p.id === callingAgentId)) {
          return { success: false, error: 'You are not a participant in this channel' };
        }

        const msg = channelRepo.createMessage({
          channelId,
          senderId: callingAgentId,
          senderType: 'agent',
          senderDisplayName: agent.name,
          senderColor: agent.color,
          metadata: { participantType: 'agent' },
          content,
          timestamp: Date.now(),
        });

        // Explicit dispatch intent (ADR-001): the createMessage storage event
        // above does not drive dispatch. Dynamic import breaks the module
        // cycle (chatHelpers → channelTools → ChannelDispatcher →
        // AgentTurnService → chatHelpers). A cross-channel tool send is a
        // chain root (depth 0): it replies to nothing in the target channel,
        // so it starts with the full loop budget.
        const { requestChannelDispatch } = await import('./ChannelDispatcher');
        requestChannelDispatch({
          channelId,
          triggerMessageId: msg.id,
          triggerContent: content,
          senderId: callingAgentId,
          senderType: 'agent',
          chainDepth: 0,
        });

        return { success: true, messageId: msg.id };
      },
    }),

    channel_list: tool({
      description: 'List channels you are a participant in, with participant info.',
      inputSchema: z.object({}),
      execute: async () => {
        const channelRepo = getChannelRepository();
        const allChannels = channelRepo.getAll();
        const myChannels = allChannels.filter(ch =>
          ch.participants.some(p => p.id === callingAgentId)
        );

        return {
          channelCount: myChannels.length,
          channels: myChannels.map(ch => ({
            id: ch.id,
            name: ch.name,
            type: ch.type,
            participantCount: ch.participants.length,
            participants: ch.participants.map(p => ({
              name: p.displayName,
              type: p.type,
              id: p.id,
            })),
          })),
        };
      },
    }),

    channel_create: tool({
      description: 'Create a new channel. You are automatically added as a participant.',
      inputSchema: z.object({
        name: z.string().describe('Channel name'),
        type: z.enum(['public', 'project', 'direct']).optional().describe('Channel type (default: public)'),
      }),
      execute: async ({ name, type = 'public' }) => {
        const channelRepo = getChannelRepository();
        const agentRepo = getAgentRepository();
        const agent = agentRepo.getById(callingAgentId);

        if (!agent) return { success: false, error: 'Agent not found' };

        const channel = channelRepo.create(
          { name, type },
          [{ id: callingAgentId, type: 'agent', displayName: agent.name, color: agent.color, joinedAt: Date.now() }]
        );

        eventBus.emitEvent('channel:created', { channelId: channel.id, name: channel.name });
        return { success: true, channelId: channel.id, name: channel.name };
      },
    }),

    channel_invite: tool({
      description: 'Invite an agent or user to a channel you are in.',
      inputSchema: z.object({
        channelId: z.string().describe('The channel ID'),
        participantName: z.string().describe('The display name of the agent or user to invite'),
      }),
      execute: async ({ channelId, participantName }) => {
        const channelRepo = getChannelRepository();
        const channel = channelRepo.getById(channelId, { includeMessages: false });

        if (!channel) return { success: false, error: 'Channel not found' };
        if (!channel.participants.some(p => p.id === callingAgentId)) {
          return { success: false, error: 'You are not a participant in this channel' };
        }

        // Try to find by name among agents first, then users
        const agentRepo = getAgentRepository();
        const allAgents = agentRepo.getAll();
        const agent = allAgents.find(a => a.name.toLowerCase() === participantName.toLowerCase());
        if (agent) {
          channelRepo.addParticipant(channelId, {
            id: agent.id, type: 'agent', displayName: agent.name,
            color: agent.color, joinedAt: Date.now(),
          });
          eventBus.emitEvent('channel:updated', { channelId, action: 'participant-added', participantName: agent.name });
          return { success: true, invited: agent.name, type: 'agent' };
        }

        const userRepo = getUserRepository();
        const allUsers = userRepo.getAll();
        const user = allUsers.find(u => u.name.toLowerCase() === participantName.toLowerCase());
        if (user) {
          channelRepo.addParticipant(channelId, {
            id: user.id, type: 'human', displayName: user.name,
            color: user.color, joinedAt: Date.now(),
          });
          eventBus.emitEvent('channel:updated', { channelId, action: 'participant-added', participantName: user.name });
          return { success: true, invited: user.name, type: 'human' };
        }

        return { success: false, error: `No agent or user found with name "${participantName}"` };
      },
    }),

    channel_history: tool({
      description: 'Read recent messages from a channel you are in.',
      inputSchema: z.object({
        channelId: z.string().describe('The channel ID'),
        limit: z.number().optional().describe('Number of recent messages to fetch (default: 20, max: 50)'),
      }),
      execute: async ({ channelId, limit = 20 }) => {
        const channelRepo = getChannelRepository();
        const channel = channelRepo.getById(channelId, { includeMessages: false });

        if (!channel) return { success: false, error: 'Channel not found' };
        if (!channel.participants.some(p => p.id === callingAgentId)) {
          return { success: false, error: 'You are not a participant in this channel' };
        }

        const clampedLimit = Math.min(Math.max(limit, 1), 50);
        const messages = channelRepo.getMessagesByChannelId(channelId, clampedLimit);

        return {
          channelName: channel.name,
          messageCount: messages.length,
          messages: messages.map(m => ({
            id: m.id,
            sender: m.senderDisplayName,
            senderType: m.senderType,
            content: m.content,
            timestamp: new Date(m.timestamp).toISOString(),
          })),
        };
      },
    }),
  };
}
