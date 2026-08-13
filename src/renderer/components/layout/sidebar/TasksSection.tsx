import { useProjectStore, useUIStore } from '@/stores';
import { CollapsibleSection } from './CollapsibleSection';

export function TasksSection() {
  const { tasks, openTaskModal, toggleTask } = useProjectStore();
  const { setView } = useUIStore();

  const activeTasks = tasks.filter(t => !t.completed);
  const handleViewAllTasks = () => {
    setView('tasks');
  };

  const handleActionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openTaskModal();
  };

  return (
    <CollapsibleSection
      title="Tasks"
      badge={activeTasks.length}
      onTitleClick={handleViewAllTasks}
      onActionClick={handleActionClick}
      actionTitle="New Task"
    >
      {tasks.length === 0 ? (
        <div className="section-empty">
          No tasks yet. Click + to create one.
        </div>
      ) : (
        <>
          <div className="section-list">
            {/*
              A div with two real controls inside it, not a checkbox nested in
              a button. That nesting is invalid HTML — interactive content
              cannot contain interactive content — and it only behaved because
              of stopPropagation plus an `(e as any)` cast from a change event
              to a mouse event. Keyboard users got the worst of it: Space or
              Enter on the focused row navigated to the tasks view instead of
              ticking the box, because the button swallowed the activation.
            */}
            {activeTasks.slice(0, 5).map((task) => (
              <div key={task.id} className="section-item task-item">
                <input
                  type="checkbox"
                  checked={task.completed}
                  onChange={() => toggleTask(task.id)}
                  className="task-checkbox"
                  aria-label={`Mark "${task.content}" complete`}
                />
                <button
                  type="button"
                  className="item-label"
                  onClick={handleViewAllTasks}
                  title={task.content}
                >
                  {task.content.slice(0, 30)}
                  {task.content.length > 30 ? '...' : ''}
                </button>
              </div>
            ))}
          </div>
          {activeTasks.length > 5 && (
            <button
              className="section-view-all"
              onClick={handleViewAllTasks}
            >
              View all {activeTasks.length} tasks →
            </button>
          )}
          {activeTasks.length === 0 && tasks.length > 0 && (
            <button
              className="section-view-all"
              onClick={handleViewAllTasks}
            >
              All tasks completed! View {tasks.length} tasks →
            </button>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}
