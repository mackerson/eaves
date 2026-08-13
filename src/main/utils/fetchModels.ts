import { getProviderAdapter, FetchModelsResult } from '../services/providers';

export type { FetchModelsResult } from '../services/providers';

/**
 * Fetch available models from a provider's API.
 *
 * Thin wrapper over the provider adapter registry — the actual per-provider
 * logic (HTTP endpoints, response parsing, URL normalization) lives in
 * src/main/services/providers.ts.
 */
export async function fetchModelsForProvider(
  provider: string,
  options: { apiKey?: string; baseURL?: string } = {},
): Promise<FetchModelsResult> {
  const adapter = getProviderAdapter(provider);
  if (!adapter) {
    return { success: false, error: 'Model fetching not supported for this provider' };
  }
  return adapter.fetchModels(options);
}
