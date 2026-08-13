import { useProjectStore } from '@/stores';
import { useUIStore } from '@/stores';
import { ChartColumn, CircleCheck, StickyNote, Zap, MessageSquare, Folder } from 'lucide-react';

export function ProjectDashboard() {
  const { getCurrentProject, tasks, notes } = useProjectStore();
  const { setView } = useUIStore();
  const project = getCurrentProject();

  if (!project) {
    return (
      <div className="p-8 text-center">
        <div className="mb-4 flex justify-center"><ChartColumn size={48} /></div>
        <h2 className="text-2xl font-bold mb-2">No Project Selected</h2>
        <p style={{ color: 'var(--text-secondary)' }}>Select or create a project to view its dashboard</p>
      </div>
    );
  }

  const completedTasks = tasks.filter(t => t.completed).length;
  const totalTasks = tasks.length;
  const taskCompletionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">{project.name}</h1>
        {project.description && (
          <p style={{ color: 'var(--text-secondary)' }} className="mt-1">{project.description}</p>
        )}
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div
          className="p-6 rounded-lg border"
          style={{
            backgroundColor: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)'
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold">Tasks</h3>
            <CircleCheck size={28} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{completedTasks}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>/ {totalTasks}</span>
          </div>
          <div className="mt-2">
            <div
              className="h-2 rounded-full overflow-hidden"
              style={{ backgroundColor: 'var(--bg-tertiary)' }}
            >
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${taskCompletionRate}%`,
                  backgroundColor: 'var(--accent-primary)'
                }}
              />
            </div>
            <p style={{ color: 'var(--text-tertiary)' }} className="text-sm mt-1">
              {taskCompletionRate}% complete
            </p>
          </div>
        </div>

        <div
          className="p-6 rounded-lg border"
          style={{
            backgroundColor: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)'
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold">Notes</h3>
            <StickyNote size={28} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{notes.length}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>notes</span>
          </div>
          <button
            onClick={() => setView('notes')}
            className="mt-2 text-sm transition-colors"
            style={{ color: 'var(--accent-primary)' }}
          >
            View all →
          </button>
        </div>

        <div
          className="p-6 rounded-lg border"
          style={{
            backgroundColor: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)'
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold">Workflows</h3>
            <Zap size={28} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">0</span>
            <span style={{ color: 'var(--text-tertiary)' }}>active</span>
          </div>
          <button
            onClick={() => setView('workflows')}
            className="mt-2 text-sm transition-colors"
            style={{ color: 'var(--accent-primary)' }}
          >
            Manage →
          </button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {([
            { icon: MessageSquare, label: 'Chat', description: 'Start conversation', view: 'channels' as const },
            { icon: CircleCheck, label: 'Tasks', description: 'Manage tasks', view: 'tasks' as const },
            { icon: Zap, label: 'Workflows', description: 'Automate tasks', view: 'workflows' as const },
            { icon: Folder, label: 'Files', description: 'Browse files', view: 'files' as const },
          ]).map(({ icon: Icon, label, description, view }) => (
            <button
              key={view}
              onClick={() => setView(view)}
              className="p-4 rounded-lg border text-left transition-all hover:border-[var(--accent-primary)]"
              style={{
                backgroundColor: 'var(--bg-secondary)',
                borderColor: 'var(--border-primary)'
              }}
            >
              <div className="mb-2"><Icon size={24} /></div>
              <div className="font-medium">{label}</div>
              <div style={{ color: 'var(--text-tertiary)' }} className="text-sm">
                {description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Recent Activity Preview */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Recent Tasks</h2>
          <button
            onClick={() => setView('tasks')}
            className="text-sm transition-colors"
            style={{ color: 'var(--accent-primary)' }}
          >
            View all →
          </button>
        </div>
        {tasks.length === 0 ? (
          <div
            className="p-6 rounded-lg border text-center"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-tertiary)'
            }}
          >
            No tasks yet. Create your first task to get started!
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.slice(0, 5).map((task) => (
              <div
                key={task.id}
                className="p-4 rounded-lg border flex items-center gap-3"
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  borderColor: 'var(--border-primary)'
                }}
              >
                <input
                  type="checkbox"
                  checked={task.completed}
                  readOnly
                  className="w-4 h-4 cursor-pointer"
                />
                <span
                  className={task.completed ? 'line-through' : ''}
                  style={{
                    color: task.completed ? 'var(--text-tertiary)' : 'var(--text-primary)'
                  }}
                >
                  {task.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
