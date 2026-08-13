import { describe, it, expect } from 'vitest';
import {
  ARCHETYPES,
  ARCHETYPE_TYPES,
  CAPABILITY_GRANTS,
  DEFAULT_ARCHETYPE_TYPE,
  SELECTABLE_ARCHETYPES,
  getArchetype,
  isArchetypeType,
} from './archetypes';
import type { AgentArchetype } from './types';

describe('archetype registry', () => {
  it('covers every stored ArchetypeType exactly once', () => {
    const types = ARCHETYPES.map((a) => a.type);
    expect(new Set(types).size).toBe(types.length);
    // Mirror of the type union — the Record keying enforces this at compile time;
    // this asserts it at runtime too so a stray addition is caught.
    expect(new Set(types)).toEqual(
      new Set(['task-oriented', 'exploratory', 'autonomous', 'shadow', 'custom', 'roleplay']),
    );
  });

  it('has exactly one default, and it is the standard non-autonomous type', () => {
    const defaults = ARCHETYPES.filter((a) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].type).toBe(DEFAULT_ARCHETYPE_TYPE);
    expect(getArchetype(DEFAULT_ARCHETYPE_TYPE)?.legacy).toBeFalsy();
  });

  it('excludes legacy archetypes from the fresh-choice picker', () => {
    expect(SELECTABLE_ARCHETYPES.every((a) => !a.legacy)).toBe(true);
    // roleplay + shadow have real behavior and must be selectable; the legacy
    // trio must not be.
    const selectable = new Set(SELECTABLE_ARCHETYPES.map((a) => a.type));
    expect(selectable.has('roleplay')).toBe(true);
    expect(selectable.has('shadow')).toBe(true);
    expect(selectable.has('exploratory')).toBe(false);
    expect(selectable.has('autonomous')).toBe(false);
    expect(selectable.has('custom')).toBe(false);
  });

  it('resolves ids and rejects unknowns', () => {
    expect(getArchetype('shadow')?.label).toBe('Shadow');
    expect(getArchetype('nope')).toBeUndefined();
    expect(isArchetypeType('roleplay')).toBe(true);
    expect(isArchetypeType('nope')).toBe(false);
    expect(ARCHETYPE_TYPES).toContain('shadow');
  });

  it('shadow declares its leadAgentId conditional field', () => {
    const shadow = getArchetype('shadow');
    const field = shadow?.fields?.find((f) => f.key === 'leadAgentId');
    expect(field).toBeDefined();
    expect(field?.control.kind).toBe('agent-ref');
    if (field?.control.kind === 'agent-ref') {
      expect(field.control.excludeSelf).toBe(true);
      expect(field.control.excludeArchetypes).toContain('shadow');
    }
  });

  it('roleplay records its behavior seams', () => {
    const roleplay = getArchetype('roleplay');
    expect(roleplay?.behaviors?.clearsDefaultTools).toBe(true);
    expect(roleplay?.behaviors?.promptNote).toBe('roleplay');
    expect(roleplay?.behaviors?.perChatField).toBe('userPersona');
  });

  it('grant metadata maps to real AgentArchetype boolean fields', () => {
    const archetypeKeys: Array<keyof AgentArchetype> = [
      'allowScheduling',
      'allowSelfModification',
      'allowGoalSetting',
      'enableReflection',
    ];
    for (const meta of CAPABILITY_GRANTS) {
      expect(archetypeKeys).toContain(meta.field);
    }
    // self-modification is the dangerous grant — presets must never auto-enable it.
    const selfMod = CAPABILITY_GRANTS.find((g) => g.grant === 'self-modification');
    expect(selfMod?.dangerous).toBe(true);
  });

  it('never presets a dangerous grant to true (fail-closed)', () => {
    const dangerous = new Set(
      CAPABILITY_GRANTS.filter((g) => g.dangerous).map((g) => g.grant),
    );
    for (const a of ARCHETYPES) {
      for (const [grant, on] of Object.entries(a.grantProfile ?? {})) {
        if (dangerous.has(grant as never)) expect(on).not.toBe(true);
      }
    }
  });
});
