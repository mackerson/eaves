import { tool } from 'ai';
import { z } from 'zod/v3';
import { getTranscriptSearchRepository } from '../repositories';
import type { TranscriptMessage } from '../repositories/TranscriptSearchRepository';
import { summarizeTranscript } from './transcriptSummary';
import { deferTool } from './toolDeferral';

/**
 * Transcript recall scoped to a specific calling agent — "what did we say
 * about this before?".
 *
 * Modelled on grep-then-read rather than on `search_memories`. A search hit
 * carries a location and a small window; `read_conversation_at` pages outward
 * from that location. The point is that pulling more is a *choice* the agent
 * makes after seeing a hit, instead of the search guessing how much transcript
 * it should have loaded.
 *
 * Not a replacement for the memory tools, and the descriptions say so: memory
 * holds what an agent chose to record, this holds what was actually said.
 */

const asWireMessage = (m: TranscriptMessage) => ({
  messageId: m.messageId,
  sender: m.sender,
  senderType: m.senderType,
  content: m.content,
  timestamp: new Date(m.timestamp).toISOString(),
});

/**
 * Summary calls allowed per turn.
 *
 * The cache stops an agent re-summarising the same excerpt, but not one that
 * loops with a slightly different `focus` each time — every variation is a
 * legitimate cache miss and a real model call. This is the backstop for that:
 * the toolset is rebuilt per turn, so the counter resets naturally and a
 * runaway costs a handful of calls rather than an open-ended number.
 *
 * Hitting it is not an error. The tool falls back to returning the transcript,
 * which is what the agent asked to read in the first place.
 */
const MAX_SUMMARIES_PER_TURN = 5;

export function createTranscriptTools(callingAgentId: string) {
  let summariesThisTurn = 0;

  return {
    search_conversations: tool({
      description:
        'Search what was actually said in past conversations you took part in (search_memories finds only notes you stored). Matches by word, not meaning. Each hit carries a messageId to read or summarize around. Call get_tool_info("search_conversations") for scope and query tips.',
      inputSchema: z.object({
        query: z.string().describe('Distinctive words that would literally appear in the conversation.'),
        limit: z.number().optional().describe('Max hits (default 10, max 50).'),
        contextBefore: z.number().optional().describe('Messages before each hit (default 2, max 20).'),
        contextAfter: z.number().optional().describe('Messages after each hit (default 2, max 20).'),
        channelId: z.string().optional().describe('Restrict to one conversation.'),
      }),
      execute: async ({ query, limit, contextBefore, contextAfter, channelId }) => {
        const hits = getTranscriptSearchRepository().search(callingAgentId, query, {
          limit, contextBefore, contextAfter, channelId,
        });

        if (hits.length === 0) {
          return {
            success: true,
            hitCount: 0,
            hits: [],
            note: 'No matches. Matching is by word, so try distinctive terms that would literally appear in the conversation, or list_my_conversations to see what is searchable.',
          };
        }

        return {
          success: true,
          hitCount: hits.length,
          hits: hits.map(h => ({
            messageId: h.messageId,
            channelId: h.channelId,
            channelName: h.channelName,
            conversationType: h.channelType,
            sender: h.sender,
            timestamp: new Date(h.timestamp).toISOString(),
            content: h.content,
            before: h.before.map(asWireMessage),
            after: h.after.map(asWireMessage),
          })),
        };
      },
    }),

    read_conversation_at: tool({
      description:
        'Read a past conversation around a messageId from search_conversations, when the surrounding messages in the hit were not enough.',
      inputSchema: z.object({
        messageId: z.string().describe('A messageId from search_conversations.'),
        before: z.number().optional().describe('Messages before it (default 10, max 100).'),
        after: z.number().optional().describe('Messages after it (default 10, max 100).'),
      }),
      execute: async ({ messageId, before, after }) => {
        const page = getTranscriptSearchRepository().readAround(callingAgentId, messageId, { before, after });

        // One answer for "no such message" and "not your conversation" — see
        // the repository note; a distinguishable error is a probing oracle.
        if (!page) {
          return { success: false, error: 'No such message in any conversation you participate in' };
        }

        return {
          success: true,
          channelId: page.channelId,
          channelName: page.channelName,
          target: page.target,
          messageCount: page.messages.length,
          messages: page.messages.map(asWireMessage),
        };
      },
    }),

    summarize_conversation_at: deferTool(tool({
      description:
        'Condense a long stretch of a past conversation instead of reading it verbatim. Declines and returns the raw messages when summarizing would not pay for itself. Call get_tool_info("summarize_conversation_at") before first use.',
      inputSchema: z.object({
        messageId: z.string().describe('A messageId from search_conversations.'),
        before: z.number().optional().describe('Messages before it (default 25, max 100).'),
        after: z.number().optional().describe('Messages after it (default 25, max 100).'),
        focus: z.string().optional().describe('What you want to find out; steers what is kept.'),
      }),
      execute: async ({ messageId, before, after, focus }) => {
        const page = getTranscriptSearchRepository().readAround(callingAgentId, messageId, {
          before: before ?? 25,
          after: after ?? 25,
        });
        if (!page) {
          return { success: false, error: 'No such message in any conversation you participate in' };
        }

        const outcome = summariesThisTurn >= MAX_SUMMARIES_PER_TURN
          ? {
            status: 'declined' as const,
            reason: `Already summarized ${MAX_SUMMARIES_PER_TURN} times this turn — returning the transcript instead. Read it directly, or narrow your search rather than summarizing again.`,
          }
          : await summarizeTranscript({
            channelName: page.channelName,
            messages: page.messages,
            focus,
          });

        if (outcome.status === 'summarized') summariesThisTurn += 1;

        // Both non-summary outcomes hand back the transcript rather than an
        // error. The agent asked to read a stretch of conversation; declining
        // to spend a model call is not a reason to answer with nothing.
        if (outcome.status !== 'summarized') {
          return {
            success: true,
            summarized: false,
            reason: outcome.reason,
            channelId: page.channelId,
            channelName: page.channelName,
            target: page.target,
            messageCount: page.messages.length,
            messages: page.messages.map(asWireMessage),
          };
        }

        return {
          success: true,
          summarized: true,
          channelId: page.channelId,
          channelName: page.channelName,
          target: page.target,
          messageCount: outcome.messageCount,
          summary: outcome.summary,
          note: 'Condensed account, not a transcript. Use read_conversation_at on the same messageId for exact wording.',
        };
      },
    })),

    list_my_conversations: tool({
      description:
        'List the conversations you participate in, busiest first, with message counts. Shows what search_conversations can reach.',
      inputSchema: z.object({}),
      execute: async () => {
        const channels = getTranscriptSearchRepository().participatingChannels(callingAgentId);
        return {
          success: true,
          conversationCount: channels.length,
          conversations: channels.map(c => ({
            channelId: c.id,
            name: c.name,
            type: c.type,
            messageCount: c.messageCount,
          })),
        };
      },
    }),
  };
}
