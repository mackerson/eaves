/**
 * What a plugin is allowed to have written into its config.
 *
 * A leaf module on purpose: the rule is the interesting part and it should be
 * testable without standing up the IPC layer's whole import graph.
 */

/**
 * Why the plugin's declared manifest config should refuse this write, or null
 * when it is acceptable.
 *
 * A plugin with no `config` block declares no settings at all, so the only
 * acceptable write is an empty one — otherwise "no schema" would read as "any
 * key allowed", which is backwards.
 *
 * This is a declaration check, not an ownership check. Plugin UI bundles are
 * imported into the renderer and share the whole `window.electron` bridge, so
 * IPC carries no caller identity: nothing here can tell the Settings UI apart
 * from a plugin UI writing a *different* plugin's declared key. What it does
 * close is writes to plugins that are not installed, keys no manifest
 * declares, and values of the wrong declared type.
 */
export function rejectUndeclaredConfig(
  declared: Record<string, { type?: string }> | undefined,
  incoming: Record<string, unknown>,
): string | null {
  const schema = declared ?? {};
  for (const [key, value] of Object.entries(incoming)) {
    const field = schema[key];
    if (!field) {
      return `"${key}" is not a setting this plugin declares`;
    }
    // Unrecognized declared types pass: the manifest format is the plugin
    // author's, and inventing an enforcement rule for a type we don't model
    // would reject valid settings. Unknown *keys* still fail closed above.
    const expected = field.type;
    if (expected === 'string' && typeof value !== 'string') {
      return `"${key}" must be a string`;
    }
    if (expected === 'number' && typeof value !== 'number') {
      return `"${key}" must be a number`;
    }
    if (expected === 'boolean' && typeof value !== 'boolean') {
      return `"${key}" must be a boolean`;
    }
  }
  return null;
}
