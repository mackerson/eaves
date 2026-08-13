import { useCallback, useEffect, useState } from 'react';
import { Pin } from 'lucide-react';
import { useUIStore, useProjectStore, useSidebarPinsStore } from '@/stores';
import { AppIcon } from '@/components/ui/AppIcon';
import { Workflow } from '@/types';
import { CollapsibleSection } from './CollapsibleSection';

export function WorkflowsSection() {
  const setView = useUIStore((s) => s.setView);
  const setViewWithCreate = useUIStore((s) => s.setViewWithCreate);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  // Re-read when a pin is toggled elsewhere — the list view owns that action.
  const pinsRevision = useSidebarPinsStore((s) => s.workflowsRevision);
  const [pendingCount, setPendingCount] = useState(0);
  const [pinned, setPinned] = useState<Workflow[]>([]);

  const loadPinned = useCallback(async () => {
    if (!currentProjectId) {
      setPinned([]);
      return;
    }
    try {
      const all = await window.electron.getWorkflows(currentProjectId);
      setPinned((all || []).filter((w) => w.pinned));
    } catch (error) {
      console.error('[WorkflowsSection] Failed to load pinned workflows:', error);
    }
  }, [currentProjectId, pinsRevision]);

  useEffect(() => { loadPinned(); }, [loadPinned]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await window.electron.getPendingReviewCount(currentProjectId || undefined);
        if (!cancelled && result.success && typeof result.count === 'number') {
          setPendingCount(result.count);
        }
      } catch (error) {
        console.error('[WorkflowsSection] Failed to fetch pending review count:', error);
      }
    }

    load();

    // Refresh when workflow-related activities come in
    const cleanup = window.electron.onActivityNew((activity) => {
      if (
        activity.type === 'workflow:created' ||
        activity.type === 'workflow:blocked:pending-review' ||
        activity.type.startsWith('workflow:execution:')
      ) {
        load();
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [currentProjectId]);

  const handleViewWorkflows = () => {
    setView('workflows');
  };

  const handleCreateWorkflow = (e: React.MouseEvent) => {
    e.stopPropagation();
    setViewWithCreate('workflows');
  };

  return (
    <CollapsibleSection
      title="Workflows"
      badge={pendingCount > 0 ? pendingCount : undefined}
      onTitleClick={handleViewWorkflows}
      onActionClick={handleCreateWorkflow}
      actionTitle="New Workflow"
    >
      {pinned.length === 0 ? (
        <div className="section-empty">
          No pinned workflows. Pin one from the workflow list.
        </div>
      ) : (
        <div className="section-list">
          {pinned.map((workflow) => (
            <button
              key={workflow.id}
              className="section-item"
              onClick={handleViewWorkflows}
              title={`Pinned workflow — ${workflow.name}`}
            >
              <Pin size={12} className="item-pin" aria-hidden />
              <AppIcon name="workflows" size={16} className="item-icon" />
              <span className="item-label">{workflow.name}</span>
            </button>
          ))}
        </div>
      )}
      <button className="section-view-all" onClick={handleViewWorkflows}>
        {pendingCount > 0 ? `${pendingCount} pending review →` : 'View Workflows →'}
      </button>
    </CollapsibleSection>
  );
}
