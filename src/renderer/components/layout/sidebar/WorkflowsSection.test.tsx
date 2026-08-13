import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// AppIcon reads the icon set from a context this component tree doesn't own.
vi.mock('@/components/ui/AppIcon', () => ({ AppIcon: () => null }));

import { WorkflowsSection } from './WorkflowsSection';
import { useSidebarPinsStore } from '@/stores';
import { useProjectStore } from '@/stores';

const workflow = (name: string, pinned: boolean) => ({
  id: `wf-${name}`, projectId: 'p1', name, dagDefinition: { nodes: [], edges: [] },
  enabled: true, pinned, reviewStatus: 'approved', createdBy: 'user',
  createdAt: 1, updatedAt: 1,
});

let getWorkflows: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getWorkflows = vi.fn().mockResolvedValue([]);
  (window as any).electron = {
    getWorkflows,
    getPendingReviewCount: vi.fn().mockResolvedValue({ success: true, count: 0 }),
    onActivityNew: vi.fn().mockReturnValue(() => {}),
  };
  useProjectStore.setState({ currentProjectId: 'p1' } as never);
  useSidebarPinsStore.setState({ workflowsRevision: 0 });
});

/** The section renders its list only when expanded. */
const expand = () => fireEvent.click(screen.getByTitle('Expand'));

describe('WorkflowsSection', () => {
  it('lists the pinned workflows for the current project', async () => {
    getWorkflows.mockResolvedValue([workflow('Pinned One', true), workflow('Not Pinned', false)]);
    render(<WorkflowsSection />);
    expand();

    await waitFor(() => expect(screen.getByText('Pinned One')).toBeTruthy());
    expect(screen.queryByText('Not Pinned')).toBeNull();
  });

  // Regression: pinning happens in the workflow list view, which has no path
  // back to this component. Without a change signal the sidebar kept showing a
  // stale list until it remounted, so a pin that had persisted correctly still
  // looked like it had done nothing.
  it('re-reads when a pin is toggled elsewhere', async () => {
    render(<WorkflowsSection />);
    expand();
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/No pinned workflows/)).toBeTruthy();

    getWorkflows.mockResolvedValue([workflow('Freshly Pinned', true)]);
    useSidebarPinsStore.getState().notifyWorkflowPinsChanged();

    await waitFor(() => expect(screen.getByText('Freshly Pinned')).toBeTruthy());
    expect(getWorkflows).toHaveBeenCalledTimes(2);
  });

  it('drops an unpinned workflow on the next signal', async () => {
    getWorkflows.mockResolvedValue([workflow('Going Away', true)]);
    render(<WorkflowsSection />);
    expand();
    await waitFor(() => expect(screen.getByText('Going Away')).toBeTruthy());

    getWorkflows.mockResolvedValue([workflow('Going Away', false)]);
    useSidebarPinsStore.getState().notifyWorkflowPinsChanged();

    await waitFor(() => expect(screen.queryByText('Going Away')).toBeNull());
  });
});
