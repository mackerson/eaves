import { describe, it, expect } from 'vitest';
import {
  parseAccelerator,
  formatAccelerator,
  matchesAccelerator,
  type KeyChordEvent,
} from './accelerators';

function keyEvent(init: Partial<KeyChordEvent> & { key: string }): KeyChordEvent {
  return {
    key: init.key,
    code: init.code ?? '',
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  };
}

describe('parseAccelerator', () => {
  it('separates modifiers from the key', () => {
    expect(parseAccelerator('Shift+CmdOrCtrl+P')).toEqual({
      primary: true,
      control: false,
      alt: false,
      shift: true,
      key: 'p',
    });
  });

  // Control+Cmd+N is a real chord on macOS (New Note), distinct from Cmd+N.
  // Folding Ctrl into the primary modifier here would collide the two.
  it('keeps an explicit Control separate from the primary modifier', () => {
    expect(parseAccelerator('Control+CmdOrCtrl+N')).toMatchObject({
      primary: true,
      control: true,
      key: 'n',
    });
  });
});

describe('formatAccelerator', () => {
  it('uses glyphs in conventional order on macOS', () => {
    expect(formatAccelerator('Shift+CmdOrCtrl+P', 'darwin')).toBe('⇧⌘P');
    expect(formatAccelerator('Control+CmdOrCtrl+N', 'darwin')).toBe('⌃⌘N');
    expect(formatAccelerator('Alt+CmdOrCtrl+\\', 'darwin')).toBe('⌥⌘\\');
  });

  it('uses word form off macOS', () => {
    expect(formatAccelerator('Shift+CmdOrCtrl+P', 'win32')).toBe('Ctrl+Shift+P');
    expect(formatAccelerator('CmdOrCtrl+K', 'linux')).toBe('Ctrl+K');
  });

  // Off macOS the primary modifier *is* Ctrl, so a chord asking for both must
  // not render "Ctrl+Ctrl+N".
  it('collapses primary and Control into one Ctrl off macOS', () => {
    expect(formatAccelerator('Control+CmdOrCtrl+N', 'win32')).toBe('Ctrl+N');
  });
});

describe('matchesAccelerator', () => {
  it('matches the declared chord', () => {
    const event = keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(matchesAccelerator(event, 'CmdOrCtrl+K', 'linux')).toBe(true);
  });

  // The regression this guards: the old handler tested `e.key === 'n'` for
  // ⌘N and `e.key === 'N'` for ⇧⌘N, which worked only because Shift
  // uppercases `key`. Reading the physical code makes the two chords
  // genuinely distinct instead of accidentally so.
  it('distinguishes a shifted chord from its unshifted twin', () => {
    const shifted = keyEvent({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true });
    expect(matchesAccelerator(shifted, 'CmdOrCtrl+N', 'linux')).toBe(false);
    expect(matchesAccelerator(shifted, 'Shift+CmdOrCtrl+N', 'linux')).toBe(true);

    const plain = keyEvent({ key: 'n', code: 'KeyN', ctrlKey: true });
    expect(matchesAccelerator(plain, 'CmdOrCtrl+N', 'linux')).toBe(true);
    expect(matchesAccelerator(plain, 'Shift+CmdOrCtrl+N', 'linux')).toBe(false);
  });

  it('does not fire a bare chord when a modifier is missing', () => {
    const event = keyEvent({ key: 'k', code: 'KeyK' });
    expect(matchesAccelerator(event, 'CmdOrCtrl+K', 'linux')).toBe(false);
  });

  it('reads digits from the physical code so Shift+1 is not mistaken for 1', () => {
    const event = keyEvent({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true });
    expect(matchesAccelerator(event, 'CmdOrCtrl+1', 'linux')).toBe(false);
    expect(matchesAccelerator(event, 'Shift+CmdOrCtrl+1', 'linux')).toBe(true);
  });
});
