import { useState, useEffect } from 'react';
import { getPluginComponent } from '../components/plugins/PluginViewRegistry';
import { useUIStore } from '@/stores';

interface PluginImportViewProps {
  pluginId: string;  // This is the view ID (e.g., 'chatgpt-import')
}

interface ImportPluginMeta {
  id: string;         // View ID
  title: string;      // Display name
  icon?: string;
  component: string;  // Component name
  pluginId: string;   // Full plugin ID (e.g., 'com.enclave.chatgpt-import')
  folderName?: string;
  source?: string;
  uiMetadata?: {
    entry: string;
    components: Record<string, 'default' | 'named'>;
  };
  description?: string;
}

export function PluginImportView({ pluginId }: PluginImportViewProps) {
  const [PluginComponent, setPluginComponent] = useState<React.ComponentType<any> | null>(null);
  const [pluginMeta, setPluginMeta] = useState<ImportPluginMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { setView } = useUIStore();

  useEffect(() => {
    const loadPlugin = async () => {
      setLoading(true);
      setError(null);

      try {
        // Fetch import plugin views to find our plugin
        const views = await window.electron.getImportPluginViews();
        const meta = views.find((v: ImportPluginMeta) => v.id === pluginId);

        if (!meta) {
          setError(`Import plugin not found: ${pluginId}`);
          setLoading(false);
          return;
        }

        setPluginMeta(meta);

        // Load the component
        const component = getPluginComponent(
          meta.component,
          meta.pluginId,
          meta.uiMetadata,
          meta.folderName,
          meta.source
        );

        if (!component) {
          setError(`Failed to load component: ${meta.component}`);
          setLoading(false);
          return;
        }

        setPluginComponent(() => component);
        setLoading(false);
      } catch (err: any) {
        setError(`Failed to load plugin: ${err.message}`);
        setLoading(false);
      }
    };

    loadPlugin();
  }, [pluginId]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <span className="text-4xl block mb-4">⚠️</span>
          <p className="text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  if (!pluginMeta || !PluginComponent) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted-foreground">Plugin not available</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="p-8 border-b border-border-primary">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-4xl">{pluginMeta.icon || '📦'}</span>
          <h1 className="text-3xl font-bold">{pluginMeta.title}</h1>
        </div>
        {pluginMeta.description && (
          <p className="text-text-secondary">
            {pluginMeta.description}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto p-8">
        <PluginComponent onNavigate={(view: string) => setView(view as any)} />
      </div>
    </div>
  );
}
