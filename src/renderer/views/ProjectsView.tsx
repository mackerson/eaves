import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ProjectCard } from '@/components/ProjectCard';
import { useProjectStore } from '@/stores/useProjectStore';
import { useConversationsStore } from '@/stores';
import { useUIStore } from '@/stores/useUIStore';

export function ProjectsView() {
  const { projects, currentProjectId, switchProject, deleteProject, openProjectModal } = useProjectStore();
  const { channels } = useConversationsStore();
  const { setView } = useUIStore();

  const handleSwitchProject = useCallback(async (projectId: string) => {
    await switchProject(projectId);
    setView('channels');
  }, [switchProject, setView]);

  const handleDeleteProject = useCallback(async (projectId: string) => {
    if (confirm('Are you sure you want to delete this project?')) {
      await deleteProject(projectId);
    }
  }, [deleteProject]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Projects</h2>
        <Button onClick={() => openProjectModal()}>+ New Project</Button>
      </div>

      {/* Active Project Selector */}
      {projects.length > 0 && (
        <div className="mb-6 space-y-2">
          <div className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Active Project
          </div>
          <select
            value={currentProjectId || ''}
            onChange={(e) => handleSwitchProject(e.target.value)}
            className="w-full max-w-md px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            channels={channels}
            isActive={project.id === currentProjectId}
            onSelect={() => handleSwitchProject(project.id)}
            onEdit={() => openProjectModal(project)}
            onDelete={() => handleDeleteProject(project.id)}
          />
        ))}
      </div>
    </div>
  );
}
