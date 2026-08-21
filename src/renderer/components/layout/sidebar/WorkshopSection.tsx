import { useCallback, useEffect, useState } from 'react';
import { useUIStore } from '@/stores';
import { CollapsibleSection } from './CollapsibleSection';
import type { Chat, PluginDraft } from '@/../shared/types';

/**
 * Staged drafts at a glance, and the way into the Workshop.
 *
 * Drafts are process- and disk-state rather than store-state, and nothing
 * pushes an event when an agent stages one, so this polls. The cadence is slow
 * on purpose: a draft appears when a person asks an agent for one, which is not
 * a thing that happens on a timer.
 */
const POLL_MS = 15_000;

export function WorkshopSection() {
  const { setView } = useUIStore();
  const [drafts, setDrafts] = useState<PluginDraft[]>([]);
  const [sessions, setSessions] = useState<Chat[]>([]);

  const refresh = useCallback(async () => {
    const [draftResult, sessionResult] = await Promise.all([
      window.electron.listPluginDrafts(),
      window.electron.listWorkshopSessions(),
    ]);
    setDrafts(draftResult?.drafts ?? []);
    setSessions(sessionResult?.sessions ?? []);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <CollapsibleSection
      title="Workshop"
      onTitleClick={() => setView('workshop')}
      isExpandedByDefault={drafts.length > 0 || sessions.length > 0}
    >
      {drafts.length === 0 && sessions.length === 0 ? (
        <div className="section-empty">Nothing being built</div>
      ) : (
        <div className="section-list">
          {/* Builds first — a session is the thing you come back to; a draft is
              what one of them produced. Selecting a specific build happens in
              the Workshop itself, so these all just open it. */}
          {sessions.map((session) => (
            <button key={session.id} className="section-item" onClick={() => setView('workshop')}>
              <span className="item-icon">🛠</span>
              <span className="item-label">{session.name}</span>
            </button>
          ))}
          {drafts.map((draft) => (
            <button key={draft.id} className="section-item" onClick={() => setView('workshop')}>
              <span className="item-icon">{draft.running ? '●' : '○'}</span>
              <span className="item-label">{draft.name}</span>
            </button>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
