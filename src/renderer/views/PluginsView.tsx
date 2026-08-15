import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/stores';
import { ConfigurePluginModal } from '@/components/modals/ConfigurePluginModal';
import { ConfirmDialog } from '@/components/modals/ConfirmDialog';
import { AlertTriangle, Shield, ShieldCheck } from 'lucide-react';

interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  type: string;
  enabled: boolean;
  hasView?: boolean;
  viewId?: string;
  source?: 'bundled' | 'user' | 'dev';
}

// Get trusted plugins from localStorage
const getTrustedPlugins = (): Set<string> => {
  try {
    const stored = localStorage.getItem('enclave:trustedPlugins');
    return new Set(stored ? JSON.parse(stored) : []);
  } catch {
    return new Set();
  }
};

// Save trusted plugins to localStorage
const saveTrustedPlugins = (plugins: Set<string>): void => {
  localStorage.setItem('enclave:trustedPlugins', JSON.stringify([...plugins]));
};

interface PluginsViewProps {
  onNavigateToView?: (viewId: string) => void;
}

export function PluginsView({ onNavigateToView }: PluginsViewProps) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [configuringPluginId, setConfiguringPluginId] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<Plugin | null>(null);
  const [trustedPlugins, setTrustedPlugins] = useState<Set<string>>(getTrustedPlugins);
  const showToast = useToastStore((state) => state.showToast);

  const isUserPlugin = (plugin: Plugin) => plugin.source === 'user';
  const isTrusted = (plugin: Plugin) => !isUserPlugin(plugin) || trustedPlugins.has(plugin.id);

  const handleTrustPlugin = (pluginId: string) => {
    const newTrusted = new Set(trustedPlugins);
    newTrusted.add(pluginId);
    setTrustedPlugins(newTrusted);
    saveTrustedPlugins(newTrusted);
    showToast('Plugin marked as trusted', 'success');
  };

  const handleRevokeTrust = (pluginId: string) => {
    const newTrusted = new Set(trustedPlugins);
    newTrusted.delete(pluginId);
    setTrustedPlugins(newTrusted);
    saveTrustedPlugins(newTrusted);
    showToast('Plugin trust revoked', 'success');
  };

  const loadPlugins = async () => {
    try {
      const loadedPlugins = await window.electron.getPlugins();
      setPlugins(loadedPlugins);
    } catch (error) {
      console.error('Failed to load plugins:', error);
      showToast('Failed to load plugins', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlugins();
  }, []);

  const handleTogglePlugin = async (pluginId: string, currentlyEnabled: boolean) => {
    try {
      if (currentlyEnabled) {
        await window.electron.disablePlugin(pluginId);
        showToast(`Plugin disabled`, 'success');
      } else {
        await window.electron.enablePlugin(pluginId);
        showToast(`Plugin enabled`, 'success');
      }
      await loadPlugins();
    } catch (error: any) {
      console.error('Failed to toggle plugin:', error);
      showToast(error.message || 'Failed to toggle plugin', 'error');
    }
  };

  // Only user-source plugins can be uninstalled — bundled ones ship with the
  // app and would reappear on the next launch.
  const handleUninstallPlugin = async (plugin: Plugin) => {
    try {
      const result = await window.electron.uninstallPlugin(plugin.id);
      if (!result?.success) {
        showToast(result?.error || 'Failed to uninstall plugin', 'error');
        return;
      }
      // Trust is keyed by plugin id and outlives the install otherwise, so a
      // later reinstall of the same id would silently inherit it.
      if (trustedPlugins.has(plugin.id)) {
        const remaining = new Set(trustedPlugins);
        remaining.delete(plugin.id);
        setTrustedPlugins(remaining);
        saveTrustedPlugins(remaining);
      }
      showToast(`${plugin.name} uninstalled`, 'success');
      await loadPlugins();
    } catch (error: any) {
      console.error('Failed to uninstall plugin:', error);
      showToast(error.message || 'Failed to uninstall plugin', 'error');
    }
  };

  const handleReloadPlugin = async (pluginId: string) => {
    try {
      await window.electron.reloadPlugin(pluginId);
      showToast('Plugin reloaded', 'success');
      await loadPlugins();
    } catch (error: any) {
      console.error('Failed to reload plugin:', error);
      showToast(error.message || 'Failed to reload plugin', 'error');
    }
  };

  const getPluginTypeIcon = (type: string) => {
    switch (type) {
      case 'tool': return '🔧';
      case 'ui': return '🎨';
      default: return '📦';
    }
  };

  const groupedPlugins = plugins.reduce((acc, plugin) => {
    const category = plugin.type || 'other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(plugin);
    return acc;
  }, {} as Record<string, Plugin[]>);

  if (loading) {
    return (
      <div className="p-8">
        <div className="text-muted-foreground">Loading plugins...</div>
      </div>
    );
  }

  return (
    <div className="p-8 overflow-y-auto">
      <div className="mb-6">
        <h2 className="text-3xl font-semibold">Plugins</h2>
        <p className="text-muted-foreground mt-2">
          Manage installed plugins and their configurations
        </p>
      </div>

      {/* Security Warning for User Plugins */}
      {plugins.some(p => isUserPlugin(p) && !trustedPlugins.has(p.id)) && (
        <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="font-medium text-yellow-800 dark:text-yellow-200">Security Notice</h4>
              <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                User-installed plugins have <strong>full system access</strong> including filesystem, network, and database.
                Only trust plugins from sources you trust. Review untrusted plugins below before enabling them.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-4xl space-y-8">
        {Object.entries(groupedPlugins).map(([category, categoryPlugins]) => (
          <div key={category}>
            <h3 className="text-xl font-semibold mb-4 capitalize flex items-center gap-2">
              {getPluginTypeIcon(category)}
              {category === 'tool' ? 'Tool Plugins' : category === 'ui' ? 'UI Plugins' : 'Other Plugins'}
            </h3>
            <div className="space-y-4">
              {categoryPlugins.map((plugin) => (
                <div
                  key={plugin.id}
                  className={`border rounded-lg p-4 bg-card hover:bg-accent/50 transition-colors ${
                    isUserPlugin(plugin) && !isTrusted(plugin)
                      ? 'border-yellow-400 dark:border-yellow-600'
                      : 'border-border'
                  }`}
                >
                  {/* Untrusted user plugin warning */}
                  {isUserPlugin(plugin) && !isTrusted(plugin) && (
                    <div className="mb-3 p-3 bg-yellow-50 dark:bg-yellow-900/30 rounded-md flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm text-yellow-700 dark:text-yellow-300">
                        <Shield className="w-4 h-4" />
                        <span>This user plugin has not been reviewed. It has full system access.</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTrustPlugin(plugin.id)}
                        className="text-yellow-700 dark:text-yellow-300 border-yellow-400"
                      >
                        <ShieldCheck className="w-4 h-4 mr-1" />
                        Trust
                      </Button>
                    </div>
                  )}
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h4 className="text-lg font-medium">{plugin.name}</h4>
                        <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                          v{plugin.version}
                        </span>
                        {/* Source badge */}
                        {isUserPlugin(plugin) ? (
                          <span className="text-xs px-2 py-1 rounded flex items-center gap-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                            User Plugin
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-1 rounded flex items-center gap-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                            <ShieldCheck className="w-3 h-3" />
                            Bundled
                          </span>
                        )}
                        {plugin.enabled && (
                          <span className="text-xs text-green-600 dark:text-green-400 px-2 py-1 bg-green-100 dark:bg-green-900/30 rounded">
                            Enabled
                          </span>
                        )}
                        {isUserPlugin(plugin) && isTrusted(plugin) && (
                          <span className="text-xs px-2 py-1 rounded flex items-center gap-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                            <ShieldCheck className="w-3 h-3" />
                            Trusted
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-2">
                        {plugin.description}
                      </p>
                      <p className="text-xs text-muted-foreground mt-2">
                        ID: {plugin.id}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {plugin.hasView && plugin.viewId && onNavigateToView && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onNavigateToView(plugin.viewId!)}
                        >
                          Open View
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfiguringPluginId(plugin.id)}
                      >
                        Configure
                      </Button>
                      {plugin.enabled && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReloadPlugin(plugin.id)}
                        >
                          Reload
                        </Button>
                      )}
                      {/* Revoke trust button for trusted user plugins */}
                      {isUserPlugin(plugin) && isTrusted(plugin) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevokeTrust(plugin.id)}
                          title="Revoke trust status"
                        >
                          <Shield className="w-4 h-4" />
                        </Button>
                      )}
                      <Button
                        variant={plugin.enabled ? "destructive" : "default"}
                        size="sm"
                        onClick={() => handleTogglePlugin(plugin.id, plugin.enabled)}
                      >
                        {plugin.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      {isUserPlugin(plugin) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setUninstallTarget(plugin)}
                          title="Remove this plugin from your computer"
                        >
                          Uninstall
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {plugins.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No plugins installed
          </div>
        )}
      </div>

      {/* Configure Plugin Modal */}
      {configuringPluginId && (
        <ConfigurePluginModal
          pluginId={configuringPluginId}
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setConfiguringPluginId(null);
              // Reload plugins list to reflect any changes
              loadPlugins();
            }
          }}
        />
      )}

      {uninstallTarget && (
        <ConfirmDialog
          open={true}
          onOpenChange={(open) => { if (!open) setUninstallTarget(null); }}
          title={`Uninstall ${uninstallTarget.name}?`}
          message={`This removes ${uninstallTarget.name} from your computer, along with its stored data and the permissions you granted it. You can install it again from the Marketplace.`}
          confirmLabel="Uninstall"
          onConfirm={() => {
            const target = uninstallTarget;
            setUninstallTarget(null);
            handleUninstallPlugin(target);
          }}
        />
      )}
    </div>
  );
}
