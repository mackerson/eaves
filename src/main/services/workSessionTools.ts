import { tool } from 'ai';
import { z } from 'zod/v3';
import type { BrowserWindow } from 'electron';
import { completeWorkSession, getWorkSession } from './WorkSessionService';

/**
 * The one tool a work session needs: a way to say "I'm finished".
 *
 * Completion is explicit because it cannot be inferred. A session is
 * multi-turn by design, so a turn that ends without a tool call is an agent
 * thinking, not an agent done. Only the agent knows which.
 *
 * Registered solely inside work sessions — offering it in an ordinary chat
 * would be a tool that can only fail.
 */
export function createWorkSessionTools(sessionId: string, getMainWindow: () => BrowserWindow | null) {
  return {
    complete_work_session: tool({
      description:
        'Finish this work session and report back to the channel that asked for it. ' +
        'Call this once, when the task is genuinely done or you have concluded it cannot be. ' +
        'The summary is the only thing the channel sees, so state what you did, what you found, ' +
        'and anything left outstanding.',
      inputSchema: z.object({
        summary: z.string().min(1).max(4000).describe(
          'What you did and what you found. Written for someone who did not watch the work.',
        ),
      }),
      execute: async ({ summary }) => {
        const session = getWorkSession(sessionId);
        if (!session) return { success: false, error: 'Work session not found' };

        const result = completeWorkSession(sessionId, summary, getMainWindow());
        return result.success
          ? {
              success: true,
              reportedTo: result.reportedTo ?? null,
              note: result.reportedTo
                ? 'Summary posted to the originating channel.'
                : 'Session was started standalone, so there was nowhere to report — the summary stays here.',
            }
          : result;
      },
    }),
  };
}
