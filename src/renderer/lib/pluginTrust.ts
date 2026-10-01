/**
 * The "trusted" mark on user-installed plugins, in one place.
 *
 * It lived inside PluginsView while that was the only surface that installed
 * or removed a plugin. The Marketplace tab now uninstalls too, and trust is
 * keyed by plugin id in localStorage — so an uninstall that forgets to clear
 * it would let a later reinstall of the same id silently inherit the mark.
 * Both surfaces share these helpers so neither can forget differently.
 */

const TRUSTED_PLUGINS_KEY = 'eaves:trustedPlugins';
const LEGACY_TRUSTED_PLUGINS_KEY = 'enclave:trustedPlugins';

export const getTrustedPlugins = (): Set<string> => {
  try {
    // Fall back to the pre-rename key so the profile migration doesn't quietly
    // revoke trust the user already granted. Reading it is safe: it is the same
    // profile and the same user's decision, only under the old name.
    const stored =
      localStorage.getItem(TRUSTED_PLUGINS_KEY) ??
      localStorage.getItem(LEGACY_TRUSTED_PLUGINS_KEY);
    return new Set(stored ? JSON.parse(stored) : []);
  } catch {
    return new Set();
  }
};

export const saveTrustedPlugins = (plugins: Set<string>): void => {
  localStorage.setItem(TRUSTED_PLUGINS_KEY, JSON.stringify([...plugins]));
  // Drop the legacy key once we've written the new one, so a later revoke
  // can't be undone by the fallback read above resurrecting stale trust.
  localStorage.removeItem(LEGACY_TRUSTED_PLUGINS_KEY);
};

/** Drop one id from the stored trust set (uninstall bookkeeping). */
export const revokeTrustedPlugin = (pluginId: string): void => {
  const trusted = getTrustedPlugins();
  if (!trusted.has(pluginId)) return;
  trusted.delete(pluginId);
  saveTrustedPlugins(trusted);
};
