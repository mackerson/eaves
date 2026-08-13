import { useUIStore } from '@/stores';
import { AppIcon } from '@/components/ui/AppIcon';
import { iconRegistry, type IconName } from '@/components/ui/icon-registry';
import { CollapsibleSection } from './CollapsibleSection';

/**
 * Helper to determine if a string is a registered icon name
 */
function isIconName(icon: string): icon is IconName {
  return icon in iconRegistry;
}

export function PluginsSection() {
  const { pluginViews, setView } = useUIStore();

  const handleViewPlugins = () => {
    setView('plugins');
  };

  return (
    <CollapsibleSection
      title="Plugins"
      onTitleClick={handleViewPlugins}
      isExpandedByDefault={pluginViews.length > 0}
    >
      {pluginViews.length === 0 ? (
        <div className="section-empty">
          No plugin views available
        </div>
      ) : (
        <div className="section-list">
          {pluginViews.map((plugin) => (
            <button
              key={plugin.id}
              className="section-item"
              onClick={() => setView(plugin.id as any)}
            >
              {plugin.icon && isIconName(plugin.icon) ? (
                <AppIcon name={plugin.icon} size={16} className="item-icon" />
              ) : plugin.icon ? (
                <span className="item-icon">{plugin.icon}</span>
              ) : (
                <AppIcon name="plugins" size={16} className="item-icon" />
              )}
              <span className="item-label">{plugin.title}</span>
            </button>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
