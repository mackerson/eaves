import { Agent, AppState } from '../types';
import { AppEvent, getEventBus } from './EventBus';
import { streamAIResponse, AIMessage } from './ai';
import { getAgentRepository, getSettingsRepository } from '../repositories';
import { getLogger } from './logger';
import { summarizeProviderError } from '../utils/aiErrors';
import { MEMORY_EXTRACTOR_PROMPT } from '../../shared/shadowDefaults';
import { parseDreamOutput, consolidateDream } from './shadowConsolidate';
import { createStreamMetrics, emitAgentSpend, trackUsage } from './streamEventRouter';

const logger = getLogger();

const FLUSH_EVENT_THRESHOLD = 20;
const FLUSH_TIME_THRESHOLD_MS = 90_000; // 90 seconds
const DIGEST_MAX_CHARS = 4000;

// Event types every shadow cares about. There is no per-shadow scope config:
// this one set is what every running shadow observes.
const RELEVANT_EVENT_TYPES = new Set([
  'message:created',
  'chat:complete',
  'tool:call',
  'tool:result',
]);

/**
 * One running shadow. Buffers events until a flush threshold trips, then
 * hands the digest to the shadow agent itself for processing.
 *
 * Shadows come in two flavors:
 *  - **Lead-scoped**: `leadAgentId` is set; only events tied to that agent
 *    flow through (memories are stored against the lead).
 *  - **System-wide**: `leadAgentId` is undefined; *all* relevant events flow
 *    through (memories are stored against the shadow itself, since there's
 *    no other agent to attribute observations to).
 */
class ShadowAgentInstance {
  private buffer: AppEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private shadowAgent: Agent,
    private leadAgentId: string | undefined,
  ) {
    this.scheduleFlush();
  }

  /**
   * Whether this shadow wants to process the given event. Lead-scoped shadows
   * filter to events whose `agentId`/`senderId` matches their lead; system-wide
   * shadows take everything in the relevant-types set.
   */
  shouldReceive(event: AppEvent): boolean {
    if (!RELEVANT_EVENT_TYPES.has(event.type)) return false;
    if (!this.leadAgentId) return true;
    const data = event.data as Record<string, unknown> | undefined;
    const agentId = (data?.agentId || data?.senderId) as string | undefined;
    return agentId === this.leadAgentId;
  }

  pushEvent(event: AppEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= FLUSH_EVENT_THRESHOLD && !this.flushing) {
      this.flush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (this.buffer.length > 0 && !this.flushing) {
        this.flush();
      } else {
        this.scheduleFlush();
      }
    }, FLUSH_TIME_THRESHOLD_MS);
  }

  private formatDigest(): string {
    let digest = '';
    for (const event of this.buffer) {
      const data = event.data as Record<string, unknown> | undefined;
      let line = '';

      switch (event.type) {
        case 'message:created': {
          const sender = data?.senderDisplayName || data?.senderType || 'unknown';
          const content = String(data?.content || '').slice(0, 300);
          line = `[${sender}]: ${content}`;
          break;
        }
        case 'chat:complete': {
          const tokens = (data?.metrics as Record<string, unknown>)?.totalTokens || '?';
          line = `[stream complete] tokens: ${tokens}`;
          break;
        }
        case 'tool:call': {
          line = `[tool call] ${data?.toolName}(${JSON.stringify(data?.args || {}).slice(0, 100)})`;
          break;
        }
        case 'tool:result': {
          const result = String(data?.result || '').slice(0, 150);
          line = `[tool result] ${data?.toolName}: ${result}`;
          break;
        }
        default:
          line = `[${event.type}]`;
      }

      if (digest.length + line.length + 1 > DIGEST_MAX_CHARS) break;
      digest += line + '\n';
    }
    return digest.trim();
  }

  private buildMinimalAppState(): AppState {
    const settingsRepo = getSettingsRepository();
    const settings = settingsRepo.get();
    return {
      settings,
      users: [],
      agents: [],
      projects: [],
      channels: [],
      currentProjectId: null,
      currentAgentId: null,
      currentChannelId: null,
      currentUserId: null,
    };
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;
    this.flushing = true;

    const digest = this.formatDigest();
    this.buffer = [];
    this.scheduleFlush();

    if (!digest) {
      this.flushing = false;
      return;
    }

    // Use the shadow agent's own systemPrompt when set — that's how users
    // customize what a shadow does. Empty/whitespace falls back to the memory
    // extractor template so untouched shadows keep working as before.
    const systemPrompt = this.shadowAgent.systemPrompt?.trim()
      || MEMORY_EXTRACTOR_PROMPT;

    const scopeLabel = this.leadAgentId ? `lead:${this.leadAgentId}` : 'system';
    logger.info(`[Shadow] Flushing digest via "${this.shadowAgent.name}" (${scopeLabel}, ${digest.length} chars)`);

    try {
      const memory = this.buildMinimalAppState();
      const messages: AIMessage[] = [
        { role: 'user', content: `CONVERSATION SEGMENT:\n${digest}` },
      ];

      let fullResponse = '';
      // A shadow flush is a real billed inference that no human asked for and
      // no conversation shows. Unmetered, it was the single most invisible
      // spend in the app: it fires on a timer, against whatever model the
      // shadow agent is configured with, for as long as the app is open.
      const metrics = createStreamMetrics();
      const startedAt = Date.now();
      for await (const event of streamAIResponse(
        this.shadowAgent, memory, messages, systemPrompt,
        undefined, undefined, undefined, undefined,
        { nonInteractive: true, contextLabel: `shadow:${scopeLabel}` },
      )) {
        if (typeof event === 'string') {
          fullResponse += event;
        }
        trackUsage(event, metrics);
      }
      metrics.timeToComplete = Date.now() - startedAt;
      metrics.model = this.shadowAgent.model;
      metrics.provider = this.shadowAgent.provider;
      emitAgentSpend(this.shadowAgent, metrics, { kind: 'shadow' });

      // "Dreaming": consolidate the segment into the target agent's memory —
      // the current_focus core block + durable archival facts. Shadows that
      // emit no dream JSON simply skip this (their action is via tools).
      const dream = parseDreamOutput(fullResponse);
      if (dream) {
        const targetAgentId = this.leadAgentId ?? this.shadowAgent.id;
        const { focusUpdated, factsStored } = await consolidateDream(targetAgentId, dream);
        if (focusUpdated || factsStored) {
          logger.info(`[Shadow] Dreamed for ${scopeLabel}: focus ${focusUpdated ? 'updated' : '—'}, ${factsStored} fact(s) stored`);
        }
      }
    } catch (error) {
      // Summarized: this try wraps an AI stream, and the SDK's error carries
      // the whole request (see summarizeProviderError).
      logger.error(`[Shadow] Flush failed for ${scopeLabel}`, summarizeProviderError(error));
      // Don't retry — next flush will have fresh context
    } finally {
      this.flushing = false;
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
  }
}

/**
 * Manages all shadow agent instances.
 *
 * Shadows are real agents with `archetype.type === 'shadow'`. A shadow may
 * optionally specify `archetype.leadAgentId` to scope itself to one agent's
 * events, or omit it to receive every relevant event in the app.
 *
 * Each shadow gets its own `ShadowAgentInstance`, keyed by the shadow's *own*
 * id (not its lead's) so multiple shadows can monitor the same lead, and so
 * lead-less shadows have somewhere to live.
 */
export class ShadowService {
  // Map from shadow agent id → instance. Keying by shadowId (not leadId) lets
  // us run multiple shadows against the same lead and also gives lead-less
  // (system-wide) shadows a stable key.
  private instances = new Map<string, ShadowAgentInstance>();
  private eventCleanup: (() => void) | null = null;

  start(): void {
    const eventBus = getEventBus();
    const agentRepo = getAgentRepository();

    // Discover every shadow agent — leadAgentId is optional now (lead-less
    // shadows watch all relevant events system-wide).
    for (const agent of agentRepo.getAll()) {
      if (agent.archetype?.type !== 'shadow') continue;
      this.registerShadow(agent);
    }

    // Single subscription; each instance decides whether to take the event.
    // Per-event cost is O(shadows) — fine for the tens-of-shadows range.
    this.eventCleanup = eventBus.onAllEvents((event: AppEvent) => {
      for (const instance of this.instances.values()) {
        if (instance.shouldReceive(event)) instance.pushEvent(event);
      }
    });

    eventBus.onEvent('agent:created', (event) => this.handleAgentChange(event));
    eventBus.onEvent('agent:updated', (event) => this.handleAgentChange(event));
    eventBus.onEvent('agent:deleted', (event) => {
      const data = event.data as { id: string } | undefined;
      if (!data?.id) return;
      const existing = this.instances.get(data.id);
      if (existing) {
        existing.destroy();
        this.instances.delete(data.id);
        logger.info(`[Shadow] Removed shadow ${data.id} (agent deleted)`);
      }
    });

    logger.info(`[Shadow] Service started with ${this.instances.size} active shadow(s)`);
  }

  private registerShadow(agent: Agent): void {
    const leadId = agent.archetype?.leadAgentId;
    const existing = this.instances.get(agent.id);
    if (existing) existing.destroy();
    this.instances.set(agent.id, new ShadowAgentInstance(agent, leadId));
    const scope = leadId ? `lead ${leadId}` : 'all conversations';
    logger.info(`[Shadow] ${existing ? 'Reconfigured' : 'Started'} shadow "${agent.name}" watching ${scope}`);
  }

  private handleAgentChange(event: AppEvent): void {
    const data = event.data as { id: string } | undefined;
    if (!data?.id) return;

    const agentRepo = getAgentRepository();
    const agent = agentRepo.getById(data.id);
    if (!agent) return;

    if (agent.archetype?.type === 'shadow') {
      this.registerShadow(agent);
    } else {
      // Agent used to be a shadow and got re-typed — tear down any running
      // instance so we don't keep flushing for an agent that's no longer one.
      const existing = this.instances.get(agent.id);
      if (existing) {
        existing.destroy();
        this.instances.delete(agent.id);
        logger.info(`[Shadow] Stopped shadow "${agent.name}" (archetype changed)`);
      }
    }
  }

  stop(): void {
    for (const [shadowId, instance] of this.instances) {
      instance.destroy();
      logger.info(`[Shadow] Stopped shadow ${shadowId}`);
    }
    this.instances.clear();

    if (this.eventCleanup) {
      this.eventCleanup();
      this.eventCleanup = null;
    }

    logger.info('[Shadow] Service stopped');
  }
}

// Lazy singleton
let shadowServiceInstance: ShadowService | null = null;

export function getShadowService(): ShadowService {
  if (!shadowServiceInstance) {
    shadowServiceInstance = new ShadowService();
  }
  return shadowServiceInstance;
}
