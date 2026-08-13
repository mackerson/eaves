import { BrowserWindow } from 'electron';
import { eventBus, AppEvent } from './EventBus';
import { getActivityRepository } from '../repositories';
import { logger } from './logger';

/**
 * Category mapping from event type prefixes
 */
const CATEGORY_MAP: Record<string, string> = {
  'agent:': 'agent',
  'project:': 'project',
  'channel:': 'channel',
  'chat:': 'chat',
  'message:': 'message',
  'task:': 'task',
  'note:': 'note',
  'workflow:': 'workflow',
  'routine:': 'routine',
  'tool:': 'tool',
  'code-execution:': 'execution',
  'plugin:': 'plugin',
  'messaging:': 'messaging',
  'app:': 'system',
  'view:': 'ui',
  'mcp-code-api:': 'mcp',
  'service:': 'service',
};

/**
 * Derive category from event type
 */
function deriveCategory(type: string): string {
  for (const [prefix, category] of Object.entries(CATEGORY_MAP)) {
    if (type.startsWith(prefix)) return category;
  }
  return 'other';
}

type ActivityAudience = 'user' | 'system';

/**
 * Audience map: 'user' events are workspace activity shown in the feed and
 * counted by the sidebar badge; 'system' events are lifecycle telemetry
 * (loads, registrations, per-step chatter) hidden behind a toggle.
 * Exact-type overrides win over prefix rules; anything unmatched fails
 * closed to 'system' so new emitters never leak into the default feed.
 * Keep the backfill in migrations.ts (addActivityAudienceColumn) in sync.
 */
const AUDIENCE_EXACT: Record<string, ActivityAudience> = {
  // Cost telemetry, one row per inference. The 'agent:' prefix below would
  // make it 'user' and quietly double the default feed; surfacing spend is a
  // deliberate view decision, not a side effect of recording it.
  'agent:spend': 'system',
  'chat:error': 'user',
  'plugin:crash': 'user',
  'plugin:error': 'user',
  'plugin:resource-violation': 'user',
  'project:switched': 'system',
  'channel:switched': 'system',
  'workflow:node:executing': 'system',
  'workflow:node:completed': 'system',
  'workflow:node:error': 'system',
  'routine:scheduler:started': 'system',
  'routine:scheduler:stopped': 'system',
  // A bridge that broke, or a stranger knocking on it, is the user's business.
  // Routine start/stop is not, and stays behind the system toggle (no
  // 'messaging:' prefix rule, so anything new here fails closed to 'system').
  'messaging:bridge:error': 'user',
  'messaging:auth:rejected': 'user',
};

const AUDIENCE_PREFIX: Record<string, ActivityAudience> = {
  'agent:': 'user',
  'project:': 'user',
  'channel:': 'user',
  'message:': 'user',
  'task:': 'user',
  'note:': 'user',
  'workflow:': 'user',
  'routine:': 'user',
  'approval:': 'user',
};

/**
 * Which agent caused this event, if a single one did.
 *
 * Event payloads name the agent under different keys depending on who emitted
 * them, and some name no agent at all — a routine owns a schedule, a workflow
 * run spans however many agent nodes it has. Returning null for those is the
 * honest answer; see the addActivityAgentColumn migration.
 */
function deriveAgentId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  if (typeof d.agentId === 'string' && d.agentId) return d.agentId;
  // Message events carry the author under senderId, but humans send messages
  // too — only attribute when the sender actually is an agent.
  if (d.senderType === 'agent' && typeof d.senderId === 'string' && d.senderId) return d.senderId;

  return null;
}

function deriveAudience(type: string): ActivityAudience {
  const exact = AUDIENCE_EXACT[type];
  if (exact) return exact;
  for (const [prefix, audience] of Object.entries(AUDIENCE_PREFIX)) {
    if (type.startsWith(prefix)) return audience;
  }
  return 'system';
}

/**
 * Ephemeral, high-cardinality events that must never be persisted as durable
 * activity rows. `chat:stream` fires once per streamed token (49k rows / 91% of
 * the activities table in one beta DB) and has no read path — the renderer's
 * live-typing UI is fed by a separate 'chat-stream' webContents channel, not
 * the activity feed. Persisting these is pure disk bloat.
 */
const PERSIST_DENYLIST = new Set<string>(['chat:stream']);

/**
 * Cap on a single activity's serialized `data`. Activity rows are display-only
 * telemetry (the feed), never a source of truth, so an oversized payload is
 * replaced with a small marker rather than stored verbatim — bounding row size
 * without breaking JSON parsing downstream.
 */
const MAX_ACTIVITY_DATA_BYTES = 32_768;

/**
 * Retention window for the activity feed. Older rows are pruned on startup and
 * daily thereafter so the table can't grow without bound — the user-triggered
 * `clearBefore` path is opt-in and can't be relied on for that.
 */
const ACTIVITY_RETENTION_DAYS = 30;

/**
 * Safely serialize event data for storage
 */
function serializeEventData(data: unknown): string | null {
  if (data === undefined || data === null) return null;

  try {
    const json = JSON.stringify(data, (_key, value) => {
      // Handle Error objects
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      // Strip functions
      if (typeof value === 'function') {
        return undefined;
      }
      return value;
    });
    if (json && json.length > MAX_ACTIVITY_DATA_BYTES) {
      return JSON.stringify({ _truncated: true, bytes: json.length });
    }
    return json;
  } catch (error) {
    logger.warn('[ActivityPersistence] Failed to serialize event data', { error });
    return null;
  }
}

/**
 * Service that persists EventBus events to the database
 * and pushes new activities to the renderer for real-time updates
 */
export class ActivityPersistenceService {
  private getMainWindow: () => BrowserWindow | null;
  private cleanup: (() => void) | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
  }

  /**
   * Start listening to all events and persisting them
   */
  start(): void {
    if (this.cleanup) {
      logger.warn('[ActivityPersistence] Service already started');
      return;
    }

    logger.info('[ActivityPersistence] Starting activity persistence service');

    this.cleanup = eventBus.onAllEvents((event) => {
      this.persistEvent(event);
    });

    // Enforce retention on startup, then once a day.
    this.pruneOldActivities();
    this.pruneTimer = setInterval(() => this.pruneOldActivities(), 24 * 60 * 60 * 1000);
    this.pruneTimer.unref?.();
  }

  /**
   * Stop listening to events
   */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.cleanup) {
      this.cleanup();
      this.cleanup = null;
      logger.info('[ActivityPersistence] Stopped activity persistence service');
    }
  }

  /**
   * Delete activity rows older than the retention window.
   */
  private pruneOldActivities(): void {
    try {
      const cutoff = Date.now() - ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const deleted = getActivityRepository().clearBefore(cutoff);
      if (deleted > 0) {
        logger.info(
          `[ActivityPersistence] Pruned ${deleted} activities older than ${ACTIVITY_RETENTION_DAYS} days`
        );
      }
    } catch (error) {
      logger.warn('[ActivityPersistence] Failed to prune old activities', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist an event to the database and notify renderer
   */
  private persistEvent(event: AppEvent): void {
    // Ephemeral streaming chatter is never durable — skip before any DB work.
    if (PERSIST_DENYLIST.has(event.type)) return;

    try {
      const repo = getActivityRepository();

      // Extract projectId from event data if present
      const projectId = (event.data as any)?.projectId || null;

      const activity = repo.create({
        type: event.type,
        category: deriveCategory(event.type),
        source: event.source || 'core',
        audience: deriveAudience(event.type),
        data: serializeEventData(event.data),
        projectId,
        agentId: deriveAgentId(event.data),
        timestamp: event.timestamp,
      });

      // Push to renderer for real-time updates
      const window = this.getMainWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send('activity:new', {
          id: activity.id,
          type: activity.type,
          category: activity.category,
          source: activity.source,
          audience: activity.audience,
          data: activity.data,
          projectId: activity.projectId,
          agentId: activity.agentId,
          timestamp: activity.timestamp,
          createdAt: activity.createdAt,
        });
      }
    } catch (error) {
      // Don't let persistence errors break the event flow
      logger.error('[ActivityPersistence] Failed to persist event', {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
