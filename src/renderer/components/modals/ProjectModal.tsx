import { useState, useEffect } from 'react';
import { Project } from '@/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CreateProjectSchema, UpdateProjectSchema, validateWithSchema } from '@shared/validation';
import { useToastStore } from '@/stores';

interface ProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null; // null = create mode, Project = edit mode
  onSave: (data: { name: string; description: string }) => void;
}

export function ProjectModal({ open, onOpenChange, project, onSave }: ProjectModalProps) {
  const showToast = useToastStore((state) => state.showToast);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
  });

  useEffect(() => {
    if (project) {
      setFormData({
        name: project.name,
        description: project.description,
      });
    } else {
      setFormData({
        name: '',
        description: '',
      });
    }
  }, [project, open]);

  const handleSave = () => {
    // Validate based on whether we're creating or updating
    const schema = project ? UpdateProjectSchema : CreateProjectSchema;
    const validation = validateWithSchema(schema, formData);

    if (!validation.success) {
      showToast(validation.error, 'warning');
      return;
    }

    // UpdateProjectSchema types both fields optional; formData always carries
    // the (trimmed) values, so fall back to it to satisfy the required shape.
    onSave({
      name: validation.data.name ?? formData.name,
      description: validation.data.description ?? formData.description,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{project ? 'Edit Project' : 'Create New Project'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="My Project"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Project description"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            {project ? 'Save Changes' : 'Create Project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
