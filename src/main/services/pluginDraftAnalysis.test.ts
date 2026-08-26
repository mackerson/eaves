/**
 * The bench asks this module what a draft can do, and a person decides whether
 * to install agent-written code based on the answer. The cases that matter are
 * the three ways a declared permission and the actual source disagree.
 */
import { describe, it, expect } from 'vitest';
import { analyseDraft } from './pluginDraftAnalysis';

const file = (content: string, path = 'index.cjs') => ({ path, content });

describe('analyseDraft', () => {
  it('reports a declared grant the code actually calls, and names the call', () => {
    const result = analyseDraft(
      ['data:agents:read'],
      [file('module.exports = { activate: (c) => c.data.agents.getAll() };')],
    );

    expect(result.capabilities).toEqual([
      {
        permission: 'data:agents:read',
        label: 'Read your agents',
        status: 'used',
        gating: 'gated',
        elevated: false,
        calls: ['context.data.agents.getAll'],
      },
    ]);
    expect(result.undeclared).toEqual([]);
  });

  // Not dangerous, but it is a grant the user is asked to approve for nothing.
  it('flags a grant that is declared and never called', () => {
    const result = analyseDraft(
      ['storage:write'],
      [file('module.exports = { activate: () => {} };')],
    );

    expect(result.capabilities[0]).toMatchObject({
      permission: 'storage:write',
      status: 'declared-unused',
      calls: [],
    });
  });

  // The live bug: PermissionGate denies this at runtime, so the plugin throws
  // the first time that path runs. Better to say so before it is activated.
  it('flags a call the manifest never declared', () => {
    const result = analyseDraft(
      ['data:agents:read'],
      [file('c.actions.createTask({ title: "x" });', 'lib/tasks.cjs')],
    );

    expect(result.undeclared).toEqual([
      { call: 'context.actions.createTask', requires: ['data:tasks:write'], file: 'lib/tasks.cjs' },
    ]);
  });

  // `const { data } = context` is idiomatic and would defeat a `context.`-anchored
  // match, so the tail is what gets searched for.
  it('finds a call through a destructured context', () => {
    const result = analyseDraft(
      ['data:chats:read'],
      [file('const { data } = context;\nconst all = await data.chats.getAll();')],
    );

    expect(result.capabilities[0].status).toBe('used');
  });

  it('tolerates whitespace inside the call path', () => {
    const result = analyseDraft(
      ['storage:read'],
      [file('await context.utils.storage\n  .get("k");')],
    );

    expect(result.capabilities[0].status).toBe('used');
  });

  // network:http and system:filesystem unlock nothing in PERMISSION_REQUIREMENTS.
  // A plugin holding them reaches out directly, so "is it used" has to be asked
  // of the source — and the surface has to say the grant is a label, not a gate.
  it('reads the ungated grants off direct Node and network use', () => {
    const result = analyseDraft(
      ['network:http', 'system:filesystem'],
      [file('const fs = require("node:fs");\nawait fetch("https://example.com");')],
    );

    expect(result.capabilities).toEqual([
      {
        permission: 'network:http',
        label: 'Make network requests',
        status: 'used',
        gating: 'ungated',
        elevated: true,
        calls: [],
      },
      {
        permission: 'system:filesystem',
        label: 'Read and write files on your computer',
        status: 'used',
        gating: 'ungated',
        elevated: true,
        calls: [],
      },
    ]);
  });

  it('does not claim an ungated grant is used when nothing reaches for it', () => {
    const result = analyseDraft(['network:http'], [file('module.exports = {};')]);
    expect(result.capabilities[0]).toMatchObject({ status: 'declared-unused', gating: 'ungated' });
  });

  // A coarse alias is legal in a manifest and matches nothing in the sandbox.
  // Showing it beside a real grant would describe access it does not confer.
  it('marks a coarse alias inert rather than pretending it grants something', () => {
    const result = analyseDraft(
      ['data:read'],
      [file('c.data.agents.getAll();')],
    );

    expect(result.capabilities[0]).toMatchObject({ status: 'inert', gating: 'inert', calls: [] });
    // ...and the real call it makes is still reported as undeclared, because
    // the alias does not cover it.
    expect(result.undeclared).toEqual([
      { call: 'context.data.agents.getAll', requires: ['data:agents:read'], file: 'index.cjs' },
    ]);
  });

  it('searches every file, not just the entry', () => {
    const result = analyseDraft(
      ['ui:notifications:show'],
      [file('module.exports = require("./toast.cjs");'), file('c.ui.showToast("hi");', 'toast.cjs')],
    );

    expect(result.capabilities[0].status).toBe('used');
    expect(result.undeclared).toEqual([]);
  });

  it('returns nothing to say for a draft that declares nothing', () => {
    expect(analyseDraft([], [file('module.exports = {};')])).toEqual({
      capabilities: [],
      undeclared: [],
    });
  });
});
