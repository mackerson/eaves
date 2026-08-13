import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TaskContentSchema, validateWithSchema } from '@shared/validation';
import { useToastStore, useProjectStore } from '@/stores';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { LabelSelector } from '@/components/notes/LabelSelector';
import { NoteColor, TaskPriority } from '@/types';
import { Calendar, Flag, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseDateInput, toDateInputValue } from '@/lib/dateInput';

const PRIORITY_OPTIONS: { value: TaskPriority; label: string; color: string }[] = [
  { value: 'high', label: 'High', color: 'text-red-500' },
  { value: 'medium', label: 'Medium', color: 'text-yellow-500' },
  { value: 'low', label: 'Low', color: 'text-green-500' },
];

interface TaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TaskModal({ open, onOpenChange }: TaskModalProps) {
  const showToast = useToastStore((state) => state.showToast);
  const {
    editingTask,
    closeTaskModal,
    addTask,
    updateTask,
    loadNoteLabels,
  } = useProjectStore();

  const [content, setContent] = useState('');
  const [color, setColor] = useState<NoteColor>('default');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [estimatedDuration, setEstimatedDuration] = useState('');

  const isEditing = !!editingTask;

  // Load labels on mount and populate form when editing
  useEffect(() => {
    if (open) {
      loadNoteLabels();

      if (editingTask) {
        setContent(editingTask.content);
        setColor(editingTask.color || 'default');
        setPriority(editingTask.priority || 'medium');
        setSelectedLabels(editingTask.labels || []);
        setDueDate(toDateInputValue(editingTask.dueDate));
        setStartDate(toDateInputValue(editingTask.startDate));
        setEstimatedDuration(editingTask.estimatedDuration ? String(editingTask.estimatedDuration) : '');
      } else {
        setContent('');
        setColor('default');
        setPriority('medium');
        setSelectedLabels([]);
        setDueDate('');
        setStartDate('');
        setEstimatedDuration('');
      }
    }
  }, [open, editingTask, loadNoteLabels]);

  const handleClose = () => {
    onOpenChange(false);
    closeTaskModal();
    setContent('');
    setColor('default');
    setPriority('medium');
    setSelectedLabels([]);
    setDueDate('');
    setStartDate('');
    setEstimatedDuration('');
  };

  const handleSubmit = async () => {
    const validation = validateWithSchema(TaskContentSchema, content);

    if (!validation.success) {
      showToast(validation.error, 'warning');
      return;
    }

    try {
      const taskData = {
        content: validation.data,
        color,
        priority,
        labels: selectedLabels,
        dueDate: parseDateInput(dueDate),
        startDate: parseDateInput(startDate),
        estimatedDuration: estimatedDuration ? parseInt(estimatedDuration, 10) : undefined,
      };

      if (isEditing) {
        await updateTask(editingTask.id, taskData);
        showToast('Task updated', 'success');
      } else {
        await addTask(taskData);
        showToast('Task created', 'success');
      }
      handleClose();
    } catch (error) {
      showToast('Failed to save task', 'error');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Task' : 'Add Task'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Content */}
          <div className="space-y-2">
            <Label htmlFor="task-content">Task</Label>
            <Input
              id="task-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
              placeholder="What needs to be done?"
              autoFocus
            />
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Flag className="h-4 w-4" /> Priority
            </Label>
            <div className="flex gap-2">
              {PRIORITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPriority(option.value)}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-md text-sm font-medium transition-all border',
                    priority === option.value
                      ? 'bg-muted border-primary'
                      : 'border-border hover:bg-muted/50'
                  )}
                >
                  <span className={option.color}>{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Color Picker */}
          <div className="space-y-2">
            <Label>Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>

          {/* Labels */}
          <LabelSelector
            selectedLabels={selectedLabels}
            onChange={setSelectedLabels}
          />

          {/* Date Fields */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="task-start-date" className="flex items-center gap-2">
                <Calendar className="h-4 w-4" /> Start Date
              </Label>
              <Input
                id="task-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-due-date" className="flex items-center gap-2">
                <Calendar className="h-4 w-4" /> Due Date
              </Label>
              <Input
                id="task-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          {/* Estimated Duration */}
          <div className="space-y-2">
            <Label htmlFor="task-duration" className="flex items-center gap-2">
              <Clock className="h-4 w-4" /> Estimated Duration (minutes)
            </Label>
            <Input
              id="task-duration"
              type="number"
              min="0"
              value={estimatedDuration}
              onChange={(e) => setEstimatedDuration(e.target.value)}
              placeholder="e.g., 30"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!content.trim()}>
            {isEditing ? 'Save Changes' : 'Add Task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
