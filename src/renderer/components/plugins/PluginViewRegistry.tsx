import React, { useState, useEffect } from 'react';
import { loadPluginComponent, type PluginComponentMetadata } from '@/services/DynamicPluginLoader';
import type { PluginUIMetadata } from '@/types';

/**
 * Runtime registry for dynamically loaded components
 */
const DynamicComponentRegistry: Record<string, React.ComponentType<any>> = {};

/**
 * Register a dynamically loaded component
 */
export function registerDynamicComponent(componentName: string, component: React.ComponentType<any>) {
  DynamicComponentRegistry[componentName] = component;
}

/**
 * Dynamic Plugin Loader Component
 * Async wrapper that loads plugin UI bundles on demand
 */
function DynamicPluginLoader({
  pluginId,
  componentName,
  uiMetadata,
  folderName,
  source,
  ...passThroughProps
}: {
  pluginId: string;
  componentName: string;
  uiMetadata: PluginUIMetadata;
  folderName?: string;
  source?: string;
  [key: string]: any;
}) {
  const [Component, setComponent] = useState<React.ComponentType<any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if already loaded in dynamic registry
    if (DynamicComponentRegistry[componentName]) {
      setComponent(() => DynamicComponentRegistry[componentName]);
      setLoading(false);
      return;
    }

    // Resolve the bundle URL by where the plugin actually lives — which is what
    // `source` records, so it is checked before `isDev`. A marketplace install
    // lives in userData under its full-id folder name (com-enclave-webview),
    // which the dev server's /plugins/ root has no entry for; resolving it there
    // 404s. The plugin:// scheme is registered unconditionally, so it serves
    // userData in dev and packaged alike. See protocols/pluginBundle.ts.
    // - 'user'    (userData/plugins): plugin://
    // - 'dev'     (repo plugins/ symlinks): served by Vite from the root
    // - 'bundled': dev → Vite; packaged → relative to dist/renderer
    const isDev = import.meta.env.DEV;
    const pathSegment = folderName || pluginId;
    const pluginPath = source === 'user'
      ? `plugin://${pathSegment}/${uiMetadata.entry}`
      : source === 'dev' || isDev
        ? `/plugins/${pathSegment}/${uiMetadata.entry}`
        : `../../plugins/${pathSegment}/${uiMetadata.entry}`;

    const metadata: PluginComponentMetadata = {
      pluginId,
      componentName,
      exportType: uiMetadata.components[componentName] || 'named',
      path: pluginPath,
    };

    loadPluginComponent(metadata)
      .then((loadedComponent) => {
        registerDynamicComponent(componentName, loadedComponent);
        setComponent(() => loadedComponent);
        setLoading(false);
      })
      .catch((err) => {
        console.error(`Failed to load plugin component: ${componentName}`, err);
        setError(err.message);
        setLoading(false);
      });
  }, [pluginId, componentName, uiMetadata, folderName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground animate-pulse">
        Loading plugin view...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <span className="text-2xl mb-2">⚠️</span>
        <h3 className="font-semibold text-destructive mb-1">Failed to load plugin</h3>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  return Component ? <Component {...passThroughProps} /> : null;
}

/**
 * Get a plugin component by name.
 *
 * Resolution order: the dynamic registry (already-loaded bundles), then a
 * lazy loader for a not-yet-loaded plugin bundle. There is no built-in
 * component table — a name that matches neither is not renderable here.
 *
 * @param componentName - Name of the component to load
 * @param pluginId - Plugin ID (optional, required for dynamic loading)
 * @param uiMetadata - UI metadata from plugin manifest (for dynamic loading)
 * @returns React component or null
 */
export function getPluginComponent(
  componentName: string,
  pluginId?: string | undefined,
  uiMetadata?: PluginUIMetadata | undefined,
  folderName?: string | undefined,
  source?: string | undefined
): React.ComponentType<any> | null {
  // Check dynamic registry first (already loaded)
  if (DynamicComponentRegistry[componentName]) {
    return DynamicComponentRegistry[componentName];
  }

  // Check if this should be dynamically loaded
  if (uiMetadata && pluginId) {
    // Return a lazy loader component
    return (props: any) => (
      <DynamicPluginLoader
        pluginId={pluginId}
        componentName={componentName}
        uiMetadata={uiMetadata}
        folderName={folderName}
        source={source}
        {...props}
      />
    );
  }

  // No bundle to load from: caller must render its own fallback.
  return null;
}
