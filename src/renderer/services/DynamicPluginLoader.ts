/**
 * Dynamic Plugin Loader
 * Loads plugin UI components dynamically from bundled JavaScript files
 */

export interface PluginComponentMetadata {
  pluginId: string;
  componentName: string;
  exportType: 'default' | 'named';
  path: string; // Path to the bundle file
}

export interface LoadedPluginComponent {
  component: React.ComponentType<any>;
  metadata: PluginComponentMetadata;
}

/**
 * Cache for loaded plugin components
 * Prevents re-loading the same component multiple times
 */
const componentCache = new Map<string, LoadedPluginComponent>();

/**
 * Load a plugin component dynamically from its bundle
 *
 * @param metadata - Plugin component metadata
 * @returns Promise that resolves to the loaded React component
 */
export async function loadPluginComponent(
  metadata: PluginComponentMetadata
): Promise<React.ComponentType<any>> {
  const cacheKey = `${metadata.pluginId}:${metadata.componentName}`;

  // Check cache first
  if (componentCache.has(cacheKey)) {
    return componentCache.get(cacheKey)!.component;
  }

  try {

    // Dynamic import of the plugin bundle
    // Note: path must be relative to the dist directory
    const module = await import(/* @vite-ignore */ metadata.path);

    // Get the component based on export type
    let component = metadata.exportType === 'default'
      ? module.default
      : module[metadata.componentName];

    // Fallback: a declared named export can go missing if a plugin's manifest
    // component name drifts from its actual bundle exports (e.g. the bundle
    // exports `FooComponent`/`default` but the manifest still asks for `Foo`).
    // When the named lookup misses but the bundle has a usable default export,
    // use it rather than hard-failing the whole view.
    if (!component && metadata.exportType === 'named' && typeof module.default === 'function') {
      console.warn(
        `[Plugin Loader] Named export "${metadata.componentName}" not found in "${metadata.pluginId}"; ` +
        `falling back to the bundle's default export.`
      );
      component = module.default;
    }

    if (!component) {
      throw new Error(
        `Component "${metadata.componentName}" not found in plugin bundle. ` +
        `Export type: ${metadata.exportType}`
      );
    }

    // Validate that it's a React component (has render or is a function)
    if (typeof component !== 'function') {
      throw new Error(
        `Loaded module for "${metadata.componentName}" is not a valid React component`
      );
    }

    // Cache the component
    const loaded: LoadedPluginComponent = {
      component,
      metadata,
    };
    componentCache.set(cacheKey, loaded);

    return component;

  } catch (error) {
    console.error(`[Plugin Loader] Failed to load plugin component: ${cacheKey}`, error);
    throw new Error(
      `Failed to load plugin component "${metadata.componentName}" from "${metadata.pluginId}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Clear the component cache
 * Useful for hot-reload during development
 */
export function clearPluginCache(pluginId?: string) {
  if (pluginId) {
    // Clear cache for specific plugin
    const keys = Array.from(componentCache.keys()).filter((key) =>
      key.startsWith(`${pluginId}:`)
    );
    keys.forEach((key) => componentCache.delete(key));
  } else {
    // Clear all cache
    componentCache.clear();
  }
}

/**
 * Get all loaded plugin components
 */
export function getLoadedComponents(): PluginComponentMetadata[] {
  return Array.from(componentCache.values()).map((loaded) => loaded.metadata);
}

/**
 * Check if a component is loaded
 */
export function isComponentLoaded(pluginId: string, componentName: string): boolean {
  const cacheKey = `${pluginId}:${componentName}`;
  return componentCache.has(cacheKey);
}
