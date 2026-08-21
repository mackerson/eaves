import { ipcMain } from 'electron';
import { getUsageEventRepository } from '../repositories';
import { getPowerSampler } from '../services/PowerSampler';
import { readUserOverrides, pricingKey } from '../services/pricingResolver';
import { getModelPricing, isLocalProvider } from '../../shared/pricing';
import { logger } from '../services/logger';
import { UsageFilterSchema, UsageSummaryRequestSchema, TimestampSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import type { UsageSummary } from '../../shared/types';

/**
 * The system view's read surface.
 *
 * `usage:summary` deliberately returns totals, series and every breakdown in
 * one call rather than exposing six endpoints the renderer would fan out to.
 * The reason is consistency, not round trips: six independent queries can be
 * served from six different moments, and a header that disagrees with the
 * chart beneath it reads as a bug in the accounting even when every individual
 * number is right.
 */
export function registerUsageHandlers() {
  ipcMain.handle('usage:summary', ipcResult('usage:summary', async (_event, request?: unknown) => {
    const validation = validateIPC(UsageSummaryRequestSchema, request ?? {}, 'usage:summary');
    if (!validation.success) return validation;

    const { bucket, ...filter } = validation.data;
    const repo = getUsageEventRepository();

    const summary: UsageSummary = {
      totals: repo.totals(filter),
      series: repo.series(bucket ?? 'day', filter),
      byAgent: repo.breakdown('agent', filter),
      byProvider: repo.breakdown('provider', filter),
      byModel: repo.breakdown('model', filter),
      byProject: repo.breakdown('project', filter),
      byKind: repo.breakdown('kind', filter),
    };

    return { success: true, summary, earliest: repo.earliestTimestamp() };
  }));

  ipcMain.handle('usage:list', ipcResult('usage:list', async (_event, filter?: unknown) => {
    const validation = validateIPC(UsageFilterSchema, filter ?? { limit: 100 }, 'usage:list');
    if (!validation.success) return validation;
    return { success: true, events: getUsageEventRepository().list(validation.data) };
  }));

  /**
   * What the app currently believes each model costs, and where that belief
   * came from. Powers the pricing editor: a user cannot correct a rate they
   * cannot see, and "which of these is a shipped guess" is the first question
   * anyone auditing a bill will ask.
   */
  ipcMain.handle('usage:pricing', ipcResult('usage:pricing', async () => {
    const repo = getUsageEventRepository();
    const overrides = readUserOverrides();

    // Only models actually used. A full catalogue would be mostly noise, and
    // the ledger already knows exactly which pairs matter to this workspace.
    const rows = repo.distinctModels().map(({ provider, model, turns }) => {
      const key = pricingKey(provider, model);
      const override = overrides[key];
      const builtin = getModelPricing(provider, model);

      // A local model has no table entry, but that is not the same as being
      // unpriced: it costs nothing to run, and its spend is genuinely zero
      // rather than missing. Reporting it as 'none' would put it in the
      // "models with no price" warning and imply the totals are short by
      // however much it ran — which would be false and alarming.
      const source: 'user' | 'builtin' | 'local' | 'none' =
        override ? 'user'
          : builtin ? 'builtin'
            : isLocalProvider(provider) ? 'local'
              : 'none';

      return {
        key,
        provider,
        model,
        turns,
        promptCostPer1M: override?.promptCostPer1M ?? builtin?.promptCostPer1M ?? null,
        completionCostPer1M: override?.completionCostPer1M ?? builtin?.completionCostPer1M ?? null,
        // 'none' is the interesting one: a *cloud* model the workspace uses
        // and the app cannot price, which is exactly the row whose spend is
        // missing from every total until someone fills it in.
        source,
      };
    });

    // Overrides for models not in the recent window still belong in the editor
    // — otherwise a rate the user set months ago becomes uneditable.
    for (const [key, value] of Object.entries(overrides)) {
      if (rows.some(r => r.key === key)) continue;
      const [provider, ...rest] = key.split(':');
      rows.push({
        key,
        provider,
        model: rest.join(':'),
        turns: 0,
        promptCostPer1M: value.promptCostPer1M,
        completionCostPer1M: value.completionCostPer1M,
        source: 'user' as const,
      });
    }

    return { success: true, pricing: rows };
  }));

  /** Whether real power measurement is actually running, and via what. */
  ipcMain.handle('usage:power-status', ipcResult('usage:power-status', async () => {
    const sampler = getPowerSampler();
    return {
      success: true,
      status: {
        available: sampler.available,
        sources: sampler.sources,
        platformSupported: process.platform === 'linux',
      },
    };
  }));

  ipcMain.handle('usage:clear-before', ipcResult('usage:clear-before', async (_event, timestamp?: unknown) => {
    const validation = validateIPC(TimestampSchema, timestamp, 'usage:clear-before');
    if (!validation.success) return validation;

    const deleted = getUsageEventRepository().clearBefore(validation.data);
    logger.info(`[Usage] Cleared ${deleted} ledger rows before ${new Date(validation.data).toISOString()}`);
    return { success: true, deleted };
  }));
}
