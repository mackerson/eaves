/**
 * localStorage reads that survive the Enclave -> Eaves rename.
 *
 * The renderer's persisted keys are all prefixed with the product name, so the
 * rename orphaned every one of them: layout, sidebar and compact-mode choices
 * silently reverted on first launch of the renamed build. The profile
 * migration moves the Chromium state across, which means the old keys are
 * still there — they are just under the old name.
 *
 * Reading through here keeps that a one-line change per call site. Writes
 * always go to the new key, so a preference converges the first time it is
 * touched.
 */

const PREFIX = 'eaves';
const LEGACY_PREFIX = 'enclave';

/** The new key's value, falling back to the pre-rename key. */
export function getPersisted(key: string): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;

    if (!key.startsWith(PREFIX)) return null;
    return localStorage.getItem(LEGACY_PREFIX + key.slice(PREFIX.length));
  } catch {
    // localStorage can throw outright when storage is disabled.
    return null;
  }
}
