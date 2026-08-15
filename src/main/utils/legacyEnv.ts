/**
 * Reads an `EAVES_*` environment variable, falling back to the `ENCLAVE_*`
 * name it used to have.
 *
 * The rename would otherwise silently change behaviour for anyone whose shell
 * profile, CI job or `.env` still sets the old names: the variable would simply
 * read as unset, and the caller would fall through to a default — a QA run
 * quietly using the production registry, say, rather than failing loudly.
 *
 * Deliberately unbounded in time: these are developer-facing knobs, not a
 * persisted format, and there is nothing to gain from making them expire.
 */

const LEGACY_PREFIX = 'ENCLAVE_';
const PREFIX = 'EAVES_';

const warned = new Set<string>();

export function legacyEnv(name: string): string | undefined {
  const current = process.env[name];
  if (current !== undefined) return current;

  if (!name.startsWith(PREFIX)) return undefined;

  const legacyName = LEGACY_PREFIX + name.slice(PREFIX.length);
  const legacy = process.env[legacyName];
  if (legacy === undefined) return undefined;

  if (!warned.has(legacyName)) {
    warned.add(legacyName);
    // console rather than the logger: this is read during logger construction,
    // so using the logger here would be a cycle.
    console.warn(`[env] ${legacyName} is deprecated — rename it to ${name}`);
  }

  return legacy;
}
