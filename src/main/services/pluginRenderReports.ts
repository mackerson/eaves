/**
 * What a draft's UI actually did when someone looked at it.
 *
 * The gap this closes: an agent writes a plugin view, activation reports
 * "running", and that is the last thing it ever learns. Running is not
 * rendering — the bundle can fail to load, or the component can throw on its
 * first paint — and both of those happen in a window one process away from the
 * agent, with no route back. Until now the loop was: the agent writes
 * something, a person sees it break, and the person has to describe it.
 *
 * So the preview window's outcome is recorded here and read back through
 * `plugin_inspect`. Three states, and the difference between them matters:
 * never previewed, previewed and rendered, previewed and failed with this
 * message.
 *
 * Deliberately in memory only. A report describes one dispatch of one draft;
 * a restart drops every draft anyway (they are never discovered), so a
 * persisted report could only ever outlive the thing it describes.
 */

import { logger } from './logger';

export interface RenderReport {
  status: 'ok' | 'failed';
  /** Present on failure: what the preview window saw, as it saw it. */
  message?: string;
  at: number;
}

/** Last outcome per draft id. A second preview overwrites the first. */
const reports = new Map<string, RenderReport>();

/** Cap a stack trace to something a model can read without drowning in it. */
const MESSAGE_LIMIT = 2000;

export function recordRenderReport(draftId: string, report: Omit<RenderReport, 'at'>): void {
  const message = report.message
    ? report.message.slice(0, MESSAGE_LIMIT)
    : undefined;
  reports.set(draftId, { status: report.status, message, at: Date.now() });
  if (report.status === 'failed') {
    logger.warn('[PluginRender] A draft preview failed to render', { draftId, message });
  }
}

export function getRenderReport(draftId: string): RenderReport | undefined {
  return reports.get(draftId);
}

/**
 * Forget a draft's outcome. Called whenever the thing the report describes
 * stops existing — a redefine, a fresh activation, a retract — so nobody is
 * ever shown a failure belonging to code that has since been replaced.
 */
export function clearRenderReport(draftId: string): void {
  reports.delete(draftId);
}

/** Test seam. */
export function resetRenderReports(): void {
  reports.clear();
}
