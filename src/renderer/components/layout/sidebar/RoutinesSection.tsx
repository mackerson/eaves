import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Pin } from 'lucide-react';
import { useUIStore, useProjectStore, useSidebarPinsStore } from '@/stores';
import { AppIcon } from '@/components/ui/AppIcon';
import { Routine } from '@/types';
import { CollapsibleSection } from './CollapsibleSection';

export function RoutinesSection() {
  const { setView, setViewWithCreate } = useUIStore();
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  // Re-read when a pin is toggled elsewhere — the list view owns that action.
  const pinsRevision = useSidebarPinsStore((s) => s.routinesRevision);
  const [pinned, setPinned] = useState<Routine[]>([]);

  const loadPinned = useCallback(async () => {
    if (!currentProjectId) {
      setPinned([]);
      return;
    }
    try {
      const all = await window.electron.getRoutines(currentProjectId);
      setPinned((all || []).filter((r) => r.pinned));
    } catch (error) {
      console.error('[RoutinesSection] Failed to load pinned routines:', error);
    }
  }, [currentProjectId, pinsRevision]);

  useEffect(() => {
    loadPinned();
    // Refresh on run outcomes so a routine that starts failing shows it here
    // without waiting for a navigation.
    const cleanup = window.electron.onActivityNew((activity) => {
      if (activity.type.startsWith('routine:execution:')) loadPinned();
    });
    return cleanup;
  }, [loadPinned]);

  const handleViewRoutines = () => {
    setView('routines');
  };

  const handleCreateRoutine = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Navigate to routines view in creation mode
    setViewWithCreate('routines');
  };

  return (
    <CollapsibleSection
      title="Routines"
      onTitleClick={handleViewRoutines}
      onActionClick={handleCreateRoutine}
      actionTitle="New Routine"
    >
      {pinned.length === 0 ? (
        <div className="section-empty">
          No pinned routines. Pin one from the routine list.
        </div>
      ) : (
        <div className="section-list">
          {pinned.map((routine) => (
            <button
              key={routine.id}
              className="section-item"
              onClick={handleViewRoutines}
              title={
                routine.consecutiveFailures > 0
                  ? `Pinned routine — ${routine.name} (failing, ${routine.consecutiveFailures} runs)`
                  : `Pinned routine — ${routine.name}`
              }
            >
              <Pin size={12} className="item-pin" aria-hidden />
              <AppIcon name="routines" size={16} className="item-icon" />
              <span className="item-label">{routine.name}</span>
              {routine.consecutiveFailures > 0 && (
                <AlertTriangle size={12} style={{ color: '#f87171' }} aria-hidden />
              )}
            </button>
          ))}
        </div>
      )}
      <button className="section-view-all" onClick={handleViewRoutines}>
        View Routines →
      </button>
    </CollapsibleSection>
  );
}
