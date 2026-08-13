/**
 * Derive shadcn/Tailwind color tokens from the active Enclave theme.
 *
 * shadcn components (Button, Input, …) consume `hsl(var(--primary))`-style
 * tokens. Hand-maintaining those per theme in App.css only ever covers the
 * themes someone remembered to write: every other bundled theme and all
 * user-defined themes fall back to the dark defaults, leaving buttons
 * invisible on mismatched palettes. Deriving the tokens from
 * ThemeDefinition.colors at theme-switch time keeps themes.ts the single
 * source of truth and covers user themes for free.
 *
 * Tokens are written as `H S% L%` triplets (Tailwind 3 composes them with
 * `hsl(var(--x) / <alpha>)`, so the raw hex can't be used directly).
 */

import type { ThemeDefinition } from '@/styles/themes';

/** Parse #rgb/#rrggbb into an `H S% L%` triplet, or null if not hex. */
function hexToHslTriplet(color: string | undefined): string | null {
  if (!color) return null;
  const hex = color.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;

  let r: number, g: number, b: number;
  if (match[1].length === 3) {
    r = parseInt(match[1][0] + match[1][0], 16);
    g = parseInt(match[1][1] + match[1][1], 16);
    b = parseInt(match[1][2] + match[1][2], 16);
  } else {
    r = parseInt(match[1].slice(0, 2), 16);
    g = parseInt(match[1].slice(2, 4), 16);
    b = parseInt(match[1].slice(4, 6), 16);
  }

  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(h * 360)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/** Near-white or near-black text triplet, whichever contrasts with the bg. */
function contrastForeground(bgHex: string | undefined): string | null {
  if (!bgHex) return null;
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(bgHex.trim());
  if (!match) return null;
  const hex = match[1].length === 3
    ? match[1].split('').map((c) => c + c).join('')
    : match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // YIQ perceived brightness — cheap and good enough for button text.
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '240 6% 10%' : '0 0% 98%';
}

const SHADCN_TOKENS = [
  '--background', '--foreground',
  '--card', '--card-foreground',
  '--popover', '--popover-foreground',
  '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground',
  '--accent', '--accent-foreground',
  '--destructive', '--destructive-foreground',
  '--border', '--input', '--ring',
] as const;

/**
 * Apply derived shadcn tokens as inline styles on the root element.
 * Unparseable colors (rgba strings, etc.) fall back to the stylesheet
 * defaults in App.css by clearing the inline override.
 */
export function applyShadcnTokens(root: HTMLElement, def: ThemeDefinition | undefined): void {
  if (!def) {
    for (const token of SHADCN_TOKENS) root.style.removeProperty(token);
    return;
  }

  const c = def.colors;
  const values: Record<(typeof SHADCN_TOKENS)[number], string | null> = {
    '--background': hexToHslTriplet(c.bgPrimary),
    '--foreground': hexToHslTriplet(c.textPrimary),
    '--card': hexToHslTriplet(c.bgSecondary),
    '--card-foreground': hexToHslTriplet(c.textPrimary),
    '--popover': hexToHslTriplet(c.bgModal),
    '--popover-foreground': hexToHslTriplet(c.textPrimary),
    '--primary': hexToHslTriplet(c.accentPrimary),
    '--primary-foreground': contrastForeground(c.accentPrimary),
    '--secondary': hexToHslTriplet(c.bgTertiary),
    '--secondary-foreground': hexToHslTriplet(c.textPrimary),
    '--muted': hexToHslTriplet(c.bgTertiary),
    '--muted-foreground': hexToHslTriplet(c.textSecondary),
    '--accent': hexToHslTriplet(c.bgHover),
    '--accent-foreground': hexToHslTriplet(c.textPrimary),
    '--destructive': hexToHslTriplet(c.statusError ?? '#ef4444'),
    '--destructive-foreground': contrastForeground(c.statusError ?? '#ef4444'),
    '--border': hexToHslTriplet(c.borderPrimary),
    '--input': hexToHslTriplet(c.borderPrimary),
    '--ring': hexToHslTriplet(c.accentPrimary),
  };

  for (const token of SHADCN_TOKENS) {
    const value = values[token];
    if (value) {
      root.style.setProperty(token, value);
    } else {
      root.style.removeProperty(token);
    }
  }
}
