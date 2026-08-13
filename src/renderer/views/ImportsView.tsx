import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/stores';

interface ImportPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  type: string;
  enabled: boolean;
  hasView?: boolean;
  viewId?: string;
}

interface ImportsViewProps {
  onNavigateToView?: (viewId: string) => void;
}

export function ImportsView({ onNavigateToView }: ImportsViewProps) {
  const [importPlugins, setImportPlugins] = useState<ImportPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const showToast = useToastStore((state) => state.showToast);

  const loadImportPlugins = async () => {
    try {
      const allPlugins = await window.electron.getPlugins();
      // Filter for import-type plugins
      const imports = allPlugins.filter((p: ImportPlugin) => p.type === 'import');
      setImportPlugins(imports);
    } catch (error) {
      console.error('Failed to load import plugins:', error);
      showToast('Failed to load import plugins', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadImportPlugins();
  }, []);

  const handleTogglePlugin = async (pluginId: string, currentlyEnabled: boolean) => {
    try {
      if (currentlyEnabled) {
        await window.electron.disablePlugin(pluginId);
        showToast(`Import plugin disabled`, 'success');
      } else {
        await window.electron.enablePlugin(pluginId);
        showToast(`Import plugin enabled`, 'success');
      }
      await loadImportPlugins();
    } catch (error: any) {
      console.error('Failed to toggle plugin:', error);
      showToast(error.message || 'Failed to toggle plugin', 'error');
    }
  };

  const handleOpenImporter = (viewId: string) => {
    if (onNavigateToView) {
      onNavigateToView(viewId);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="text-muted-foreground">Loading import plugins...</div>
      </div>
    );
  }

  return (
    <div className="p-8 overflow-y-auto">
      <div className="mb-6">
        <h2 className="text-3xl font-semibold">Imports</h2>
        <p className="text-muted-foreground mt-2">
          Import conversations and data from other platforms
        </p>
      </div>

      <div className="max-w-4xl space-y-4">
        {importPlugins.map((plugin) => (
          <div
            key={plugin.id}
            className="border border-border rounded-lg p-6 bg-card hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h4 className="text-xl font-medium">{plugin.name}</h4>
                  <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                    v{plugin.version}
                  </span>
                  {plugin.enabled ? (
                    <span className="text-xs text-green-600 dark:text-green-400 px-2 py-1 bg-green-100 dark:bg-green-900/30 rounded">
                      Enabled
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                      Disabled
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {plugin.description}
                </p>
              </div>
              <div className="flex items-center gap-2 ml-4">
                {plugin.enabled && plugin.hasView && plugin.viewId && (
                  <Button
                    onClick={() => handleOpenImporter(plugin.viewId!)}
                  >
                    Start Import
                  </Button>
                )}
                <Button
                  variant={plugin.enabled ? "outline" : "default"}
                  size="sm"
                  onClick={() => handleTogglePlugin(plugin.id, plugin.enabled)}
                >
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </Button>
              </div>
            </div>
          </div>
        ))}

        {importPlugins.length === 0 && (
          <div className="text-center py-12 border border-dashed border-border rounded-lg">
            <p className="text-muted-foreground mb-4">No import plugins installed</p>
            <p className="text-sm text-muted-foreground">
              Visit the Plugin Marketplace to discover import plugins for ChatGPT, Anthropic, Character Cards, and more
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
