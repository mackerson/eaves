/**
 * Work sessions — one agent, one task, its own transcript.
 *
 * Why these exist: a channel replays its whole history into every participant on
 * every turn, so an agent doing a long task in one charges every other agent
 * rent for its scratch work, permanently. A session is a separate container
 * for that work.
 *
 * This module owns creating and finding sessions. Running turns inside one is
 * the ordinary chat path — a session is a `channels` row, so the turn core
 * reaches it through `getConversationById` and needs nothing session-specific.
 *
 * Report-back (phase 2) posts three things to the channel a session came from:
 * that it started, that it finished, and — the one that is easy to forget —
 * that it is stuck waiting on an approval. Isolation makes that last case
 * worse, not better: a session nobody has open can sit on a pending approval
 * indefinitely with no sign of it anywhere the user is looking.
 *
 * Not built: a `delegate_task` tool so one agent can open a session for
 * another, and a UI surface for sessions.
 */

import type { BrowserWindow } from 'electron';
import { logger } from './logger';
import {
  getChannelRepository,
  getProjectRepository,
  getAgentRepository,
  getUserRepository,
} from '../repositories';
import type { Chat, Message } from '../types';

/** Session names are for humans scanning a list, so keep them short. */
const NAME_MAX = 60;

export interface StartWorkSessionOptions {
  taskId: string;
  agentId: string;
  /** Channel the delegation came from, when there was one. */
  parentChannelId?: string;
  /** For the report-back push; omitted in tests and headless callers. */
  getMainWindow?: () => BrowserWindow | null;
}

export interface StartWorkSessionResult {
  success: boolean;
  session?: Chat;
  error?: string;
}

/**
 * Open a session for a task and seed it with the assignment.
 *
 * The seed is the whole point: a session starts from the task text and a note
 * of where it came from — never the originating channel's history. Copying
 * that history in would reproduce the problem sessions exist to solve.
 */
export async function startWorkSession(opts: StartWorkSessionOptions): Promise<StartWorkSessionResult> {
  const { taskId, agentId, parentChannelId } = opts;

  const task = getProjectRepository().getTaskById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  const agent = getAgentRepository().getById(agentId);
  if (!agent) return { success: false, error: 'Agent not found' };

  const channelRepo = getChannelRepository();
  if (parentChannelId && !channelRepo.getById(parentChannelId)) {
    return { success: false, error: 'Parent channel not found' };
  }

  const currentUser = getUserRepository().getCurrent();
  const now = Date.now();

  const session = channelRepo.createWorkSession(
    {
      name: sessionName(task.content),
      agentId,
      taskId,
      projectId: task.projectId,
      parentChannelId,
    },
    [
      ...(currentUser
        ? [{
            id: currentUser.id,
            type: 'human' as const,
            displayName: currentUser.name,
            color: currentUser.color,
            joinedAt: now,
          }]
        : []),
      {
        id: agent.id,
        type: 'agent' as const,
        displayName: agent.name,
        color: agent.color,
        joinedAt: now,
      },
    ],
  );

  // Seeded as a message from the delegator rather than a system preamble: the
  // agent needs a turn to answer, and the transcript should read as what it
  // is — someone handing over a task.
  channelRepo.createDirectMessage({
    chatId: session.id,
    senderId: currentUser?.id ?? 'system',
    senderType: 'human',
    senderDisplayName: currentUser?.name ?? 'Eaves',
    senderColor: currentUser?.color,
    content: seedMessage(task.content, parentChannelId),
    contentBlocks: [{ type: 'text', content: seedMessage(task.content, parentChannelId), timestamp: now }],
    metadata: { workSession: { taskId, seeded: true } },
    timestamp: now,
  });

  const loaded = channelRepo.getConversationById(session.id) ?? session;
  if (parentChannelId) {
    reportSessionStarted(loaded, opts.getMainWindow?.() ?? null);
  }

  logger.info('[WorkSession] started', {
    sessionId: session.id, taskId, agentId, parentChannelId: parentChannelId ?? null,
  });

  return { success: true, session: loaded };
}

/**
 * Post to the channel a session came from. No-ops for a session started
 * straight from the task list, which has nowhere to report.
 *
 * Under ADR-001 this is a chain root, like `channel_send_message`: the report
 * is not a reply to anything, and mentions inside it are free to dispatch.
 * Deliberately does NOT request a dispatch itself — a status line should not
 * wake the room up.
 */
function postToParent(
  session: Chat & { parentChannelId?: string | null },
  content: string,
  mainWindow: BrowserWindow | null,
): Message | null {
  const parentChannelId = sessionParentId(session.id);
  if (!parentChannelId) return null;

  const agent = getAgentRepository().getById(session.agentId ?? '');
  const message = getChannelRepository().createMessage({
    channelId: parentChannelId,
    senderId: session.agentId ?? 'system',
    senderType: 'agent',
    senderDisplayName: agent?.name ?? 'Work session',
    senderColor: agent?.color,
    content,
    contentBlocks: [{ type: 'text', content, timestamp: Date.now() }],
    metadata: { workSession: { sessionId: session.id } },
    timestamp: Date.now(),
  });

  mainWindow?.webContents.send('channel-message-added', { channelId: parentChannelId, message });
  return message;
}

/** The parent channel id for a session, read straight from the row. */
function sessionParentId(sessionId: string): string | null {
  return getChannelRepository().getWorkSessionParentId(sessionId);
}

/**
 * Announce that a session opened. One line, with the name so the channel can
 * tell which task went where.
 */
export function reportSessionStarted(session: Chat, mainWindow: BrowserWindow | null): void {
  postToParent(session, `Started a work session for **${session.name}**. I'll report back here when it's done.`, mainWindow);
}

/**
 * Announce that a session is waiting on an approval. This is the report that
 * earns isolation its keep — without it, a session nobody is watching stalls
 * silently and the work looks abandoned.
 */
export function reportSessionBlocked(
  sessionId: string,
  toolNames: string[],
  mainWindow: BrowserWindow | null,
): void {
  const session = getWorkSession(sessionId);
  if (!session) return;
  const tools = toolNames.length > 0 ? ` (${[...new Set(toolNames)].join(', ')})` : '';
  postToParent(
    session,
    `Waiting on approval in **${session.name}**${tools}. Open the session to approve or deny — nothing runs until then.`,
    mainWindow,
  );
}

/**
 * Finish a session: post the summary to the channel that asked for it.
 *
 * The agent decides when this happens by calling `complete_work_session`.
 * Inferring completion from a turn ending would be wrong — a session is
 * multi-turn by design, and a quiet turn is not a finished task.
 */
export function completeWorkSession(
  sessionId: string,
  summary: string,
  mainWindow: BrowserWindow | null,
): { success: boolean; reportedTo?: string; error?: string } {
  const session = getWorkSession(sessionId);
  if (!session) return { success: false, error: 'Work session not found' };

  const parentChannelId = sessionParentId(sessionId);
  postToParent(session, `**${session.name}** — done.\n\n${summary}`, mainWindow);
  logger.info('[WorkSession] completed', { sessionId, reportedTo: parentChannelId ?? null });

  return { success: true, reportedTo: parentChannelId ?? undefined };
}

export function getWorkSession(sessionId: string): Chat | null {
  const session = getChannelRepository().getConversationById(sessionId);
  return session ?? null;
}

export function listWorkSessionsForTask(taskId: string): Chat[] {
  return getChannelRepository().getWorkSessionsByTaskId(taskId);
}

function sessionName(taskContent: string): string {
  const firstLine = taskContent.split('\n')[0].trim();
  return firstLine.length > NAME_MAX ? `${firstLine.slice(0, NAME_MAX - 1)}…` : firstLine || 'Work session';
}

/**
 * The assignment as the agent first sees it. States the boundary explicitly —
 * an agent that does not know it is in a session will narrate as if the room
 * is watching, which is exactly the habit sessions are meant to break.
 */
function seedMessage(taskContent: string, parentChannelId?: string): string {
  const origin = parentChannelId
    ? 'This was delegated from a channel conversation.'
    : 'This was started directly from the task list.';
  return [
    `Please take on this task:`,
    ``,
    taskContent,
    ``,
    `${origin} You are in a work session — a private thread for this one task. ` +
    `Work here as long as you need; nobody else is reading along, so there's no need to ` +
    `narrate for an audience. When you're done, summarise what you did and what you found.`,
  ].join('\n');
}
