import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useUIStore, useAgentStore } from '@/stores';
import { getPluginComponent } from '@/components/plugins/PluginViewRegistry';
import { ChannelView } from '@/views/ChannelView';
import { ChatsView } from '@/views/ChatsView';
import { AgentsView } from '@/views/AgentsView';
import { ProjectsView } from '@/views/ProjectsView';
import { SettingsView } from '@/views/SettingsView';
import { PluginsView } from '@/views/PluginsView';
import { ImportsView } from '@/views/ImportsView';
import { FilesView } from '@/views/FilesView';
import { RoutinesView } from '@/views/RoutinesView';
import { ActivityView } from '@/views/ActivityView';
import { MemoryView } from '@/views/MemoryView';
import { ProjectDashboard } from '@/views/ProjectDashboard';
import { PluginImportView } from '@/views/PluginImportView';
import { AgentEditorView } from '@/views/AgentEditorView';

/**
 * Views split out of the initial chunk, chosen by what they drag in rather than
 * by how often they're opened:
 *   calendar  — react-big-calendar, and with it lodash, moment, luxon, popper
 *   workflows — the reactflow packages
 *   notes/tasks — dnd-kit
 *
 * Together that's the bulk of the third-party weight that only ever renders on
 * one screen. Everything else stays static: the remaining views are mostly app
 * code, and splitting them would trade parse time for a flash of fallback.
 *
 * Named exports, so each import is mapped onto the default React.lazy expects.
 */
const CalendarView = lazy(() => import('@/views/CalendarView').then(m => ({ default: m.CalendarView })));
const WorkflowsView = lazy(() => import('@/views/WorkflowsView').then(m => ({ default: m.WorkflowsView })));
const NotesView = lazy(() => import('@/views/NotesView').then(m => ({ default: m.NotesView })));
const TasksView = lazy(() => import('@/views/TasksView').then(m => ({ default: m.TasksView })));

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

function ViewLoading() {
  return (
    <div className="flex flex-1 items-center justify-center py-12 text-muted-foreground">
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}

export function ViewRouter({ loadMemory }: { loadMemory: () => Promise<void> }) {
  const { view, pluginViews, editingAgentIdForView, setView } = useUIStore();
  const { agents } = useAgentStore();

  // Simple views with no props. Suspense covers the whole map rather than just
  // the lazy entries — a static view resolves immediately and never suspends,
  // so the boundary costs nothing and survives future entries becoming lazy.
  const SimpleView = simpleViews[view];
  if (SimpleView) {
    return (
      <Suspense fallback={<ViewLoading />}>
        <SimpleView />
      </Suspense>
    );
  }

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
