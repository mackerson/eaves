import { eventBus } from './EventBus';
import { getChannelRepository, getUsageEventRepository } from '../repositories';
import { getPowerSampler } from './PowerSampler';
import { logger } from './logger';
import { isLocalProvider } from '../../shared/pricing';
import { estimateTurnEnergy } from '../../shared/energy';
import type { CostBasis } from '../../shared/types';

/**
 * The durable record of what inference actually cost.
 *
 * A storage-only consumer of `agent:spend`, in the ADR-001 sense: it listens,
 * writes a row, and starts nothing. Nothing downstream of this service can
 * cause a turn.
 *
 * Why this exists separately from the activity feed, which already persists
 * the same event: `activities` is pruned after 30 days, stores its payload as
 * an untyped blob, and is documented as display-only telemetry. All three are
 * fine for a feed and disqualifying for a billing record. The two writers
 * coexist deliberately — the feed keeps its row for the "what happened
 * recently" view, and the ledger keeps its own for the arithmetic.
 */

/** The payload `emitAgentSpend` puts on the bus. */
interface SpendPayload {
  agentId?: string;
  agentName?: string;
  provider?: string;
  model?: string;
  servedProvider?: string;
  kind?: string;
  containerId?: string;
  projectId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  costBasis?: CostBasis;
  usageIsTotal?: boolean;
  durationMs?: number;
}

export class UsageLedgerService {
  private cleanup: (() => void) | null = null;
  /**
   * containerId → projectId, memoised for the process lifetime.
   *
   * A channel's project does not move, and the alternative is a DB lookup on
   * every single inference. Bounded because it only ever holds ids the user
   * actually ran a turn in.
   */
  private projectCache = new Map<string, string | null>();

  start(): void {
    if (this.cleanup) {
      logger.warn('[UsageLedger] Service already started');
      return;
    }
    logger.info('[UsageLedger] Recording inference cost to the usage ledger');
    this.cleanup = eventBus.onEvent('agent:spend', (event) => {
      this.record(event.data as SpendPayload, event.timestamp);
    });
  }

  stop(): void {
    if (this.cleanup) {
      this.cleanup();
      this.cleanup = null;
    }
  }

  /**
   * Resolve which project a turn belongs to.
   *
   * Preferred source is the emitter, which sometimes knows directly (a
   * workflow run, a note). Otherwise the container is a channel and the
   * channel names its project. Resolved at write time and denormalized into
   * the row on purpose: the channel may be deleted later, and the ledger must
   * keep saying which project the money went to.
   */
  private resolveProjectId(payload: SpendPayload): string | null {
    if (payload.projectId) return payload.projectId;
    const containerId = payload.containerId;
    if (!containerId) return null;

    const cached = this.projectCache.get(containerId);
    if (cached !== undefined) return cached;

    let projectId: string | null = null;
    try {
      projectId = getChannelRepository().getById(containerId)?.projectId ?? null;
    } catch (error) {
      logger.warn('[UsageLedger] Could not resolve project for container', {
        containerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.projectCache.set(containerId, projectId);
    return projectId;
  }

  /**
   * Decide the energy figure and, more importantly, what to call it.
   *
   * Measurement is only attempted for local providers, because it is only
   * meaningful for them — RAPL on this machine says nothing about what a
   * datacenter in Iowa burned. Any failure to measure falls back to the
   * estimate rather than to nothing, so the column is never mysteriously
   * empty; it is just honestly labelled.
   */
  private resolveEnergy(payload: SpendPayload, provider: string, model: string, endedAt: number) {
    const input = payload.inputTokens ?? 0;
    const output = payload.outputTokens ?? 0;
    const cached = payload.cachedTokens ?? 0;

    if (isLocalProvider(provider) && payload.durationMs && payload.durationMs > 0) {
      const measured = getPowerSampler().energyBetween(endedAt - payload.durationMs, endedAt);
      if (measured) {
        // A measurement is a single number, not a range — the range fields
        // collapse onto it rather than being invented around it.
        return {
          energyWh: measured.wh,
          energyLowWh: measured.wh,
          energyHighWh: measured.wh,
          energyBasis: 'measured' as const,
        };
      }
    }

    const estimate = estimateTurnEnergy(provider, model, input, output, cached);
    return {
      energyWh: estimate.wh,
      energyLowWh: estimate.whLow,
      energyHighWh: estimate.whHigh,
      energyBasis: 'estimated' as const,
    };
  }

  /**
   * Classify where the cost number came from.
   *
   * The 'unknown' case is the one that matters. An unpriced cloud model must
   * store NULL, not 0 — a zero would be summed into totals as though the turn
   * were free, quietly understating every unpriced model in the workspace.
   */
  private resolveCost(payload: SpendPayload, provider: string): { costUsd: number | null; costBasis: CostBasis } {
    if (typeof payload.cost === 'number' && Number.isFinite(payload.cost)) {
      // `emitAgentSpend` prefers a provider-reported figure (OpenRouter usage
      // accounting) and falls back to the pricing table. It does not currently
      // tell us which, so an explicit basis on the payload wins when present
      // and 'estimated' is the safe default — claiming a reported figure we
      // only computed would overstate its authority.
      return { costUsd: payload.cost, costBasis: payload.costBasis ?? 'estimated' };
    }
    if (isLocalProvider(provider)) return { costUsd: 0, costBasis: 'local' };
    return { costUsd: null, costBasis: 'unknown' };
  }

  private record(payload: SpendPayload, timestamp: number): void {
    // Never let a bookkeeping failure break the event flow — the same posture
    // the activity persistence service takes.
    try {
      const provider = payload.provider ?? 'unknown';
      const model = payload.model ?? 'unknown';
      const endedAt = timestamp || Date.now();

      const { costUsd, costBasis } = this.resolveCost(payload, provider);
      const energy = this.resolveEnergy(payload, provider, model, endedAt);

      getUsageEventRepository().create({
        timestamp: endedAt,
        agentId: payload.agentId ?? null,
        agentName: payload.agentName ?? null,
        projectId: this.resolveProjectId(payload),
        containerId: payload.containerId ?? null,
        kind: payload.kind ?? 'unknown',
        provider,
        model,
        servedProvider: payload.servedProvider ?? null,
        inputTokens: payload.inputTokens ?? 0,
        outputTokens: payload.outputTokens ?? 0,
        cachedTokens: payload.cachedTokens ?? 0,
        cacheWriteTokens: payload.cacheWriteTokens ?? 0,
        costUsd,
        costBasis,
        ...energy,
        durationMs: payload.durationMs ?? null,
        usageIsTotal: payload.usageIsTotal === true,
      });
    } catch (error) {
      logger.error('[UsageLedger] Failed to record usage event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Drop a container's cached project mapping when the channel goes away. */
  forgetContainer(containerId: string): void {
    this.projectCache.delete(containerId);
  }
}

let service: UsageLedgerService | null = null;

export function getUsageLedgerService(): UsageLedgerService {
  if (!service) service = new UsageLedgerService();
  return service;
}
