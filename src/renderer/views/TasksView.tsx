import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Task, TaskPriority, NoteColor } from '@/types';
import { KanbanBoard } from '@/components/tasks/KanbanBoard';
import {
  Plus,
  Trash2,
  Calendar,
  CheckSquare,
  List,
  LayoutGrid,
  AlertCircle,
  Flag,
  GripVertical,
  Clock,
  Tag,
  Check
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/useProjectStore';
import { LabelBadges } from '@/components/notes/LabelSelector';
import { useToastStore } from '@/stores/useToastStore';
import { spliceReorder, valueAtDropPosition } from '@/lib/reorder';

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type ViewMode = 'list' | 'kanban';

const NOTE_COLORS: Record<NoteColor, { bg: string; border: string }> = {
  default: { bg: 'var(--bg-secondary)', border: 'var(--border-primary)' },
  red: { bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.4)' },
  orange: { bg: 'rgba(249, 115, 22, 0.15)', border: 'rgba(249, 115, 22, 0.4)' },
  yellow: { bg: 'rgba(234, 179, 8, 0.15)', border: 'rgba(234, 179, 8, 0.4)' },
  green: { bg: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.4)' },
  teal: { bg: 'rgba(20, 184, 166, 0.15)', border: 'rgba(20, 184, 166, 0.4)' },
  blue: { bg: 'rgba(59, 130, 246, 0.15)', border: 'rgba(59, 130, 246, 0.4)' },
  purple: { bg: 'rgba(168, 85, 247, 0.15)', border: 'rgba(168, 85, 247, 0.4)' },
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  high: 'text-red-500',
  medium: 'text-yellow-500',
  low: 'text-green-500',
};

function formatDueDate(timestamp: number): { text: string; isOverdue: boolean; isToday: boolean; isSoon: boolean } {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((dueDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { text: `${Math.abs(diffDays)}d overdue`, isOverdue: true, isToday: false, isSoon: false };
  } else if (diffDays === 0) {
    return { text: 'Today', isOverdue: false, isToday: true, isSoon: false };
  } else if (diffDays === 1) {
    return { text: 'Tomorrow', isOverdue: false, isToday: false, isSoon: true };
  } else if (diffDays < 7) {
    return { text: date.toLocaleDateString([], { weekday: 'short' }), isOverdue: false, isToday: false, isSoon: true };
  } else {
    return { text: date.toLocaleDateString([], { month: 'short', day: 'numeric' }), isOverdue: false, isToday: false, isSoon: false };
  }
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

interface SortableTaskCardProps {
  task: Task;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
}

function SortableTaskCard({ task, onToggle, onDelete, onEdit }: SortableTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const colorStyle = NOTE_COLORS[task.color || 'default'];
  const dueInfo = task.dueDate ? formatDueDate(task.dueDate) : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        backgroundColor: colorStyle.bg,
        borderColor: task.completed ? 'var(--border-secondary)' : colorStyle.border,
        opacity: isDragging ? 0.5 : task.completed ? 0.6 : 1,
      }}
      className={cn(
        'group rounded-lg border p-4 transition-all',
        isDragging && 'shadow-lg'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Drag Handle */}
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 flex-shrink-0 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-60 transition-opacity"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <GripVertical className="h-4 w-4" />
        </button>

        {/* Checkbox */}
        <button
          onClick={onToggle}
          className="mt-0.5 flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors"
          style={{
            borderColor: task.completed ? 'var(--status-success)' : 'var(--border-primary)',
            backgroundColor: task.completed ? 'var(--status-success)' : 'transparent'
          }}
        >
          {task.completed && <Check className="h-3 w-3 text-white" />}
        </button>

        {/* Task Content */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onEdit}>
          <div className="flex items-center gap-2">
            {/* Priority indicator */}
            {task.priority && task.priority !== 'medium' && (
              <Flag className={cn('h-3.5 w-3.5 flex-shrink-0', PRIORITY_COLORS[task.priority])} />
            )}
            <p
              className={cn('text-sm', task.completed && 'line-through')}
              style={{ color: 'var(--text-primary)' }}
            >
              {task.content}
            </p>
          </div>

          {/* Meta info row */}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            {/* Due date */}
            {dueInfo && !task.completed && (
              <div
                className="flex items-center gap-1 text-xs"
                style={{
                  color: dueInfo.isOverdue
                    ? 'var(--status-error)'
                    : dueInfo.isToday
                    ? 'var(--status-warning)'
                    : dueInfo.isSoon
                    ? 'var(--accent-primary)'
                    : 'var(--text-tertiary)'
                }}
              >
                {dueInfo.isOverdue && <AlertCircle className="h-3 w-3" />}
                <Calendar className="h-3 w-3" />
                {dueInfo.text}
              </div>
            )}

            {/* Duration */}
            {task.estimatedDuration && (
              <div
                className="flex items-center gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <Clock className="h-3 w-3" />
                {formatDuration(task.estimatedDuration)}
              </div>
            )}

            {/* Labels. LabelSelector stores label *ids*; this rendered them
                raw, so every task showed a UUID where NotesView showed a name.
                LabelBadges was the centralised resolver and this view was
                never migrated to it. */}
            {task.labels && task.labels.length > 0 && (
              <LabelBadges
                labelIds={task.labels}
                max={2}
                icon={<Tag className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} />}
              />
            )}
          </div>
        </div>

        {/* Delete button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function TaskCardOverlay({ task }: { task: Task }) {
  const colorStyle = NOTE_COLORS[task.color || 'default'];

  return (
    <div
      className="rounded-lg border p-4 shadow-lg"
      style={{
        backgroundColor: colorStyle.bg,
        borderColor: colorStyle.border,
      }}
    >
      <div className="flex items-start gap-3">
        <GripVertical className="h-4 w-4 mt-0.5" style={{ color: 'var(--text-tertiary)' }} />
        <div className="w-5 h-5 rounded border-2" style={{ borderColor: 'var(--border-primary)' }} />
        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {task.content}
        </p>
      </div>
    </div>
  );
}

interface SortableListProps {
  tasks: Task[];
  title: string;
  onToggle: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onEdit: (task: Task) => void;
  onReorder: (taskIds: string[], movedId: string) => void;
  onClearCompleted?: () => void;
}

function SortableList({
  tasks,
  title,
  onToggle,
  onDelete,
  onEdit,
  onReorder,
  onClearCompleted
}: SortableListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Prevents accidental drags
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeId),
    [tasks, activeId]
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = taskIds.indexOf(active.id as string);
    const newIndex = taskIds.indexOf(over.id as string);

    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = [...taskIds];
    newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, active.id as string);

    // Pass the dragged id through: the caller has to know which item moved to
    // work out what band it landed in, and inferring it from a diff is
    // guesswork the drag layer already has the answer to.
    onReorder(newOrder, active.id as string);
  };

  const isCompleted = title.toLowerCase().includes('completed');

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3
          className="text-sm font-medium uppercase tracking-wide"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {title} ({tasks.length})
        </h3>
        {isCompleted && onClearCompleted && tasks.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearCompleted}
            className="text-xs"
          >
            Clear completed
          </Button>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                onToggle={() => onToggle(task.id)}
                onDelete={() => onDelete(task.id)}
                onEdit={() => onEdit(task)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeTask && <TaskCardOverlay task={activeTask} />}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function ViewToggle({ viewMode, setViewMode }: { viewMode: ViewMode; setViewMode: (v: ViewMode) => void }) {
  return (
    <div
      className="flex rounded-lg border overflow-hidden"
      style={{
        borderColor: 'var(--border-primary)',
        backgroundColor: 'var(--bg-secondary)'
      }}
    >
      <button
        onClick={() => setViewMode('list')}
        className="px-3 py-2 text-sm font-medium transition-colors flex items-center gap-2"
        style={{
          backgroundColor: viewMode === 'list' ? 'var(--accent-primary)' : 'transparent',
          color: viewMode === 'list' ? 'var(--text-inverse)' : 'var(--text-secondary)'
        }}
      >
        <List className="h-4 w-4" /> List
      </button>
      <button
        onClick={() => setViewMode('kanban')}
        className="px-3 py-2 text-sm font-medium transition-colors flex items-center gap-2"
        style={{
          backgroundColor: viewMode === 'kanban' ? 'var(--accent-primary)' : 'transparent',
          color: viewMode === 'kanban' ? 'var(--text-inverse)' : 'var(--text-secondary)'
        }}
      >
        <LayoutGrid className="h-4 w-4" /> Board
      </button>
    </div>
  );
}

export function TasksView() {
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const {
    tasks,
    openTaskModal,
    toggleTask,
    deleteTask,
    reorderTasks,
    updateTask,
  } = useProjectStore();
  const showToast = useToastStore((s) => s.showToast);

  // Sort: incomplete first (by priority, then sortOrder), then completed
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;

      // For incomplete tasks: sort by priority first, then by sortOrder
      if (!a.completed && !b.completed) {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const aPriority = priorityOrder[a.priority || 'medium'];
        const bPriority = priorityOrder[b.priority || 'medium'];
        if (aPriority !== bPriority) return aPriority - bPriority;

        // Then by sortOrder (higher = first)
        return (b.sortOrder || 0) - (a.sortOrder || 0);
      }

      // For completed: by sortOrder
      return (b.sortOrder || 0) - (a.sortOrder || 0);
    });
  }, [tasks]);

  const incompleteTasks = useMemo(() => sortedTasks.filter(t => !t.completed), [sortedTasks]);
  const completedTasks = useMemo(() => sortedTasks.filter(t => t.completed), [sortedTasks]);

  const handleClearCompleted = async () => {
    for (const task of completedTasks) {
      await deleteTask(task.id);
    }
  };

  /**
   * The list sorts by priority first and `sortOrder` second, but reordering
   * only ever wrote `sortOrder` — so dragging a task into a different priority
   * band animated into place and snapped straight back. It read as flaky
   * rather than broken because it works fine within a band.
   *
   * A drag is an instruction, so honour it: a task dropped among the
   * high-priority ones becomes high priority, and says so. The priority flag
   * is already on every row, so the change is visible where it landed.
   */
  const handleReorderIncomplete = async (taskIds: string[], movedId: string) => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const moved = byId.get(movedId);
    const landedIn = valueAtDropPosition(
      taskIds,
      movedId,
      (id) => (id === movedId ? undefined : byId.get(id)?.priority || 'medium'),
    );

    if (moved && landedIn && (moved.priority || 'medium') !== landedIn) {
      await updateTask(movedId, { priority: landedIn });
      showToast(`Moved to ${landedIn} priority`, 'info');
    }

    // Splice back into the full list: completed tasks are not in `taskIds`,
    // and renumbering only this half left their sortOrder colliding.
    reorderTasks(spliceReorder(sortedTasks.map((t) => t.id), taskIds));
  };

  const handleReorderCompleted = (taskIds: string[]) => {
    reorderTasks(spliceReorder(sortedTasks.map((t) => t.id), taskIds));
  };

  if (viewMode === 'kanban') {
    return (
      <div className="flex flex-col h-full">
        <div className="p-8 pb-4">
          <div className="flex items-center justify-between">
            <h2 className="text-3xl font-semibold">Tasks</h2>
            <div className="flex items-center gap-2">
              <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <KanbanBoard
            tasks={tasks}
            onAddTask={() => openTaskModal()}
            onToggleTask={toggleTask}
            onDeleteTask={deleteTask}
            onClearCompleted={handleClearCompleted}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-semibold">Tasks</h2>
        <div className="flex items-center gap-2">
          <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
          <Button onClick={() => openTaskModal()}>
            <Plus className="h-4 w-4 mr-2" /> New Task
          </Button>
        </div>
      </div>

      {tasks.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-16 rounded-lg border-2 border-dashed"
          style={{ borderColor: 'var(--border-secondary)' }}
        >
          <CheckSquare
            className="h-12 w-12 mb-4"
            style={{ color: 'var(--text-tertiary)' }}
          />
          <p
            className="text-lg font-medium mb-1"
            style={{ color: 'var(--text-secondary)' }}
          >
            No tasks yet
          </p>
          <p
            className="text-sm mb-4"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Create your first task to get started
          </p>
          <Button onClick={() => openTaskModal()} variant="outline">
            <Plus className="h-4 w-4 mr-2" /> Create Task
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Incomplete tasks */}
          {incompleteTasks.length > 0 && (
            <SortableList
              tasks={incompleteTasks}
              title="To Do"
              onToggle={toggleTask}
              onDelete={deleteTask}
              onEdit={(task) => openTaskModal(task)}
              onReorder={handleReorderIncomplete}
            />
          )}

          {/* Completed tasks */}
          {completedTasks.length > 0 && (
            <SortableList
              tasks={completedTasks}
              title="Completed"
              onToggle={toggleTask}
              onDelete={deleteTask}
              onEdit={(task) => openTaskModal(task)}
              onReorder={handleReorderCompleted}
              onClearCompleted={handleClearCompleted}
            />
          )}
        </div>
      )}
    </div>
  );
}
