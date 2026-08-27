/**
 * What a draft will actually be able to do, read off its own source.
 *
 * The bench used to render a draft's permissions as the manifest declared
 * them — a comma-separated list of ids, in the one place whose entire job is
 * helping a person decide whether to install agent-written code. A declared
 * grant is a claim, and the three ways a claim goes wrong all matter here:
 *
 *   - **Declared and used.** The ordinary case. Worth showing *which* calls,
 *     because "writes messages" and "writes messages by calling
 *     context.data.messages.create twice" are different amounts of trust.
 *   - **Declared and never called.** Not dangerous, but it is a grant the user
 *     is being asked to approve for nothing, and the agent should take it out.
 *   - **Called and never declared.** A live bug: PermissionGate denies it at
 *     runtime. The agent finds out when the plugin throws; this finds out
 *     before it runs.
 *
 * This reads text, not an AST. It matches call paths against the same
 * PERMISSION_REQUIREMENTS table the gate enforces, so it cannot drift from the
 * runtime — but a path inside a comment or a string literal counts, and a
 * dynamically-built call (`context[ns][method]()`) does not. It is a reading
 * aid on the way to the code, never a substitute for it, and the UI says so.
 */

import { PERMISSION_REQUIREMENTS } from './sandbox/PermissionGate';
import {
  INERT_PERMISSIONS,
  UNGATED_PERMISSIONS,
  ELEVATED_PERMISSIONS,
  permissionLabel,
} from '../../shared/pluginPermissions';
import type { DraftFile } from './pluginDraftService';

export type CapabilityStatus = 'used' | 'declared-unused' | 'inert';
export type CapabilityGating = 'gated' | 'ungated' | 'inert';

export interface DraftCapability {
  permission: string;
  /** Plain English, from the same table the consent dialog reads. */
  label: string;
  status: CapabilityStatus;
  gating: CapabilityGating;
  elevated: boolean;
  /** The calls found in the source that need this grant. */
  calls: string[];
}

export interface UndeclaredCall {
  call: string;
  /** Grants the manifest would have to add for this call to be allowed. */
  requires: string[];
  file: string;
}

export interface DraftAnalysis {
  capabilities: DraftCapability[];
  /** Calls PermissionGate will deny, because nothing declared them. */
  undeclared: UndeclaredCall[];
}

/**
 * Namespaces sit at different depths on the plugin context — storage lives
 * under `utils`, everything else is top-level — and the RPC key does not
 * record that. Mirrors CONTEXT_PATH in pluginApiCatalog.ts.
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
  return `${base}.${rest.join('.')}`;
}

/**
 * Match on the tail of the call, not the whole path.
 *
 * `const { data } = context` is idiomatic and would defeat an exact
 * `context.data.…` match, so what is searched for is the part that has to be
 * written out either way — `data.agents.getAll(` — regardless of what the
 * context object was named or whether it was destructured at all.
 */
function callAppears(source: string, rpcKey: string): boolean {
  const tail = rpcKey.replace(/\./g, '\\s*\\.\\s*');
  return new RegExp(`\\b${tail}\\s*\\(`).test(source);
}

/**
 * The two grants nothing in PERMISSION_REQUIREMENTS unlocks. A plugin holding
 * them does not go through the gate at all — it calls `fetch` or `require('fs')`
 * itself — so "is it used" has to be asked of the source directly.
 */
const UNGATED_SIGNALS: Record<string, RegExp[]> = {
  'network:http': [
    /\bfetch\s*\(/,
    /require\s*\(\s*['"](?:node:)?(?:http|https)['"]\s*\)/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\s*\(/,
  ],
  'system:filesystem': [
    /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/,
    /\bfs\s*\.\s*(?:promises|readFile|writeFile|readdir|mkdir|rm|unlink|stat)/,
    /\b(?:readFileSync|writeFileSync|readdirSync|mkdirSync|rmSync|unlinkSync)\s*\(/,
  ],
};

/**
 * Which calls each file makes, as text. Comments and string literals are not
 * stripped: doing it badly is worse than not doing it, and the cost of a false
 * positive here is a line of prose pointing at code the reader can go read.
 */
function findCalls(files: DraftFile[]): Map<string, { requires: string[]; file: string }> {
  const found = new Map<string, { requires: string[]; file: string }>();
  for (const file of files) {
    for (const [rpcKey, requires] of Object.entries(PERMISSION_REQUIREMENTS)) {
      if (found.has(rpcKey)) continue;
      if (callAppears(file.content, rpcKey)) {
        found.set(rpcKey, { requires: requires as string[], file: file.path });
      }
    }
  }
  return found;
}

function usesUngated(permission: string, files: DraftFile[]): boolean {
  const signals = UNGATED_SIGNALS[permission];
  if (!signals) return false;
  return files.some(file => signals.some(signal => signal.test(file.content)));
}

export function analyseDraft(declared: string[], files: DraftFile[]): DraftAnalysis {
  const calls = findCalls(files);
  const declaredSet = new Set(declared);

  const capabilities: DraftCapability[] = declared.map(permission => {
    if (INERT_PERMISSIONS.has(permission)) {
      return {
        permission,
        label: permissionLabel(permission),
        status: 'inert' as const,
        gating: 'inert' as const,
        elevated: false,
        calls: [],
      };
    }

    if (UNGATED_PERMISSIONS.has(permission)) {
      return {
        permission,
        label: permissionLabel(permission),
        status: usesUngated(permission, files) ? ('used' as const) : ('declared-unused' as const),
        gating: 'ungated' as const,
        elevated: ELEVATED_PERMISSIONS.has(permission),
        calls: [],
      };
    }

    const used = [...calls.entries()]
      .filter(([, meta]) => meta.requires.includes(permission))
      .map(([rpcKey]) => toCallPath(rpcKey))
      .sort();

    return {
      permission,
      label: permissionLabel(permission),
      status: used.length ? ('used' as const) : ('declared-unused' as const),
      gating: 'gated' as const,
      elevated: ELEVATED_PERMISSIONS.has(permission),
      calls: used,
    };
  });

  // A call whose grants are not ALL declared is denied — the gate requires
  // every entry in the requirements list, not any of them.
  const undeclared: UndeclaredCall[] = [...calls.entries()]
    .filter(([, meta]) => meta.requires.some(p => !declaredSet.has(p)))
    .map(([rpcKey, meta]) => ({
      call: toCallPath(rpcKey),
      requires: meta.requires.filter(p => !declaredSet.has(p)),
      file: meta.file,
    }))
    .sort((a, b) => a.call.localeCompare(b.call));

  return { capabilities, undeclared };
}
