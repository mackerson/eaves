/**
 * Accelerator parsing, display formatting, and event matching.
 *
 * Menu shortcuts are declared once, in Electron accelerator syntax
 * ("Shift+CmdOrCtrl+P"), and consumed three ways: passed verbatim to
 * Electron's native menu on macOS, rendered as a label in the custom
 * menu bar, and matched against KeyboardEvents on Windows/Linux where
 * there is no native menu to do it for us.
 *
 * Keeping one source avoids the drift that existed when the label, the
 * handler, and the About dialog each hardcoded their own copy.
 */

export type MenuPlatform = 'darwin' | 'win32' | 'linux';

export interface ParsedAccelerator {
  /** CmdOrCtrl / Cmd — the platform's primary modifier. */
  primary: boolean;
  /** Explicit Ctrl on macOS (⌃). On Win/Linux this folds into `primary`. */
  control: boolean;
  alt: boolean;
  shift: boolean;
  /** Single key, normalized to lowercase for letters. */
  key: string;
}

const MODIFIER_TOKENS = new Set([
  'cmdorctrl',
  'commandorcontrol',
  'cmd',
  'command',
  'ctrl',
  'control',
  'alt',
  'option',
  'shift',
  'super',
  'meta',
]);

export function parseAccelerator(accelerator: string): ParsedAccelerator {
  const parsed: ParsedAccelerator = {
    primary: false,
    control: false,
    alt: false,
    shift: false,
    key: '',
  };

  for (const rawToken of accelerator.split('+')) {
    const token = rawToken.trim();
    if (!token) continue;
    const lower = token.toLowerCase();

    if (!MODIFIER_TOKENS.has(lower)) {
      parsed.key = token.length === 1 ? token.toLowerCase() : token;
      continue;
    }

    switch (lower) {
      case 'cmdorctrl':
      case 'commandorcontrol':
      case 'cmd':
      case 'command':
      case 'super':
      case 'meta':
        parsed.primary = true;
        break;
      case 'ctrl':
      case 'control':
        parsed.control = true;
        break;
      case 'alt':
      case 'option':
        parsed.alt = true;
        break;
      case 'shift':
        parsed.shift = true;
        break;
    }
  }

  return parsed;
}

/** Keys whose display glyph differs from the token used in the accelerator. */
const DISPLAY_KEYS: Record<string, string> = {
  plus: '+',
  minus: '−',
  backslash: '\\',
  bracketleft: '[',
  bracketright: ']',
  comma: ',',
  slash: '/',
  space: 'Space',
  return: '↩',
  enter: '↩',
  escape: 'Esc',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

function displayKey(key: string): string {
  const mapped = DISPLAY_KEYS[key.toLowerCase()];
  if (mapped) return mapped;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Human-readable label for a menu row.
 *
 * macOS uses the conventional glyph order ⌃⌥⇧⌘; everywhere else uses
 * "Ctrl+Shift+P" word form.
 */
export function formatAccelerator(accelerator: string, platform: MenuPlatform): string {
  const { primary, control, alt, shift, key } = parseAccelerator(accelerator);

  if (platform === 'darwin') {
    let out = '';
    if (control) out += '⌃';
    if (alt) out += '⌥';
    if (shift) out += '⇧';
    if (primary) out += '⌘';
    return out + displayKey(key);
  }

  const parts: string[] = [];
  // On Win/Linux there is no separate Cmd, so an explicit Ctrl and the
  // primary modifier are the same key — don't render "Ctrl+Ctrl+F".
  if (primary || control) parts.push('Ctrl');
  if (alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(displayKey(key));
  return parts.join('+');
}

/**
 * The parts of a KeyboardEvent this module needs.
 *
 * Declared structurally rather than as `KeyboardEvent` so this file stays
 * free of DOM lib types — it is compiled into the main process build too,
 * where the DOM does not exist. A real KeyboardEvent satisfies this.
 */
export interface KeyChordEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Normalizes an event key to the form parseAccelerator produces. */
function eventKey(event: KeyChordEvent): string {
  const { key, code } = event;

  // Shifted digits and punctuation report the shifted glyph in `key`
  // (Shift+1 -> "!"), so prefer the physical code where it is unambiguous.
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();

  if (key.length === 1) return key.toLowerCase();

  const named: Record<string, string> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Escape: 'escape',
    Enter: 'return',
    ' ': 'space',
  };
  return named[key] ?? key.toLowerCase();
}

/**
 * True when `event` is the chord `accelerator` describes.
 *
 * Only used on Windows/Linux — macOS lets the native menu own its
 * accelerators, and double-handling would fire commands twice.
 */
export function matchesAccelerator(
  event: KeyChordEvent,
  accelerator: string,
  platform: MenuPlatform,
): boolean {
  const spec = parseAccelerator(accelerator);
  if (!spec.key) return false;

  const primaryHeld = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  const controlHeld = event.ctrlKey;

  if (spec.primary !== primaryHeld) return false;

  // Off macOS the primary modifier *is* Ctrl, so an accelerator asking for
  // primary already accounts for the Ctrl that is physically held.
  if (platform === 'darwin') {
    if (spec.control !== controlHeld) return false;
  } else if (!spec.primary && spec.control !== controlHeld) {
    return false;
  }

  if (spec.alt !== event.altKey) return false;
  if (spec.shift !== event.shiftKey) return false;

  const actual = eventKey(event).toLowerCase();
  const expected = spec.key.toLowerCase();
  if (actual === expected) return true;

  const aliases = KEY_ALIASES[expected];
  return aliases ? aliases.includes(actual) : false;
}

/**
 * Accelerator tokens that legitimately arrive as a different physical key.
 *
 * "Plus" is the common case: nobody presses Shift to zoom in, so the browser
 * reports "=" for what the menu calls ⌘+.
 */
const KEY_ALIASES: Record<string, string[]> = {
  plus: ['+', '=', 'equal'],
  '-': ['_', 'minus'],
  minus: ['-', '_'],
};
