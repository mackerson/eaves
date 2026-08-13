/**
 * Service Bridge
 *
 * Bridges the ServiceRegistry for cross-plugin communication with sandboxed plugins.
 * Services are registered with method names, and calls are proxied through workers.
 */

import { getServiceRegistry, ServiceProviderInfo } from '../ServiceRegistry';
import { PluginWorker } from './PluginWorker';
import { SerializableValue } from './types';
import { sanitizeForSerialization } from './protocol';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

interface ServiceMetadata {
  version?: string;
  features?: string[];
  [key: string]: unknown;
}

interface RegisteredService {
  pluginId: string;
  serviceType: string;
  methodNames: string[];
  metadata: ServiceMetadata;
  worker: PluginWorker;
}

// ============================================================================
// Service Bridge Class
// ============================================================================

/**
 * ServiceBridge manages service registrations for sandboxed plugins
 */
export class ServiceBridge {
  private services = new Map<string, RegisteredService>(); // `${serviceType}:${pluginId}` -> registration
  private pluginServices = new Map<string, Set<string>>(); // pluginId -> service keys
  private workers = new Map<string, PluginWorker>(); // pluginId -> worker

  /**
   * Register a worker with the bridge
   */
  registerWorker(pluginId: string, worker: PluginWorker): void {
    this.workers.set(pluginId, worker);
    logger.debug(`[ServiceBridge] Registered worker for plugin ${pluginId}`);
  }

  /**
   * Unregister a worker and cleanup services
   */
  unregisterWorker(pluginId: string): void {
    this.workers.delete(pluginId);
    this.cleanupPlugin(pluginId);
    logger.debug(`[ServiceBridge] Unregistered worker for plugin ${pluginId}`);
  }

  /**
   * Register a service from a plugin
   */
  registerService(
    pluginId: string,
    serviceType: string,
    methodNames: string[],
    metadata: ServiceMetadata = {}
  ): void {
    const worker = this.workers.get(pluginId);
    if (!worker) {
      logger.warn(
        `[ServiceBridge] Cannot register service: worker ${pluginId} not found`
      );
      return;
    }

    const key = `${serviceType}:${pluginId}`;

    // Store registration
    const registration: RegisteredService = {
      pluginId,
      serviceType,
      methodNames,
      metadata,
      worker,
    };
    this.services.set(key, registration);

    // Track by plugin
    if (!this.pluginServices.has(pluginId)) {
      this.pluginServices.set(pluginId, new Set());
    }
    this.pluginServices.get(pluginId)!.add(key);

    // Create proxy API for the ServiceRegistry
    const proxyApi: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const methodName of methodNames) {
      proxyApi[methodName] = async (...args: unknown[]): Promise<unknown> => {
        return this.callServiceMethod(serviceType, pluginId, methodName, args);
      };
    }

    // Register with the main ServiceRegistry
    const serviceRegistry = getServiceRegistry();
    serviceRegistry.register(pluginId, serviceType, proxyApi, metadata);

    logger.info(
      `[ServiceBridge] Registered service '${serviceType}' from plugin ${pluginId} with methods: ${methodNames.join(', ')}`
    );
  }

  /**
   * Unregister a service
   */
  unregisterService(pluginId: string, serviceType: string): boolean {
    const key = `${serviceType}:${pluginId}`;
    const registration = this.services.get(key);

    if (!registration) return false;

    this.services.delete(key);

    const pluginServiceSet = this.pluginServices.get(pluginId);
    if (pluginServiceSet) {
      pluginServiceSet.delete(key);
      if (pluginServiceSet.size === 0) {
        this.pluginServices.delete(pluginId);
      }
    }

    // Unregister from main ServiceRegistry
    const serviceRegistry = getServiceRegistry();
    serviceRegistry.unregister(pluginId, serviceType);

    logger.info(
      `[ServiceBridge] Unregistered service '${serviceType}' from plugin ${pluginId}`
    );
    return true;
  }

  /**
   * Call a service method
   */
  async callServiceMethod(
    serviceType: string,
    providerPluginId: string,
    methodName: string,
    args: unknown[]
  ): Promise<SerializableValue> {
    const key = `${serviceType}:${providerPluginId}`;
    const registration = this.services.get(key);

    if (!registration) {
      throw new Error(
        `Service '${serviceType}' from plugin ${providerPluginId} not found`
      );
    }

    if (!registration.methodNames.includes(methodName)) {
      throw new Error(
        `Method '${methodName}' not found on service '${serviceType}'`
      );
    }

    if (!registration.worker.isRunning()) {
      throw new Error(
        `Plugin ${providerPluginId} is not running, cannot call service method`
      );
    }

    logger.debug(
      `[ServiceBridge] Calling ${serviceType}.${methodName} on ${providerPluginId}`
    );

    // Execute the method in the worker via tool execution
    // The worker stores service methods as tools with prefix "service:"
    const toolName = `service:${serviceType}:${methodName}`;
    const result = await registration.worker.executeTool(toolName, {
      args: args.map((arg) => sanitizeForSerialization(arg)),
    });

    return result;
  }

  /**
   * Discover services (delegate to ServiceRegistry)
   */
  discover(serviceType: string): ServiceProviderInfo[] {
    const serviceRegistry = getServiceRegistry();
    return serviceRegistry.discover(serviceType);
  }

  /**
   * Get service method names
   */
  getServiceMethods(
    serviceType: string,
    providerPluginId: string
  ): string[] | null {
    const key = `${serviceType}:${providerPluginId}`;
    const registration = this.services.get(key);
    return registration?.methodNames ?? null;
  }

  /**
   * Check if a service has providers
   */
  hasProviders(serviceType: string): boolean {
    const serviceRegistry = getServiceRegistry();
    return serviceRegistry.hasProviders(serviceType);
  }

  /**
   * Get default provider for a service type
   */
  getDefaultProvider(serviceType: string): ServiceProviderInfo | null {
    const serviceRegistry = getServiceRegistry();
    const providers = serviceRegistry.discover(serviceType);
    return providers.length > 0 ? providers[0] : null;
  }

  /**
   * Call method on default provider
   */
  async callDefault(
    serviceType: string,
    methodName: string,
    ...args: unknown[]
  ): Promise<SerializableValue> {
    const defaultProvider = this.getDefaultProvider(serviceType);
    if (!defaultProvider) {
      throw new Error(`No providers found for service '${serviceType}'`);
    }

    return this.callServiceMethod(
      serviceType,
      defaultProvider.pluginId,
      methodName,
      args
    );
  }

  /**
   * Get all services for a plugin
   */
  getPluginServices(pluginId: string): string[] {
    const keys = this.pluginServices.get(pluginId);
    if (!keys) return [];

    const serviceTypes: string[] = [];
    for (const key of keys) {
      const [serviceType] = key.split(':');
      serviceTypes.push(serviceType);
    }
    return serviceTypes;
  }

  /**
   * Cleanup all services for a plugin
   */
  cleanupPlugin(pluginId: string): number {
    const keys = this.pluginServices.get(pluginId);
    if (!keys) return 0;

    const serviceRegistry = getServiceRegistry();
    let count = 0;

    for (const key of keys) {
      const registration = this.services.get(key);
      if (registration) {
        serviceRegistry.unregister(pluginId, registration.serviceType);
        this.services.delete(key);
        count++;
      }
    }

    this.pluginServices.delete(pluginId);

    logger.debug(`[ServiceBridge] Cleaned up ${count} services for ${pluginId}`);
    return count;
  }

  /**
   * Get total service count
   */
  get totalServices(): number {
    return this.services.size;
  }

  /**
   * Clear all services
   */
  clear(): void {
    const serviceRegistry = getServiceRegistry();

    for (const registration of this.services.values()) {
      serviceRegistry.unregister(registration.pluginId, registration.serviceType);
    }

    this.services.clear();
    this.pluginServices.clear();
    logger.debug('[ServiceBridge] Cleared all services');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let serviceBridgeInstance: ServiceBridge | null = null;

/**
 * Get the global ServiceBridge instance
 */
export function getServiceBridge(): ServiceBridge {
  if (!serviceBridgeInstance) {
    serviceBridgeInstance = new ServiceBridge();
  }
  return serviceBridgeInstance;
}

/**
 * Reset the global ServiceBridge instance (for testing)
 */
export function resetServiceBridge(): void {
  if (serviceBridgeInstance) {
    serviceBridgeInstance.clear();
  }
  serviceBridgeInstance = null;
}
