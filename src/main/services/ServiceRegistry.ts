/**
 * ServiceRegistry - Cross-plugin service discovery and communication
 *
 * Enables plugins to register services they provide and discover services
 * from other plugins. This is the foundation for composable plugin ecosystems.
 *
 * Example use case: Memory processors can discover memory backends and store
 * data without knowing which backend is available.
 */

import { logger } from './logger';
import { eventBus } from './EventBus';

/**
 * Service API - methods exposed by a service provider
 */
export interface ServiceAPI {
  [method: string]: (...args: any[]) => any | Promise<any>;
}

/**
 * Metadata about a service's capabilities
 */
export interface ServiceMetadata {
  version?: string;
  features?: string[];
  /**
   * A fallback provider is a built-in floor (e.g. the core default
   * memory-backend). It only holds the default slot while no real provider
   * exists; the first non-fallback provider to register claims the default,
   * and a fallback never displaces a non-fallback. Lets core register a floor
   * at startup that plugins still override when they load later.
   */
  isFallback?: boolean;
  [key: string]: any;
}

/**
 * A registered service instance
 */
export interface ServiceRegistration {
  pluginId: string;
  serviceType: string;
  api: ServiceAPI;
  metadata: ServiceMetadata;
  registeredAt: number;
}

/**
 * Service provider info (safe to expose, no API methods)
 */
export interface ServiceProviderInfo {
  pluginId: string;
  serviceType: string;
  metadata: ServiceMetadata;
  registeredAt: number;
}

/**
 * ServiceRegistry manages service registration, discovery, and invocation
 * across plugins. Each service type can have multiple providers.
 */
export class ServiceRegistry {
  // Map of serviceType -> Map of pluginId -> ServiceRegistration
  private services: Map<string, Map<string, ServiceRegistration>> = new Map();

  // Track default providers for each service type
  private defaultProviders: Map<string, string> = new Map();

  constructor() {
    logger.info('[ServiceRegistry] Initialized');
  }

  /**
   * Register a service provided by a plugin
   *
   * @param pluginId - The plugin providing the service
   * @param serviceType - The type of service (e.g., 'memory-backend')
   * @param api - The service API methods
   * @param metadata - Optional metadata about the service
   */
  register(
    pluginId: string,
    serviceType: string,
    api: ServiceAPI,
    metadata: ServiceMetadata = {}
  ): void {
    if (!this.services.has(serviceType)) {
      this.services.set(serviceType, new Map());
    }

    const providers = this.services.get(serviceType)!;

    // Check if this plugin already provides this service
    if (providers.has(pluginId)) {
      logger.warn(`[ServiceRegistry] Plugin ${pluginId} is re-registering service ${serviceType}`);
    }

    const registration: ServiceRegistration = {
      pluginId,
      serviceType,
      api,
      metadata,
      registeredAt: Date.now(),
    };

    providers.set(pluginId, registration);

    // Default-provider selection. A fallback provider (the core floor) only
    // holds the default while nothing else does; a real (non-fallback) provider
    // claims the default even if a fallback currently holds it, but never
    // displaces another real provider. This is what lets core register a floor
    // at startup that a later-loading plugin still overrides.
    const currentDefaultId = this.defaultProviders.get(serviceType);
    if (!currentDefaultId) {
      this.defaultProviders.set(serviceType, pluginId);
    } else if (!metadata.isFallback) {
      const currentDefault = providers.get(currentDefaultId);
      if (currentDefault?.metadata.isFallback) {
        this.defaultProviders.set(serviceType, pluginId);
      }
    }

    logger.info(`[ServiceRegistry] Registered service: ${serviceType} from ${pluginId}`, { metadata });

    // Emit event for interested listeners
    eventBus.emitEvent('service:registered', {
      pluginId,
      serviceType,
      metadata,
    });
  }

  /**
   * Unregister a service (called when plugin is unloaded)
   */
  unregister(pluginId: string, serviceType: string): void {
    const providers = this.services.get(serviceType);
    if (!providers) return;

    if (providers.has(pluginId)) {
      providers.delete(pluginId);
      logger.info(`[ServiceRegistry] Unregistered service: ${serviceType} from ${pluginId}`);

      // If this was the default provider, pick a new one — prefer a real
      // provider over the fallback floor so unloading one plugin backend hands
      // off to another plugin rather than dropping to core.
      if (this.defaultProviders.get(serviceType) === pluginId) {
        const remaining = Array.from(providers.values());
        const next = remaining.find(r => !r.metadata.isFallback) ?? remaining[0];
        if (next) {
          this.defaultProviders.set(serviceType, next.pluginId);
        } else {
          this.defaultProviders.delete(serviceType);
        }
      }

      // Clean up empty service type maps
      if (providers.size === 0) {
        this.services.delete(serviceType);
      }

      eventBus.emitEvent('service:unregistered', {
        pluginId,
        serviceType,
      });
    }
  }

  /**
   * Unregister all services from a plugin (called when plugin is unloaded)
   */
  unregisterAll(pluginId: string): void {
    for (const [serviceType, providers] of this.services.entries()) {
      if (providers.has(pluginId)) {
        this.unregister(pluginId, serviceType);
      }
    }
  }

  /**
   * Discover all providers for a service type
   * Returns info about providers (not the actual APIs)
   */
  discover(serviceType: string): ServiceProviderInfo[] {
    const providers = this.services.get(serviceType);
    if (!providers) return [];

    return Array.from(providers.values()).map(reg => ({
      pluginId: reg.pluginId,
      serviceType: reg.serviceType,
      metadata: reg.metadata,
      registeredAt: reg.registeredAt,
    }));
  }

  /**
   * Get all registered service types
   */
  getServiceTypes(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get a specific service provider's API
   * Returns null if the provider doesn't exist
   */
  get(serviceType: string, pluginId: string): ServiceAPI | null {
    const providers = this.services.get(serviceType);
    if (!providers) return null;

    const registration = providers.get(pluginId);
    return registration?.api || null;
  }

  /**
   * Get the default provider for a service type
   */
  getDefault(serviceType: string): ServiceRegistration | null {
    const defaultPluginId = this.defaultProviders.get(serviceType);
    if (!defaultPluginId) return null;

    const providers = this.services.get(serviceType);
    return providers?.get(defaultPluginId) || null;
  }

  /**
   * Set the default provider for a service type
   */
  setDefault(serviceType: string, pluginId: string): boolean {
    const providers = this.services.get(serviceType);
    if (!providers || !providers.has(pluginId)) {
      logger.warn(`[ServiceRegistry] Cannot set default: ${pluginId} doesn't provide ${serviceType}`);
      return false;
    }

    this.defaultProviders.set(serviceType, pluginId);
    logger.info(`[ServiceRegistry] Set default provider for ${serviceType}: ${pluginId}`);
    return true;
  }

  /**
   * Call a method on the default provider for a service type
   * Convenience method for simple service invocation
   */
  async call<T = any>(
    serviceType: string,
    method: string,
    ...args: any[]
  ): Promise<T> {
    const registration = this.getDefault(serviceType);
    if (!registration) {
      throw new Error(`No provider available for service type: ${serviceType}`);
    }

    const api = registration.api;
    if (typeof api[method] !== 'function') {
      throw new Error(`Method ${method} not found on service ${serviceType} from ${registration.pluginId}`);
    }

    return api[method](...args);
  }

  /**
   * Check if a service type has any providers
   */
  hasProviders(serviceType: string): boolean {
    const providers = this.services.get(serviceType);
    return providers !== undefined && providers.size > 0;
  }

  /**
   * Get count of providers for a service type
   */
  getProviderCount(serviceType: string): number {
    const providers = this.services.get(serviceType);
    return providers?.size || 0;
  }

  /**
   * Get all registrations (for debugging/admin)
   */
  getAllRegistrations(): ServiceProviderInfo[] {
    const all: ServiceProviderInfo[] = [];
    for (const providers of this.services.values()) {
      for (const reg of providers.values()) {
        all.push({
          pluginId: reg.pluginId,
          serviceType: reg.serviceType,
          metadata: reg.metadata,
          registeredAt: reg.registeredAt,
        });
      }
    }
    return all;
  }

  /**
   * Clear all registrations (for testing or shutdown)
   */
  clear(): void {
    this.services.clear();
    this.defaultProviders.clear();
    logger.info('[ServiceRegistry] Cleared all registrations');
  }
}

// Singleton instance
let serviceRegistry: ServiceRegistry | null = null;

/**
 * Get the global ServiceRegistry instance
 */
export function getServiceRegistry(): ServiceRegistry {
  if (!serviceRegistry) {
    serviceRegistry = new ServiceRegistry();
  }
  return serviceRegistry;
}
