import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Bot, Folder, Hourglass, Pin, PinOff, Plus, TriangleAlert, Workflow as WorkflowIcon, X } from 'lucide-react';
import { ReactFlowProvider } from 'reactflow';
import { WorkflowEditor } from '@/components/workflows/WorkflowEditor';
import { WorkflowReviewBanner } from '@/components/workflows/WorkflowReviewBanner';
import { useProjectStore, useUIStore, useSidebarPinsStore } from '@/stores';
import { useToastStore } from '@/stores/useToastStore';
import type { Workflow } from '@/types';
import type { Node, Edge } from 'reactflow';

export function WorkflowsView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const { pendingCreate, clearPendingCreate } = useUIStore();
  const showToast = useToastStore((s) => s.showToast);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Handle creation mode signal from sidebar
  useEffect(() => {
    if (pendingCreate) {
      setSelectedWorkflow(null);
      setIsEditing(true);
      clearPendingCreate();
    }
  }, [pendingCreate, clearPendingCreate]);

  // Load workflows when project changes
  const loadWorkflows = useCallback(async () => {
    if (!currentProjectId) {
      setWorkflows([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const loadedWorkflows = await window.electron.getWorkflows(currentProjectId);
      setWorkflows(loadedWorkflows);
    } catch (error) {
      console.error('Failed to load workflows:', error);
    } finally {
      setIsLoading(false);
    }
  }, [currentProjectId]);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  const handleCreateWorkflow = () => {
    setSelectedWorkflow(null);
    setIsEditing(true);
  };

  const handleEditWorkflow = async (workflowId: string) => {
    try {
      const workflow = await window.electron.getWorkflow(workflowId);
      setSelectedWorkflow(workflow);
      setIsEditing(true);
    } catch (error) {
      console.error('Failed to load workflow:', error);
    }
  };

  const handleSaveWorkflow = async (name: string, nodes: Node[], edges: Edge[]) => {
    if (!currentProjectId) return;

    try {
      const dagDefinition = { nodes, edges };

      if (selectedWorkflow) {
        // Update existing workflow
        await window.electron.updateWorkflow(selectedWorkflow.id, {
          name,
          dagDefinition,
        });
      } else {
        // Create new workflow
        await window.electron.createWorkflow({
          projectId: currentProjectId,
          name,
          dagDefinition,
          enabled: true,
          createdBy: 'user',
          reviewStatus: 'approved',
        });
      }

      // Reload workflows
      await loadWorkflows();
      setIsEditing(false);
      setSelectedWorkflow(null);
    } catch (error) {
      console.error('Failed to save workflow:', error);
    }
  };

  const handleTogglePinned = async (workflow: Workflow, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const updated = await window.electron.updateWorkflow(workflow.id, { pinned: !workflow.pinned });
      if (updated) {
        setWorkflows((prev) => prev.map((w) => (w.id === workflow.id ? updated : w)));
        useSidebarPinsStore.getState().notifyWorkflowPinsChanged();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update pin', 'error');
    }
  };

  const handleDeleteWorkflow = async (workflowId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this workflow?')) return;

    try {
      await window.electron.deleteWorkflow(workflowId);
      await loadWorkflows();
    } catch (error) {
      console.error('Failed to delete workflow:', error);
    }
  };

  const handleBackToList = () => {
    setIsEditing(false);
    setSelectedWorkflow(null);
  };

  const handleApprove = async (workflowId: string) => {
    try {
      const result = await window.electron.approveWorkflow(workflowId);
      if (result.success && result.workflow) {
        showToast(`Workflow "${result.workflow.name}" approved`, 'success');
        setSelectedWorkflow(result.workflow);
        await loadWorkflows();
      } else {
        showToast(result.error || 'Failed to approve workflow', 'error');
      }
    } catch (error) {
      console.error('Failed to approve workflow:', error);
      showToast('Failed to approve workflow', 'error');
    }
  };

  const handleDeletePending = async (workflowId: string) => {
    if (!confirm('Delete this unapproved workflow?')) return;
    try {
      await window.electron.deleteWorkflow(workflowId);
      showToast('Workflow deleted', 'info');
      setIsEditing(false);
      setSelectedWorkflow(null);
      await loadWorkflows();
    } catch (error) {
      console.error('Failed to delete workflow:', error);
      showToast('Failed to delete workflow', 'error');
    }
  };

  if (!currentProjectId) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        <div className="text-center">
          <Folder size={48} className="mx-auto mb-4" />
          <p className="text-lg">Select a project to view workflows</p>
        </div>
      </div>
    );
  }

  if (isEditing) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-4 p-4 bg-bg-secondary border-b border-border-primary">
          <button
            onClick={handleBackToList}
            className="px-4 py-2 bg-bg-tertiary border border-border-secondary rounded-md hover:bg-bg-hover transition-colors flex items-center gap-2"
          >
            <ArrowLeft size={14} />
            Back to Workflows
          </button>
          <h2 className="text-xl font-semibold">
            {selectedWorkflow ? 'Edit Workflow' : 'New Workflow'}
          </h2>
        </div>
        {selectedWorkflow && selectedWorkflow.reviewStatus === 'pending' && (
          <WorkflowReviewBanner
            workflow={selectedWorkflow}
            onApprove={() => handleApprove(selectedWorkflow.id)}
            onDelete={() => handleDeletePending(selectedWorkflow.id)}
          />
        )}
        <div className="flex-1">
          <ReactFlowProvider>
            <WorkflowEditor
              workflowId={selectedWorkflow?.id}
              initialWorkflow={selectedWorkflow ? {
                name: selectedWorkflow.name,
                dagDefinition: selectedWorkflow.dagDefinition,
              } : undefined}
              onSave={handleSaveWorkflow}
            />
          </ReactFlowProvider>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Workflows</h1>
        <button
          className="px-4 py-2 bg-accent-primary text-white rounded-md hover:bg-accent-secondary transition-colors flex items-center gap-2"
          onClick={handleCreateWorkflow}
        >
          <Plus size={16} />
          New Workflow
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-text-tertiary">
          <div className="text-center">
            <Hourglass size={40} className="animate-spin mx-auto mb-4" />
            <p>Loading workflows...</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workflows.length === 0 ? (
            <div className="col-span-full text-center py-12 text-text-tertiary">
              <WorkflowIcon size={48} className="mx-auto mb-4" />
              <p className="text-lg">No workflows yet</p>
              <p className="text-sm mt-2">Create your first workflow to automate tasks</p>
            </div>
          ) : (
            workflows.map((workflow) => (
              <div
                key={workflow.id}
                className="p-4 bg-bg-secondary border border-border-primary rounded-md hover:border-accent-primary transition-colors cursor-pointer group relative"
                onClick={() => handleEditWorkflow(workflow.id)}
              >
                <button
                  onClick={(e) => handleDeleteWorkflow(workflow.id, e)}
                  className="absolute top-2 right-2 w-6 h-6 rounded bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/20 flex items-center justify-center"
                  title="Delete workflow"
                >
                  <X size={14} />
                </button>
                {/* Pinned stays visible; unpinned only appears on hover, so the
                    card isn't cluttered by an affordance nobody is using. */}
                <button
                  onClick={(e) => handleTogglePinned(workflow, e)}
                  className={`absolute top-2 right-10 w-6 h-6 rounded transition-opacity flex items-center justify-center hover:bg-bg-tertiary ${
                    workflow.pinned ? 'opacity-100 text-accent-primary' : 'opacity-0 group-hover:opacity-100 text-text-tertiary'
                  }`}
                  title={workflow.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                >
                  {workflow.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
                <div className="flex items-start gap-2 mb-2">
                  <h3 className="font-semibold text-lg flex-1">{workflow.name}</h3>
                  {workflow.reviewStatus === 'pending' && (
                    <span
                      className="px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap flex items-center gap-1"
                      style={{ background: 'rgba(234, 179, 8, 0.15)', color: 'rgb(202, 138, 4)' }}
                      title="Awaiting human review"
                    >
                      <TriangleAlert size={12} />
                      Review
                    </span>
                  )}
                </div>
                {workflow.description && (
                  <p className="text-sm text-text-secondary mb-3">{workflow.description}</p>
                )}
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <span className={workflow.enabled ? 'text-green-500' : 'text-text-tertiary'}>
                    {workflow.enabled ? '● Enabled' : '○ Disabled'}
                  </span>
                  <span>•</span>
                  <span>{workflow.dagDefinition?.nodes?.length || 0} nodes</span>
                  {workflow.createdBy === 'agent' && (
                    <>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <Bot size={14} />
                        agent-authored
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
