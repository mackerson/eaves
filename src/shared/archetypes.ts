/**
 * Agent archetype registry — the single source the editor renders for the
 * "Autonomy" section, and the extension point archetypes grow through.
 *
 * An archetype is a *kind* of agent: a preset bundle of metadata, conditional
 * config fields, and (suggested) capability grants. The set is built-in, but
 * the contract is shaped so a plugin permission (`agents:register-archetype`)
 * could contribute more without changing consumers.
 *
 * Design invariants:
 * - The registry is *additive*. The behavior seams (`ShadowService`,
 *   `buildRoleplayNote`) key off `archetype.type` string literals that match
 *   these ids; this registry drives UI/metadata, it does not replace them.
 * - Capability grants are a fixed, core-owned vocabulary (`CAPABILITY_GRANTS`).
 *   An archetype's `grantProfile` is a *suggestion* — a consumer applies
 *   non-dangerous grants but must require an explicit user toggle for any grant
 *   flagged `dangerous`, fail-closed. This keeps a plugin-contributed archetype
 *   from silently widening the capability boundary.
 * - Archetypes with no differentiated runtime behavior are marked `legacy` and
 *   surfaced honestly ("behaves as Standard") rather than offered as fresh,
 *   functional choices.
 */

import type { AgentArchetype, ArchetypeType } from './types';

// ── Capability grants ───────────────────────────────────────────────────────

/** Core-owned capability vocabulary. Maps 1:1 to the boolean fields on `AgentArchetype`. */
export type CapabilityGrant =
  | 'scheduling'
  | 'self-modification'
  | 'goal-setting'
  | 'reflection';

export interface CapabilityGrantMeta {
  grant: CapabilityGrant;
  label: string;
  description: string;
  /** Storage key on `AgentArchetype` backing this grant. */
  field: 'allowScheduling' | 'allowSelfModification' | 'allowGoalSetting' | 'enableReflection';
  /**
   * Requires a deliberate user opt-in. An archetype's `grantProfile` may
   * *suggest* a dangerous grant, but a consumer must never auto-enable one from
   * a preset — fail closed.
   */
  dangerous?: boolean;
}

export const CAPABILITY_GRANTS: readonly CapabilityGrantMeta[] = [
  {
    grant: 'scheduling',
    field: 'allowScheduling',
    label: 'Allow scheduling',
    description: 'Act across time — schedule its own future actions.',
  },
  {
    grant: 'self-modification',
    field: 'allowSelfModification',
    label: 'Allow self-modification',
    description: 'Request changes to its own configuration.',
    dangerous: true,
  },
  {
    grant: 'goal-setting',
    field: 'allowGoalSetting',
    label: 'Allow goal-setting',
    description: 'Set and pursue long-term goals.',
  },
  {
    grant: 'reflection',
    field: 'enableReflection',
    label: 'Enable reflection',
    description: 'Periodic self-reflection.',
  },
];

// ── Archetype-declared conditional fields ───────────────────────────────────

/**
 * A field an archetype owns and the editor renders below the picker when that
 * archetype is selected. Generalizes the one-off "Lead agent only when Shadow"
 * into a data-driven schema so new archetypes declare their own fields.
 */
export type ArchetypeFieldControl =
  | {
      kind: 'agent-ref';
      excludeSelf?: boolean;
      excludeArchetypes?: ArchetypeType[];
      /** Label for the "no reference / applies broadly" choice (empty value). */
      nullLabel?: string;
      /** Label for the "pick a specific agent" choice. */
      valueLabel?: string;
    }
  | { kind: 'text'; maxLength?: number; placeholder?: string }
  | { kind: 'textarea'; maxLength?: number; placeholder?: string }
  | { kind: 'toggle' }
  | { kind: 'select'; options: ReadonlyArray<{ value: string; label: string }> };

export interface ArchetypeFieldSpec {
  /**
   * Where the value is stored. Built-in archetype fields map to a typed key on
   * `AgentArchetype` (e.g. `leadAgentId`). The key is widened to `string` so a
   * plugin-contributed archetype could store into its own params bag; core
   * archetypes should always use a typed key.
   */
  key: keyof AgentArchetype | string;
  label: string;
  description?: string;
  required?: boolean;
  control: ArchetypeFieldControl;
}

// ── Archetype definitions ───────────────────────────────────────────────────

export interface ArchetypeDefinition {
  type: ArchetypeType;
  label: string;
  /** lucide icon name (the redesign is lucide-only — store the name, not a glyph). */
  icon: string;
  /** One-line summary for the picker. */
  summary: string;
  /** Longer help shown when the archetype is selected in the editor. */
  description?: string;
  /**
   * The standard, non-autonomous default. Selecting a non-default archetype is
   * what flips the agent's opt-in autonomy module on.
   */
  isDefault?: boolean;
  /**
   * Behavior-inert: the id is stored on existing agents but drives no
   * differentiated runtime behavior. Surfaced honestly ("behaves as Standard")
   * and excluded from the fresh-choice picker, so users can't pick something
   * that does nothing. Flip off when real behavior + enforcement land.
   */
  legacy?: boolean;
  /** Conditional agent-config fields this archetype owns. */
  fields?: readonly ArchetypeFieldSpec[];
  /**
   * Suggested capability-grant preset. SUGGESTION ONLY — see `CAPABILITY_GRANTS`:
   * consumers apply non-dangerous grants but must require explicit confirmation
   * for any `dangerous` grant.
   */
  grantProfile?: Partial<Record<CapabilityGrant, boolean>>;
  /** Behavior seams this archetype drives, recorded for reference/traceability. */
  behaviors?: {
    /** Starts new chats with no default tools (roleplay). */
    clearsDefaultTools?: boolean;
    /** Injects a built-in prompt note (e.g. the roleplay persona note). */
    promptNote?: 'roleplay';
    /** Observed by a background service (shadow event extraction). */
    backgroundService?: 'shadow';
    /** Exposes a per-chat field surfaced outside the editor (roleplay `userPersona`). */
    perChatField?: 'userPersona';
  };
}

/**
 * Keyed by `ArchetypeType` so the compiler enforces registry coverage — a new
 * archetype id in `types.ts` that isn't defined here is a build error. Order
 * here is the picker order (insertion order is preserved by `Object.values`).
 */
const ARCHETYPE_MAP: Record<ArchetypeType, ArchetypeDefinition> = {
  'task-oriented': {
    type: 'task-oriented',
    label: 'Standard agent',
    icon: 'bot',
    isDefault: true,
    summary: 'General-purpose agent. The default.',
    description: 'A general-purpose assistant with the autonomy module off. Most agents are this.',
  },
  roleplay: {
    type: 'roleplay',
    label: 'Roleplay',
    icon: 'venetian-mask',
    summary: 'In-character; starts with no tools and a clean prompt.',
    description:
      "Roleplay agents start with no tools and a clean system prompt. The agent's description carries the character; a per-chat persona slot lets users name who they're playing.",
    behaviors: { clearsDefaultTools: true, promptNote: 'roleplay', perChatField: 'userPersona' },
  },
  shadow: {
    type: 'shadow',
    label: 'Shadow',
    icon: 'eye',
    summary: 'Background observer — extracts memory from events.',
    description:
      'Shadow agents observe events in the background and act on what they see. Memory extraction is the default — leave the system prompt empty for it. Watch one lead agent or all conversations.',
    behaviors: { backgroundService: 'shadow' },
    fields: [
      {
        key: 'leadAgentId',
        label: 'Watches',
        description:
          'Scope the shadow to one agent, or leave empty to observe all conversations system-wide.',
        control: {
          kind: 'agent-ref',
          excludeSelf: true,
          excludeArchetypes: ['shadow'],
          nullLabel: 'All conversations',
          valueLabel: 'A specific agent',
        },
      },
    ],
  },
  // ── Legacy: valid stored ids with no differentiated behavior. ──
  exploratory: {
    type: 'exploratory',
    label: 'Exploratory',
    icon: 'compass',
    legacy: true,
    summary: 'Legacy — behaves as Standard.',
  },
  autonomous: {
    type: 'autonomous',
    label: 'Autonomous',
    icon: 'workflow',
    legacy: true,
    summary: 'Legacy — behaves as Standard.',
  },
  custom: {
    type: 'custom',
    label: 'Custom',
    icon: 'sliders-horizontal',
    legacy: true,
    summary: 'Legacy — behaves as Standard.',
  },
};

export const ARCHETYPES: readonly ArchetypeDefinition[] = Object.values(ARCHETYPE_MAP);

export const ARCHETYPE_TYPES: readonly ArchetypeType[] = ARCHETYPES.map((a) => a.type);

/** The standard, non-autonomous default. */
export const DEFAULT_ARCHETYPE_TYPE: ArchetypeType = 'task-oriented';

/** Archetypes offered as fresh choices in the editor (excludes legacy). */
export const SELECTABLE_ARCHETYPES: readonly ArchetypeDefinition[] = ARCHETYPES.filter(
  (a) => !a.legacy,
);

export function getArchetype(type: string): ArchetypeDefinition | undefined {
  return ARCHETYPE_MAP[type as ArchetypeType];
}

export function isArchetypeType(type: string): type is ArchetypeType {
  return type in ARCHETYPE_MAP;
}
