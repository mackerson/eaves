import { useState, useEffect } from 'react';
import { ClipboardList, Calendar, StickyNote } from 'lucide-react';
import { Task } from '@/types';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/stores';

interface KanbanBoardProps {
  tasks: Task[];
  onAddTask: () => void;
  onToggleTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onClearCompleted?: () => void;
}

type ColumnId = 'todo' | 'doing' | 'done';

type Column = {
  id: ColumnId;
  title: string;
  tasks: Task[];
};

export function KanbanBoard({ tasks, onAddTask, onToggleTask, onDeleteTask, onClearCompleted }: KanbanBoardProps) {
  const { currentProjectId } = useProjectStore();
  const [doingTaskId, setDoingTaskId] = useState<string | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);

  // Load doing task from localStorage
  useEffect(() => {
    if (currentProjectId) {
      const stored = localStorage.getItem(`kanban-doing-${currentProjectId}`);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          // Verify the task still exists and isn't completed
          const task = tasks.find(t => t.id === parsed && !t.completed);
          setDoingTaskId(task ? parsed : null);
        } catch {
          setDoingTaskId(null);
        }
      }
    }
  }, [currentProjectId, tasks]);

  // Save doing task to localStorage
  const updateDoingTask = (taskId: string | null) => {
    setDoingTaskId(taskId);
    if (currentProjectId) {
      if (taskId) {
        localStorage.setItem(`kanban-doing-${currentProjectId}`, JSON.stringify(taskId));
      } else {
        localStorage.removeItem(`kanban-doing-${currentProjectId}`);
      }
    }
  };

  // Organize tasks into columns
  const doingTask = doingTaskId ? tasks.find(t => t.id === doingTaskId && !t.completed) : null;
  const todoTasks = tasks.filter(t => !t.completed && t.id !== doingTaskId);
  const doneTasks = tasks.filter(t => t.completed);

  const columns: Column[] = [
    {
      id: 'todo',
      title: 'To Do',
      tasks: todoTasks,
    },
    {
      id: 'doing',
      title: 'Doing',
      tasks: doingTask ? [doingTask] : [],
    },
    {
      id: 'done',
      title: 'Done',
      tasks: doneTasks,
    },
  ];

  // Handle drag and drop
  const handleDragStart = (task: Task, _sourceColumn: ColumnId) => {
    setDraggedTask(task);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); // Allow drop
  };

  const handleDrop = (targetColumn: ColumnId) => {
    if (!draggedTask) return;

    // Handle transitions
    if (targetColumn === 'doing') {
      updateDoingTask(draggedTask.id);
      // If task was completed, unmark it
      if (draggedTask.completed) {
        onToggleTask(draggedTask.id);
      }
    } else if (targetColumn === 'done') {
      // Moving to Done column
      if (draggedTask.id === doingTaskId) {
        updateDoingTask(null);
      }
      if (!draggedTask.completed) {
        onToggleTask(draggedTask.id);
      }
    } else if (targetColumn === 'todo') {
      // Moving to Todo column
      if (draggedTask.id === doingTaskId) {
        updateDoingTask(null);
      }
      if (draggedTask.completed) {
        onToggleTask(draggedTask.id);
      }
    }

    setDraggedTask(null);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-8">
        <div className="flex gap-6 h-full min-w-min">
          {columns.map((column) => (
            <div
              key={column.id}
              className="flex flex-col rounded-lg border"
              style={{
                backgroundColor: 'var(--bg-secondary)',
                borderColor: draggedTask ? 'var(--accent-primary)' : 'var(--border-primary)',
                minWidth: column.id === 'doing' ? '400px' : '320px',
                maxWidth: column.id === 'doing' ? '500px' : '400px',
                flex: '1',
                transition: 'border-color 0.2s'
              }}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(column.id)}
            >
              {/* Column Header */}
              <div
                className="p-4 border-b flex items-center justify-between"
                style={{ borderColor: 'var(--border-secondary)' }}
              >
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{column.title}</h3>
                  <span
                    className="px-2 py-1 rounded-full text-xs font-medium"
                    style={{
                      backgroundColor: 'var(--bg-tertiary)',
                      color: 'var(--text-tertiary)'
                    }}
                  >
                    {column.tasks.length}
                    {column.id === 'doing' && ' / 1'}
                  </span>
                </div>
                {column.id === 'todo' && (
                  <button
                    onClick={onAddTask}
                    className="text-xl transition-colors"
                    style={{ color: 'var(--accent-primary)' }}
                    title="Add task"
                  >
                    +
                  </button>
                )}
                {column.id === 'done' && column.tasks.length > 0 && onClearCompleted && (
                  <button
                    onClick={onClearCompleted}
                    className="px-3 py-1 text-xs font-medium rounded transition-colors"
                    style={{
                      backgroundColor: 'var(--bg-tertiary)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border-secondary)'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--status-error)';
                      e.currentTarget.style.color = 'var(--text-inverse)';
                      e.currentTarget.style.borderColor = 'var(--status-error)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
                      e.currentTarget.style.color = 'var(--text-secondary)';
                      e.currentTarget.style.borderColor = 'var(--border-secondary)';
                    }}
                    title="Delete all completed tasks"
                  >
                    Clear All
                  </button>
                )}
              </div>

              {/* Column Body */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {column.tasks.length === 0 ? (
                  <div
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {column.id === 'doing' && 'Drag a task here to work on it'}
                    {column.id === 'todo' && 'No tasks'}
                    {column.id === 'done' && 'No completed tasks'}
                  </div>
                ) : (
                  column.tasks.map((task) => (
                    <div key={task.id}>
                      <div
                        draggable
                        onDragStart={() => handleDragStart(task, column.id)}
                        className="p-4 rounded-lg border transition-all cursor-move"
                        style={{
                          backgroundColor: 'var(--bg-tertiary)',
                          borderColor: 'var(--border-secondary)',
                          opacity: draggedTask?.id === task.id ? 0.5 : 1
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = 'var(--accent-primary)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = 'var(--border-secondary)';
                        }}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={task.completed}
                            onChange={() => onToggleTask(task.id)}
                            className="mt-1 w-4 h-4 cursor-pointer flex-shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className="flex-1 min-w-0">
                            <p
                              className={`text-sm break-words ${task.completed ? 'line-through' : ''}`}
                              style={{
                                color: task.completed ? 'var(--text-tertiary)' : 'var(--text-primary)'
                              }}
                            >
                              {task.content}
                            </p>
                            <div className="flex items-center justify-between mt-2">
                              <span
                                className="text-xs"
                                style={{ color: 'var(--text-tertiary)' }}
                              >
                                {new Date(task.createdAt).toLocaleDateString()}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteTask(task.id);
                                }}
                                className="h-6 w-6 p-0 hover:bg-destructive/10 hover:text-destructive"
                              >
                                ×
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Related Objects Display - Only for Doing column */}
                      {column.id === 'doing' && (
                        <div
                          className="mt-3 p-4 rounded-lg border"
                          style={{
                            backgroundColor: 'var(--bg-primary)',
                            borderColor: 'var(--border-secondary)'
                          }}
                        >
                          <h4
                            className="text-xs font-semibold uppercase mb-3"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            Related Items
                          </h4>
                          <div className="space-y-2">
                            {/* Linked Tasks */}
                            <div className="flex items-center gap-2 text-sm">
                              <ClipboardList size={14} style={{ color: 'var(--text-tertiary)' }} />
                              <span style={{ color: 'var(--text-secondary)' }}>
                                No linked tasks
                              </span>
                            </div>

                            {/* Events */}
                            <div className="flex items-center gap-2 text-sm">
                              <Calendar size={14} style={{ color: 'var(--text-tertiary)' }} />
                              <span style={{ color: 'var(--text-secondary)' }}>
                                No events
                              </span>
                            </div>

                            {/* Notes */}
                            <div className="flex items-center gap-2 text-sm">
                              <StickyNote size={14} style={{ color: 'var(--text-tertiary)' }} />
                              <span style={{ color: 'var(--text-secondary)' }}>
                                No notes
                              </span>
                            </div>

                            {/* Add relationship button */}
                            <button
                              className="w-full mt-3 px-3 py-2 rounded-md text-xs font-medium transition-colors"
                              style={{
                                backgroundColor: 'var(--bg-tertiary)',
                                color: 'var(--text-secondary)',
                                border: `1px solid var(--border-secondary)`
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.borderColor = 'var(--accent-primary)';
                                e.currentTarget.style.color = 'var(--accent-primary)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.borderColor = 'var(--border-secondary)';
                                e.currentTarget.style.color = 'var(--text-secondary)';
                              }}
                            >
                              + Add Related Item
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
