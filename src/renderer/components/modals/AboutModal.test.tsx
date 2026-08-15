import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AboutModal } from './AboutModal';
import { buildMenuModel, collectAccelerators } from '@shared/menuModel';
import { formatAccelerator, type MenuPlatform } from '@shared/accelerators';

/**
 * The Tips tab's shortcut list used to be typed out by hand and had drifted
 * from the real bindings. These tests pin it to the menu model, so
 * reintroducing a hardcoded chord fails here.
 */

function openTips(platform: MenuPlatform) {
  (window as any).electron = {
    platform,
    getAppVersion: vi.fn().mockResolvedValue({ version: '0.0.0-test' }),
    openExternal: vi.fn(),
  };
  render(<AboutModal open onOpenChange={() => {}} />);
  // Radix activates a tab on mousedown, not click.
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Tips' }));
  return screen.getByRole('tabpanel', { name: 'Tips' });
}

const originalElectron = (window as any).electron;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (window as any).electron = originalElectron;
  vi.restoreAllMocks();
});

/** The `<code>Chord</code> - Label` row for a given chord. */
function rowFor(panel: HTMLElement, chord: string): HTMLElement {
  const code = within(panel)
    .getAllByText(chord, { selector: 'code' })
    .at(0);
  expect(code, `no shortcut row rendered for ${chord}`).toBeTruthy();
  return code!.closest('li') as HTMLElement;
}

describe('AboutModal keyboard shortcuts', () => {
  it('lists every accelerator in the menu model', () => {
    const panel = openTips('linux');
    const expected = collectAccelerators(buildMenuModel('linux'));
    expect(expected.length).toBeGreaterThan(15);

    for (const entry of expected) {
      const row = rowFor(panel, formatAccelerator(entry.accelerator, 'linux'));
      expect(row.textContent).toContain(entry.label);
    }
  });

  it('groups the rows under their top-level menu', () => {
    const panel = openTips('linux');
    for (const menu of buildMenuModel('linux')) {
      if (collectAccelerators([menu]).length === 0) continue;
      expect(within(panel).getByText(menu.label, { selector: 'h4' })).toBeTruthy();
    }
  });

  it('shows the current binding for a chord that was previously documented wrong', () => {
    const panel = openTips('linux');

    // Ctrl+K is Search Everything now, not New Channel; Ctrl+N is New Chat,
    // not New Agent. Both were wrong in the old hand-written list.
    expect(rowFor(panel, 'Ctrl+K').textContent).toContain('Search Everything');
    expect(rowFor(panel, 'Ctrl+K').textContent).not.toContain('New Channel');
    expect(rowFor(panel, 'Ctrl+N').textContent).toContain('New Chat');
    expect(rowFor(panel, 'Ctrl+N').textContent).not.toContain('New Agent');
    expect(rowFor(panel, 'Ctrl+Shift+N').textContent).toContain('New Channel');

    // The view switchers run 1–8 and no longer collapse into one "1–6" row.
    expect(rowFor(panel, 'Ctrl+8').textContent).toContain('Tasks');
    expect(within(panel).queryByText(/1–6/)).toBeNull();

    // Nothing left claiming to be platform-agnostic.
    expect(panel.textContent).not.toContain('Cmd/Ctrl');
  });

  it('uses word form off macOS', () => {
    const panel = openTips('linux');
    expect(rowFor(panel, 'Ctrl+K').textContent).toContain('Search Everything');
    expect(panel.textContent).not.toContain('⌘');
  });

  it('uses glyph form on macOS', () => {
    const panel = openTips('darwin');
    expect(rowFor(panel, '⌘K').textContent).toContain('Search Everything');
    // macOS gets rows the other platforms do not — Quit lives in the app menu.
    expect(rowFor(panel, '⌘Q').textContent).toContain('Quit Eaves');
  });

  it('falls back to a non-mac rendering when the platform is unavailable', () => {
    (window as any).electron = {
      getAppVersion: vi.fn().mockResolvedValue({ version: '0.0.0-test' }),
      openExternal: vi.fn(),
    };
    render(<AboutModal open onOpenChange={() => {}} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Tips' }));
    const panel = screen.getByRole('tabpanel', { name: 'Tips' });
    expect(rowFor(panel, 'Ctrl+K')).toBeTruthy();
  });

  it('keeps Esc as an explicit extra outside the derived groups', () => {
    const panel = openTips('linux');
    const esc = rowFor(panel, 'Esc');
    expect(esc.textContent).toContain('Close dialogs');
    // Not smuggled into a menu group.
    expect(collectAccelerators(buildMenuModel('linux')).some((e) => e.accelerator === 'Escape')).toBe(false);
  });
});
