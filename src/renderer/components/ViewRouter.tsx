import { useUIStore, useAgentStore } from '@/stores';
import { getPluginComponent } from '@/components/plugins/PluginViewRegistry';
import { ChannelView } from '@/views/ChannelView';
import { ChatsView } from '@/views/ChatsView';
import { TasksView } from '@/views/TasksView';
import { NotesView } from '@/views/NotesView';
import { AgentsView } from '@/views/AgentsView';
import { ProjectsView } from '@/views/ProjectsView';
import { SettingsView } from '@/views/SettingsView';
import { PluginsView } from '@/views/PluginsView';
import { ImportsView } from '@/views/ImportsView';
import { WorkflowsView } from '@/views/WorkflowsView';
import { FilesView } from '@/views/FilesView';
import { CalendarView } from '@/views/CalendarView';
import { RoutinesView } from '@/views/RoutinesView';
import { ActivityView } from '@/views/ActivityView';
import { MemoryView } from '@/views/MemoryView';
import { ProjectDashboard } from '@/views/ProjectDashboard';
import { PluginImportView } from '@/views/PluginImportView';
import { AgentEditorView } from '@/views/AgentEditorView';

const simpleViews: Record<string, React.ComponentType> = {
  chats: ChatsView,
  tasks: TasksView,
  notes: NotesView,
  agents: AgentsView,
  projects: ProjectsView,
  workflows: WorkflowsView,
  files: FilesView,
  calendar: CalendarView,
  routines: RoutinesView,
  activity: ActivityView,
  memory: MemoryView,
  dashboard: ProjectDashboard,
};

export function ViewRouter({ loadMemory }: { loadMemory: () => Promise<void> }) {
  const { view, pluginViews, editingAgentIdForView, setView } = useUIStore();
  const { agents } = useAgentStore();

  // Simple views with no props
  const SimpleView = simpleViews[view];
  if (SimpleView) return <SimpleView />;

  if (view === 'channels') {
    return <ChannelView />;
  }

  if (view === 'agent-editor') {
    return (
      <AgentEditorView
        agentId={editingAgentIdForView || undefined}
        agents={agents}
        onClose={() => setView('agents')}
        onSave={loadMemory}
      />
    );
  }

  if (view === 'settings') {
    // SettingsView is self-contained now — each section reads/writes its own
    // slice of settings via useSettingsStore, auto-saving on change/blur.
    return <SettingsView />;
  }

  if (view === 'plugins') return <PluginsView onNavigateToView={setView} />;
  if (view === 'imports') return <ImportsView onNavigateToView={setView} />;

  if (view === 'chatgpt-import') return <PluginImportView pluginId="chatgpt-import" />;
  if (view === 'character-card-import') return <PluginImportView pluginId="character-card-import" />;

  // Plugin views
  const pluginView = pluginViews.find(pv => pv.id === view);
  if (pluginView) {
    const PluginComponent = getPluginComponent(
      pluginView.component,
      (pluginView as any).pluginId,
      (pluginView as any).uiMetadata,
      (pluginView as any).folderName,
      (pluginView as any).source
    );

    if (!PluginComponent) {
      return (
        <div className="p-8">
          <h2 className="text-2xl font-bold text-destructive">Plugin Error</h2>
          <p className="text-muted-foreground mt-2">
            Component "{pluginView.component}" not found in registry.
          </p>
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <PluginComponent />
      </div>
    );
  }

  return null;
}
