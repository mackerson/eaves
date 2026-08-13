import { getSettingsRepository } from '../repositories';
import { getProvider, type ProviderId } from '../../shared/providers';

/**
 * Resolve the stored credential for a provider into the {apiKey, baseURL} pair
 * the provider adapters expect.
 *
 * The provider registry's `isLocalEndpoint` flag decides which slot the single
 * stored `apiKeys[id]` string fills: cloud providers treat it as an API key,
 * local providers (Ollama, LM Studio) treat it as a base URL. Adding a new
 * provider is a registry edit — this stays put.
 */
export function resolveProviderCredential(
  provider: string,
  baseURLOverride?: string,
): { apiKey?: string; baseURL?: string } {
  const settings = getSettingsRepository().get();
  const meta = getProvider(provider);
  // settings may be undefined in tests / before initial load — chain through.
  const stored = settings?.apiKeys?.[provider as ProviderId];

  const apiKey = meta?.isLocalEndpoint ? undefined : stored;
  const baseURL = baseURLOverride ?? (meta?.isLocalEndpoint ? stored : undefined);
  return { apiKey, baseURL };
}
