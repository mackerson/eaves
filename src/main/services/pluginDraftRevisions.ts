/**
 * The draft that was there before the agent rewrote it.
 *
 * `plugin_define` replaces a draft's files wholesale, and the agent iterates —
 * a fix, a rename, a permission dropped. Without this, every redefinition
 * resets the human to re-reading the whole file to find the one line that
 * moved, which in practice means not reading it at all. Approving code you
 * have not read is the thing this tier exists to prevent, so the second
 * reading has to be cheaper than the first.
 *
 * In memory, like the render reports and for the same reason: a revision
 * describes one draft in one session, and a draft never survives a restart as
 * a *running* thing. Persisting the history would mean carrying around the
 * previous text of code that may no longer exist.
 *
 * One step deep on purpose. "What changed just now" is the question a person
 * actually asks at the bench; a full history is a different feature with a
 * different UI, and keeping every revision of every draft in memory for a
 * session is how a 2MB cap becomes unbounded.
 */

import type { DraftFile } from './pluginDraftService';

export interface DraftRevision {
  files: DraftFile[];
  at: number;
}

const previous = new Map<string, DraftRevision>();

/** Called by writeDraft with the files that are about to be overwritten. */
export function recordRevision(draftId: string, files: DraftFile[]): void {
  previous.set(draftId, { files, at: Date.now() });
}

export function getPreviousRevision(draftId: string): DraftRevision | undefined {
  return previous.get(draftId);
}

/**
 * Forget a draft's history. Called when the draft itself stops existing —
 * retracted, or promoted into a real install — so nothing can show a diff
 * against code that is gone.
 */
export function clearRevisions(draftId: string): void {
  previous.delete(draftId);
}

/** Test seam. */
export function resetRevisions(): void {
  previous.clear();
}
