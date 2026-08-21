/**
 * What an agent needs to know before it can write a plugin.
 *
 * The expensive failure mode for a model authoring against an API it cannot
 * see is blind probing: it guesses a method name, guesses a permission, and
 * burns turns discovering both were wrong. This module answers those questions
 * up front, and answers them from the code rather than from prose that drifts:
 * the callable surface and its grants are derived from `PERMISSION_REQUIREMENTS`
 * (sandbox/PermissionGate.ts), which is the same table the runtime enforces.
 *
 * Deliberately not an AST walk over the whole plugin API — that is the fuller
 * version and it can replace the body of `describePluginApi()` without moving
 * this module's contract. What is here is the part that pays for itself now.
 */

import { PERMISSION_REQUIREMENTS } from './sandbox/PermissionGate';
import type { PluginPermission } from '../../shared/types';

export interface PluginApiMethod {
  /** How the plugin calls it, e.g. `context.data.agents.getAll()`. */
  call: string;
  /** Grants the manifest must declare for the call to be allowed. */
  requires: PluginPermission[];
}

export interface PluginApiCatalog {
  methods: PluginApiMethod[];
  /** Every grant that appears on some method, with what it unlocks. */
  permissions: Array<{ permission: PluginPermission; unlocks: string[] }>;
  entryShape: string;
  uiShape: string;
  notes: string[];
}

/**
 * Namespaces live at different depths on the plugin context: storage sits
 * under `utils`, everything else is top-level. The RPC key does not record
 * that, so the mapping is stated once here.
 */
const CONTEXT_PATH: Record<string, string> = {
  data: 'context.data',
  actions: 'context.actions',
  ui: 'context.ui',
  events: 'context.events',
  tools: 'context.tools',
  services: 'context.services',
  storage: 'context.utils.storage',
};

function toCallPath(rpcKey: string): string {
  const [namespace, ...rest] = rpcKey.split('.');
  const base = CONTEXT_PATH[namespace] ?? `context.${namespace}`;
  return `${base}.${rest.join('.')}()`;
}

const ENTRY_SHAPE = `// plugin.json declares "entry": "index.cjs"
// The entry is CommonJS and runs in a worker thread, not the renderer.
module.exports = {
  activate(context) {
    // register everything here
  },
  deactivate(context) {
    // release anything activate() took; called on disable, reload and retract
  },
};`;

const UI_SHAPE = `// plugin.json declares:
//   "ui": { "entry": "ui/index.js", "components": { "MyView": "named" } }
// The bundle is a plain ES module. React is externalized — import it, do not
// bundle it — and there is no build step: this file is served as written.
import React, { useState } from '/node_modules/react';

export function MyView() {
  const [n, setN] = useState(0);
  return React.createElement('button', { onClick: () => setN(n + 1) }, \`count \${n}\`);
}`;

const NOTES = [
  'Declare only the permissions you actually call. A grant you do not use is a grant the user has to read and approve for nothing.',
  'A tool registered with context.tools.register becomes available to agents on the NEXT turn — the toolset is assembled once per turn.',
  'deactivate() must undo what activate() did. A draft is unloaded and reloaded every time it is re-activated, so a leaked listener accumulates.',
  'The entry file is CommonJS (module.exports). The UI bundle is an ES module (export). They are different files with different module systems.',
  'A draft never appears in the sidebar, even if it registers a view — unconsented UI does not get to share the main window with the dialog that approves it.',
  'Drafts live only until they are retracted or Eaves restarts. Nothing is installed and nothing survives a restart.',
];

/** The full catalog. Pure — it reads module-level tables, nothing live. */
export function describePluginApi(): PluginApiCatalog {
  const methods: PluginApiMethod[] = Object.entries(PERMISSION_REQUIREMENTS)
    .map(([rpcKey, requires]) => ({ call: toCallPath(rpcKey), requires }))
    .sort((a, b) => a.call.localeCompare(b.call));

  const unlockedBy = new Map<PluginPermission, string[]>();
  for (const { call, requires } of methods) {
    for (const permission of requires) {
      const list = unlockedBy.get(permission) ?? [];
      list.push(call);
      unlockedBy.set(permission, list);
    }
  }

  const permissions = [...unlockedBy.entries()]
    .map(([permission, unlocks]) => ({ permission, unlocks }))
    .sort((a, b) => a.permission.localeCompare(b.permission));

  return { methods, permissions, entryShape: ENTRY_SHAPE, uiShape: UI_SHAPE, notes: NOTES };
}
