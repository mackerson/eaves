import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ConversationsSection } from './sidebar/ConversationsSection';
import { FilesSection } from './sidebar/FilesSection';
import { NotesSection } from './sidebar/NotesSection';
import { TasksSection } from './sidebar/TasksSection';
import { WorkflowsSection } from './sidebar/WorkflowsSection';
import { RoutinesSection } from './sidebar/RoutinesSection';
import { CalendarSection } from './sidebar/CalendarSection';
import { PluginsSection } from './sidebar/PluginsSection';
import { ActivitySection } from './sidebar/ActivitySection';
import { SystemSection } from './sidebar/SystemSection';
import { MemorySection } from './sidebar/MemorySection';
import { useResize } from '@/hooks/useResize';
import { useProjectStore, useUIPreferencesStore, useUIStore } from '@/stores';
import { AppIcon } from '@/components/ui/AppIcon';
import { IconName, iconRegistry } from '@/components/ui/icon-registry';
import './Sidebar.css';

/**
 * Helper to determine if a string is a registered icon name
 */
function isIconName(icon: string): icon is IconName {
  return icon in iconRegistry;
}

export function Sidebar() {
  const isCollapsed = useUIPreferencesStore((s) => s.sidebarCollapsed);
  const setIsCollapsed = useUIPreferencesStore((s) => s.setSidebarCollapsed);
  const toggleSidebar = useUIPreferencesStore((s) => s.toggleSidebar);
  const { size, isResizing, startResize } = useResize({
    initialSize: 280,
    minSize: 200,
    maxSize: 500,
    storageKey: 'sidebar-width',
  });
  const { getCurrentProject } = useProjectStore();
  const { setView, pluginViews } = useUIStore();
  const currentProject = getCurrentProject();

  // Core feature sections
  const coreSectionIcons = [
    { component: ConversationsSection, iconName: 'chat' as IconName, title: 'Conversations', view: 'chats' as const },
    { component: FilesSection, iconName: 'files' as IconName, title: 'Files', view: 'files' as const },
    { component: NotesSection, iconName: 'notes' as IconName, title: 'Notes', view: 'notes' as const },
    { component: TasksSection, iconName: 'tasks' as IconName, title: 'Tasks', view: 'tasks' as const },
    { component: WorkflowsSection, iconName: 'workflows' as IconName, title: 'Workflows', view: 'workflows' as const },
    { component: RoutinesSection, iconName: 'routines' as IconName, title: 'Routines', view: 'routines' as const },
    { component: CalendarSection, iconName: 'calendar' as IconName, title: 'Calendar', view: 'calendar' as const },
    { component: ActivitySection, iconName: 'activity' as IconName, title: 'Activity', view: 'activity' as const },
    { component: SystemSection, iconName: 'system' as IconName, title: 'System', view: 'system' as const },
    { component: MemorySection, iconName: 'memory' as IconName, title: 'Memory', view: 'memory' as const },
    { component: PluginsSection, iconName: 'plugins' as IconName, title: 'Plugins', view: 'plugins' as const },
  ];

  return (
    <>
      <aside
        className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}
        style={{ width: isCollapsed ? '0px' : `${size}px` }}
      >
        <div className="sidebar-header">
          {currentProject && (
            <button
              className="project-name-btn"
              onClick={() => setView('dashboard')}
              title="View project dashboard"
            >
              <h2 className="project-name">{currentProject.name}</h2>
            </button>
          )}
          <button
            className="sidebar-collapse-btn"
            onClick={toggleSidebar}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>
        <div className="sidebar-content">
          <ConversationsSection />
          <FilesSection />
          <NotesSection />
          <TasksSection />
          <WorkflowsSection />
          <RoutinesSection />
          <CalendarSection />
          <ActivitySection />
          <SystemSection />
          <MemorySection />
          <PluginsSection />
        </div>
        {!isCollapsed && (
          <div
            className="sidebar-resize-handle"
            onMouseDown={startResize}
            style={{ cursor: isResizing ? 'col-resize' : 'col-resize' }}
          />
        )}
      </aside>
      {isCollapsed && (
        <div className="sidebar-collapsed-icons">
          <button
            className="sidebar-icon-btn sidebar-icon-collapse-btn"
            onClick={() => setIsCollapsed(false)}
            title="Expand Sidebar"
          >
            <ChevronRight size={14} />
          </button>
          <div className="sidebar-icons-divider" />

          {/* Core feature icons */}
          {coreSectionIcons.map(({ iconName, title, view }) => (
            <button
              key={title}
              className="sidebar-icon-btn"
              onClick={() => {
                setView(view);
                setIsCollapsed(false);
              }}
              title={title}
            >
              <AppIcon name={iconName} size={20} />
            </button>
          ))}

          {/* Separator before plugins */}
          {pluginViews.length > 0 && (
            <div className="sidebar-icons-divider" />
          )}

          {/* Plugin view icons */}
          {pluginViews.map((plugin) => (
            <button
              key={plugin.id}
              className="sidebar-icon-btn"
              onClick={() => {
                setView(plugin.id as any);
                setIsCollapsed(false);
              }}
              title={plugin.title}
            >
              {plugin.icon && isIconName(plugin.icon) ? (
                <AppIcon name={plugin.icon} size={20} />
              ) : plugin.icon ? (
                plugin.icon
              ) : (
                <AppIcon name="plugins" size={20} />
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
