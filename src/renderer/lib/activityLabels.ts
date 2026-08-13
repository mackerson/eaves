import type { Activity } from '@/types';

/**
 * How an activity row is described in the UI.
 *
 * There used to be two of these — one in ActivitySection, one in ActivityView —
 * which had drifted apart in both coverage and wording. Worse, both described
 * only the *kind* of event and dropped the subject, even though the subject is
 * sitting in the row: `routine:execution:started` carries `routineName`, and
 * the feed still read "Routine started". Fifteen rows of "started / completed"
 * name nothing you can act on.
 *
 * So a row is described in two parts: what happened (`label`) and what it
 * happened to (`subject`). Callers render them however their surface allows —
 * the sidebar has room for one line, the full view for both.
 */

const EVENT_LABELS: Record<string, string> = {
  'agent:created': 'Agent created',
  'agent:updated': 'Agent updated',
  'agent:deleted': 'Agent deleted',
  'project:created': 'Project created',
  'project:updated': 'Project updated',
  'project:deleted': 'Project deleted',
  'project:switched': 'Project switched',
  'channel:created': 'Channel created',
  'channel:updated': 'Channel updated',
  'channel:deleted': 'Channel deleted',
  'channel:switched': 'Channel switched',
  'message:created': 'Message sent',
  'message:updated': 'Message updated',
  'message:deleted': 'Message deleted',
  'chat:start': 'Chat started',
  'chat:complete': 'Chat completed',
  'chat:aborted': 'Chat cancelled',
  'chat:error': 'Chat error',
  'chat:stream': 'Chat streaming',
  'tool:call': 'Tool called',
  'tool:result': 'Tool completed',
  'tool:error': 'Tool error',
  'tool:denied': 'Tool denied',
  'task:created': 'Task created',
  'task:toggled': 'Task toggled',
  'task:deleted': 'Task deleted',
  'note:created': 'Note created',
  'note:deleted': 'Note deleted',
  'plugin:loaded': 'Plugin loaded',
  'plugin:unloaded': 'Plugin unloaded',
  'plugin:error': 'Plugin error',
  'plugin:crash': 'Plugin crashed',
  'app:ready': 'App started',
  'app:shutdown': 'App shutdown',
  'routine:execution:started': 'Routine started',
  'routine:execution:completed': 'Routine finished',
  'routine:execution:failed': 'Routine failed',
  'routine:scheduler:started': 'Scheduler started',
  'routine:scheduler:stopped': 'Scheduler stopped',
  'routine:scheduler:paused': 'Scheduler paused',
  'routine:scheduler:resumed': 'Scheduler resumed',
  'workflow:created': 'Workflow created',
  'workflow:execution:started': 'Workflow started',
  'workflow:execution:completed': 'Workflow finished',
  'workflow:execution:failed': 'Workflow failed',
  'workflow:blocked:pending-review': 'Workflow needs review',
  'workflow:node:executing': 'Step running',
  'workflow:node:completed': 'Step finished',
  'workflow:node:error': 'Step failed',
  'approval:requested': 'Approval requested',
  'approval:resolved': 'Approval resolved',
  'code-execution:start': 'Code running',
  'code-execution:complete': 'Code finished',
  'code-execution:error': 'Code failed',
  'code-execution:cancelled': 'Code cancelled',
  'messaging:bridge:error': 'Bridge error',
  'messaging:auth:rejected': 'Bridge auth rejected',
};

/**
 * Readable fallback for types with no entry above.
 *
 * The namespace is the informative half, so `type.split(':').pop()` — the old
 * fallback — was exactly the wrong reduction: `routine:execution:started`
 * became "started". Render the whole type as words instead.
 */
export function humanizeEventType(type: string): string {
  const words = type
    .split(':')
    .flatMap((part) => part.split(/[-_.]/))
    .filter(Boolean);

  if (words.length === 0) return type;

  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Keys that name the thing an event happened to, most specific first. */
const SUBJECT_KEYS = [
  'routineName',
  'workflowName',
  'agentName',
  'channelName',
  'projectName',
  'toolName',
  'pluginId',
  'taskTitle',
  'noteTitle',
  'senderDisplayName',
  'title',
  'name',
];

function readSubject(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  for (const key of SUBJECT_KEYS) {
    const value = d[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export interface ActivityDescription {
  /** What happened — "Routine started". */
  label: string;
  /** What it happened to — "HMD BG Collector". Absent when the row names nothing. */
  subject?: string;
  /** label + subject, for surfaces with one line to spend. */
  text: string;
}

export function describeActivity(activity: Pick<Activity, 'type' | 'data'>): ActivityDescription {
  const label = EVENT_LABELS[activity.type] || humanizeEventType(activity.type);
  const subject = readSubject(activity.data);

  // An agentName subject reads as the actor rather than the object, so it
  // leads: "Ninja — Chat completed", but "Routine started — HMD BG Collector".
  const isActor = subject !== undefined
    && typeof activity.data === 'object'
    && activity.data !== null
    && (activity.data as Record<string, unknown>).agentName === subject;

  const text = subject
    ? (isActor ? `${subject} — ${label}` : `${label} — ${subject}`)
    : label;

  return { label, subject, text };
}
