/**
 * The bench is where a person decides whether to install agent-written code.
 * What it says about a draft's access has to be true, and the three ways a
 * declared grant can be untrue each have to look different.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DraftManifest } from './DraftManifest';
import type { PluginDraft } from '@/../shared/types';

const noop = () => {};
const actions = {
  busy: false,
  onPreview: noop, onReadCode: noop, onRun: noop,
  onStop: noop, onKeep: noop, onDiscard: noop,
};

const draft = (overrides: Partial<PluginDraft> = {}): PluginDraft => ({
  id: 'com.alice.dice',
  name: 'Dice Roller',
  version: '0.1.0',
  type: 'tool',
  folderName: 'com-alice-dice',
  permissions: [],
  files: ['index.cjs'],
  running: false,
  analysis: { capabilities: [], undeclared: [] },
  contributions: { tools: [], views: [] },
  ...overrides,
});

const capability = (over: Partial<NonNullable<PluginDraft['analysis']>['capabilities'][number]> = {}) => ({
  permission: 'data:messages:write',
  label: 'Write messages',
  status: 'used' as const,
  gating: 'gated' as const,
  elevated: false,
  calls: ['context.actions.bulkImportMessages'],
  ...over,
});

describe('DraftManifest', () => {
  it('leads with the ask, so the panel says what this build was for', () => {
    render(<DraftManifest draft={draft()} ask="a dice roller for my roleplay chats" {...actions} />);
    expect(screen.getByText(/a dice roller for my roleplay chats/)).toBeTruthy();
  });

  it('names the calls behind a grant, not just the grant', () => {
    render(
      <DraftManifest
        draft={draft({ analysis: { capabilities: [capability()], undeclared: [] } })}
        {...actions}
      />,
    );
    expect(screen.getByText('Write messages')).toBeTruthy();
    expect(screen.getByText(/context\.actions\.bulkImportMessages/)).toBeTruthy();
  });

  it('says out loud when a grant is asked for and never used', () => {
    render(
      <DraftManifest
        draft={draft({
          analysis: { capabilities: [capability({ status: 'declared-unused', calls: [] })], undeclared: [] },
        })}
        {...actions}
      />,
    );
    expect(screen.getByText(/declared, never used/)).toBeTruthy();
  });

  // network:http and system:filesystem unlock nothing in PermissionGate. A
  // surface that renders them like a gated grant describes an enforcement that
  // does not exist.
  it('does not let an ungated grant read as a gated one', () => {
    render(
      <DraftManifest
        draft={draft({
          analysis: {
            capabilities: [capability({
              permission: 'system:filesystem',
              label: 'Read and write files on your computer',
              gating: 'ungated',
              elevated: true,
              calls: [],
            })],
            undeclared: [],
          },
        })}
        {...actions}
      />,
    );
    expect(screen.getByText(/not mediated by the sandbox/)).toBeTruthy();
  });

  it('shows a coarse alias as granting nothing at all', () => {
    render(
      <DraftManifest
        draft={draft({
          analysis: {
            capabilities: [capability({
              permission: 'data:read', label: 'Read your data',
              status: 'inert', gating: 'inert', calls: [],
            })],
            undeclared: [],
          },
        })}
        {...actions}
      />,
    );
    expect(screen.getByText(/grants nothing/)).toBeTruthy();
  });

  // Not a style note: the gate denies this, so the plugin throws the first
  // time that path runs. Better said before it is kept than after.
  it('warns about a call the sandbox will refuse', () => {
    render(
      <DraftManifest
        draft={draft({
          analysis: {
            capabilities: [],
            undeclared: [{ call: 'context.actions.createTask', requires: ['data:tasks:write'], file: 'index.cjs' }],
          },
        })}
        {...actions}
      />,
    );
    expect(screen.getByText(/the sandbox will refuse/)).toBeTruthy();
    expect(screen.getByText(/data:tasks:write/)).toBeTruthy();
  });

  // Running is not rendering, and the difference used to be invisible.
  it('distinguishes never-previewed from previewed-and-failed', () => {
    const { rerender } = render(
      <DraftManifest draft={draft({ bundleUrl: 'plugin://draft.x/ui.js' })} {...actions} />,
    );
    expect(screen.getByText('nobody has looked yet')).toBeTruthy();

    rerender(
      <DraftManifest
        draft={draft({
          bundleUrl: 'plugin://draft.x/ui.js',
          lastRender: { status: 'failed', message: 'Cannot read x of undefined', at: 1 },
        })}
        {...actions}
      />,
    );
    expect(screen.getByText(/Preview failed to render/)).toBeTruthy();
    expect(screen.getByText(/Cannot read x of undefined/)).toBeTruthy();
  });

  it('describes what a running draft actually added', () => {
    render(
      <DraftManifest
        draft={draft({
          running: true,
          contributions: {
            tools: [{ name: 'roll_dice', description: 'Rolls dice', parameters: ['notation'] }],
            views: [],
          },
        })}
        {...actions}
      />,
    );
    expect(screen.getByText('roll_dice(notation)')).toBeTruthy();
    expect(screen.getByText('Rolls dice')).toBeTruthy();
  });

  it('says a running draft added nothing rather than staying silent', () => {
    render(<DraftManifest draft={draft({ running: true })} {...actions} />);
    expect(screen.getByText(/registered no tools and no views/)).toBeTruthy();
  });

  it('offers no Preview for a draft with no UI to preview', () => {
    render(<DraftManifest draft={draft()} {...actions} />);
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();

    render(<DraftManifest draft={draft({ bundleUrl: 'plugin://draft.x/ui.js' })} {...actions} />);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });

  it('routes each control to its own action', async () => {
    const onKeep = vi.fn();
    const onDiscard = vi.fn();
    render(<DraftManifest draft={draft()} {...actions} onKeep={onKeep} onDiscard={onDiscard} />);

    screen.getByRole('button', { name: 'Keep' }).click();
    screen.getByRole('button', { name: 'Discard' }).click();

    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
