import { memo } from 'react';
import { Project, Channel } from '@/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface ProjectCardProps {
  project: Project;
  channels: Channel[];
  isActive: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export const ProjectCard = memo(function ProjectCard({ project, channels, isActive, onSelect, onEdit, onDelete }: ProjectCardProps) {
  const projectChannels = channels.filter(c => c.projectId === project.id);
  const activeTasks = project.tasks.filter(t => !t.completed).length;

  return (
    <Card
      className={`cursor-pointer transition-all ${isActive ? 'ring-2 ring-primary' : ''}`}
      onClick={onSelect}
    >
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-lg">{project.name}</CardTitle>
            <CardDescription className="mt-1">{project.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <Badge variant="secondary">{projectChannels.length} channels</Badge>
          <Badge variant="outline">{activeTasks} active tasks</Badge>
          <Badge variant="outline">{project.notes.length} notes</Badge>
        </div>
        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={onEdit} className="flex-1">
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});
