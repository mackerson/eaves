import { useEffect } from 'react';
import { useToastStore } from '@/stores';

/**
 * PluginHotReload listens for plugin hot reload events from the main process
 * and shows toast notifications to the user.
 *
 * This provides visual feedback when new plugins are detected, built, and loaded
 * during development - making the "Claude Code builds Enclave" demo possible.
 */
export const PluginHotReload = () => {
  const showToast = useToastStore((state) => state.showToast);

  useEffect(() => {
    // Listen for plugin events from main process
    const handleDetected = ({ pluginId }: { pluginId: string }) => {
      showToast(`🔍 New plugin detected: ${pluginId}`, 'info', 2000);
    };

    const handleBuilding = ({ pluginId }: { pluginId: string }) => {
      showToast(`🔨 Building ${pluginId}...`, 'info', 0); // Duration 0 = stays until manually removed
    };

    const handleLoaded = ({ pluginId }: { pluginId: string }) => {
      showToast(`✨ Plugin ready: ${pluginId}!`, 'success', 5000);

      // Note: Intentionally not auto-navigating - could be disruptive if user is working
      // Toast notification is sufficient; user can navigate manually via sidebar
    };

    const handleError = ({ pluginId, error }: { pluginId: string; error: string }) => {
      showToast(`❌ Failed to load ${pluginId}: ${error}`, 'error', 8000);
    };

    // Register event listeners
    window.electron.on('plugin:detected', handleDetected);
    window.electron.on('plugin:building', handleBuilding);
    window.electron.on('plugin:loaded', handleLoaded);
    window.electron.on('plugin:error', handleError);

    // Cleanup listeners on unmount
    return () => {
      window.electron.off('plugin:detected', handleDetected);
      window.electron.off('plugin:building', handleBuilding);
      window.electron.off('plugin:loaded', handleLoaded);
      window.electron.off('plugin:error', handleError);
    };
  }, [showToast]);

  // This component doesn't render anything - it just handles side effects
  return null;
};
