/**
 * Eaves Theme System - 32 Flavors
 *
 * Each theme defines colors that map to CSS custom properties.
 * The isDark flag determines which Tailwind class to apply (dark/light).
 */

import { ThemeColors, ThemeBackground, ThemeTransparency, ThemeIconSet, ThemeDefinition } from '../../shared/types';

export type { ThemeColors, ThemeBackground, ThemeTransparency, ThemeIconSet, ThemeDefinition };

export type ThemeCategory =
  | 'Basics'
  | 'Developer Classics'
  | 'Nature'
  | 'Soft & Cozy'
  | 'Bold & Vibrant'
  | 'Professional'
  | 'Fun & Nostalgic'
  | 'Custom';

export const categoryOrder: ThemeCategory[] = [
  'Basics',
  'Developer Classics',
  'Nature',
  'Soft & Cozy',
  'Bold & Vibrant',
  'Professional',
  'Fun & Nostalgic',
  'Custom',
];

export const themes: ThemeDefinition[] = [
  // ============================================
  // BASICS (4)
  // ============================================
  {
    id: 'dark',
    name: 'Dark',
    category: 'Basics',
    isDark: true,
    colors: {
      bgPrimary: '#1a1a1a',
      bgSecondary: '#242424',
      bgTertiary: '#2d2d2d',
      bgHover: '#333333',
      bgActive: '#3a3a3a',
      bgInput: '#2d2d2d',
      bgModal: '#1e1e1e',
      bgOverlay: 'rgba(0, 0, 0, 0.8)',
      textPrimary: '#ffffff',
      textSecondary: '#b0b0b0',
      textTertiary: '#808080',
      textDisabled: '#555555',
      textInverse: '#1a1a1a',
      accentPrimary: '#667eea',
      accentSecondary: '#764ba2',
      accentHover: '#7c8ef0',
      accentActive: '#5a6fd8',
      borderPrimary: '#3a3a3a',
      borderSecondary: '#2d2d2d',
    },
  },
  {
    id: 'light',
    name: 'Light',
    category: 'Basics',
    isDark: false,
    colors: {
      bgPrimary: '#ffffff',
      bgSecondary: '#f9fafb',
      bgTertiary: '#f3f4f6',
      bgHover: '#e5e7eb',
      bgActive: '#d1d5db',
      bgInput: '#ffffff',
      bgModal: '#ffffff',
      bgOverlay: 'rgba(0, 0, 0, 0.5)',
      textPrimary: '#1a1a1a',
      textSecondary: '#4b5563',
      textTertiary: '#9ca3af',
      textDisabled: '#d1d5db',
      textInverse: '#ffffff',
      accentPrimary: '#667eea',
      accentSecondary: '#764ba2',
      accentHover: '#7c8ef0',
      accentActive: '#5a6fd8',
      borderPrimary: '#e5e7eb',
      borderSecondary: '#f3f4f6',
    },
  },
  {
    id: 'oled',
    name: 'OLED Black',
    category: 'Basics',
    isDark: true,
    colors: {
      bgPrimary: '#000000',
      bgSecondary: '#0a0a0a',
      bgTertiary: '#141414',
      bgHover: '#1a1a1a',
      bgActive: '#242424',
      bgInput: '#0a0a0a',
      bgModal: '#000000',
      bgOverlay: 'rgba(0, 0, 0, 0.9)',
      textPrimary: '#ffffff',
      textSecondary: '#a0a0a0',
      textTertiary: '#707070',
      textDisabled: '#404040',
      textInverse: '#000000',
      accentPrimary: '#667eea',
      accentSecondary: '#764ba2',
      accentHover: '#7c8ef0',
      accentActive: '#5a6fd8',
      borderPrimary: '#242424',
      borderSecondary: '#141414',
    },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    category: 'Basics',
    isDark: true,
    colors: {
      bgPrimary: '#000000',
      bgSecondary: '#1a1a1a',
      bgTertiary: '#2a2a2a',
      bgHover: '#3a3a3a',
      bgActive: '#4a4a4a',
      bgInput: '#1a1a1a',
      bgModal: '#000000',
      bgOverlay: 'rgba(0, 0, 0, 0.95)',
      textPrimary: '#ffffff',
      textSecondary: '#ffffff',
      textTertiary: '#cccccc',
      textDisabled: '#666666',
      textInverse: '#000000',
      accentPrimary: '#00ff00',
      accentSecondary: '#ffff00',
      accentHover: '#33ff33',
      accentActive: '#00cc00',
      borderPrimary: '#ffffff',
      borderSecondary: '#808080',
    },
  },

  // ============================================
  // DEVELOPER CLASSICS (6)
  // ============================================
  {
    id: 'dracula',
    name: 'Dracula',
    category: 'Developer Classics',
    isDark: true,
    colors: {
      bgPrimary: '#282a36',
      bgSecondary: '#343746',
      bgTertiary: '#3d4051',
      bgHover: '#44475a',
      bgActive: '#4d5066',
      bgInput: '#343746',
      bgModal: '#21222c',
      bgOverlay: 'rgba(40, 42, 54, 0.9)',
      textPrimary: '#f8f8f2',
      textSecondary: '#bd93f9',
      textTertiary: '#6272a4',
      textDisabled: '#44475a',
      textInverse: '#282a36',
      accentPrimary: '#bd93f9',
      accentSecondary: '#ff79c6',
      accentHover: '#caa8fc',
      accentActive: '#a87adb',
      borderPrimary: '#44475a',
      borderSecondary: '#343746',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    category: 'Developer Classics',
    isDark: true,
    colors: {
      bgPrimary: '#2e3440',
      bgSecondary: '#3b4252',
      bgTertiary: '#434c5e',
      bgHover: '#4c566a',
      bgActive: '#5a657a',
      bgInput: '#3b4252',
      bgModal: '#2e3440',
      bgOverlay: 'rgba(46, 52, 64, 0.9)',
      textPrimary: '#eceff4',
      textSecondary: '#d8dee9',
      textTertiary: '#81a1c1',
      textDisabled: '#4c566a',
      textInverse: '#2e3440',
      accentPrimary: '#88c0d0',
      accentSecondary: '#81a1c1',
      accentHover: '#8fbcbb',
      accentActive: '#5e81ac',
      borderPrimary: '#4c566a',
      borderSecondary: '#434c5e',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    category: 'Developer Classics',
    isDark: true,
    colors: {
      bgPrimary: '#002b36',
      bgSecondary: '#073642',
      bgTertiary: '#0a4050',
      bgHover: '#094959',
      bgActive: '#0d5666',
      bgInput: '#073642',
      bgModal: '#002b36',
      bgOverlay: 'rgba(0, 43, 54, 0.9)',
      textPrimary: '#fdf6e3',
      textSecondary: '#93a1a1',
      textTertiary: '#657b83',
      textDisabled: '#586e75',
      textInverse: '#002b36',
      accentPrimary: '#268bd2',
      accentSecondary: '#2aa198',
      accentHover: '#4ca3de',
      accentActive: '#1e7aba',
      borderPrimary: '#094959',
      borderSecondary: '#073642',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    category: 'Developer Classics',
    isDark: false,
    colors: {
      bgPrimary: '#fdf6e3',
      bgSecondary: '#eee8d5',
      bgTertiary: '#e6dfca',
      bgHover: '#d6d0bb',
      bgActive: '#c6c0ab',
      bgInput: '#fdf6e3',
      bgModal: '#fdf6e3',
      bgOverlay: 'rgba(0, 0, 0, 0.5)',
      textPrimary: '#073642',
      textSecondary: '#586e75',
      textTertiary: '#93a1a1',
      textDisabled: '#c6c0ab',
      textInverse: '#fdf6e3',
      accentPrimary: '#268bd2',
      accentSecondary: '#2aa198',
      accentHover: '#4ca3de',
      accentActive: '#1e7aba',
      borderPrimary: '#d6d0bb',
      borderSecondary: '#eee8d5',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    category: 'Developer Classics',
    isDark: true,
    colors: {
      bgPrimary: '#272822',
      bgSecondary: '#2d2e27',
      bgTertiary: '#3e3d32',
      bgHover: '#49483e',
      bgActive: '#5a5a4a',
      bgInput: '#2d2e27',
      bgModal: '#272822',
      bgOverlay: 'rgba(39, 40, 34, 0.9)',
      textPrimary: '#f8f8f2',
      textSecondary: '#e6db74',
      textTertiary: '#75715e',
      textDisabled: '#49483e',
      textInverse: '#272822',
      accentPrimary: '#a6e22e',
      accentSecondary: '#f92672',
      accentHover: '#b8e85a',
      accentActive: '#8cc621',
      borderPrimary: '#49483e',
      borderSecondary: '#3e3d32',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    category: 'Developer Classics',
    isDark: true,
    colors: {
      bgPrimary: '#282c34',
      bgSecondary: '#21252b',
      bgTertiary: '#2c313a',
      bgHover: '#3a3f4b',
      bgActive: '#444a57',
      bgInput: '#21252b',
      bgModal: '#282c34',
      bgOverlay: 'rgba(40, 44, 52, 0.9)',
      textPrimary: '#abb2bf',
      textSecondary: '#5c6370',
      textTertiary: '#4b5263',
      textDisabled: '#3a3f4b',
      textInverse: '#282c34',
      accentPrimary: '#61afef',
      accentSecondary: '#c678dd',
      accentHover: '#7dbff5',
      accentActive: '#4ba0e0',
      borderPrimary: '#3a3f4b',
      borderSecondary: '#2c313a',
    },
  },

  // ============================================
  // NATURE (6)
  // ============================================
  {
    id: 'ocean',
    name: 'Ocean',
    category: 'Nature',
    isDark: true,
    colors: {
      bgPrimary: '#0f172a',
      bgSecondary: '#1e293b',
      bgTertiary: '#273448',
      bgHover: '#334155',
      bgActive: '#3d4d63',
      bgInput: '#1e293b',
      bgModal: '#0f172a',
      bgOverlay: 'rgba(15, 23, 42, 0.9)',
      textPrimary: '#e0f2fe',
      textSecondary: '#7dd3fc',
      textTertiary: '#38bdf8',
      textDisabled: '#334155',
      textInverse: '#0f172a',
      accentPrimary: '#0ea5e9',
      accentSecondary: '#06b6d4',
      accentHover: '#38bdf8',
      accentActive: '#0284c7',
      borderPrimary: '#334155',
      borderSecondary: '#273448',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    category: 'Nature',
    isDark: true,
    colors: {
      bgPrimary: '#14201a',
      bgSecondary: '#1a2e23',
      bgTertiary: '#213d2d',
      bgHover: '#2a4d38',
      bgActive: '#345d43',
      bgInput: '#1a2e23',
      bgModal: '#14201a',
      bgOverlay: 'rgba(20, 32, 26, 0.9)',
      textPrimary: '#d1fae5',
      textSecondary: '#6ee7b7',
      textTertiary: '#34d399',
      textDisabled: '#2a4d38',
      textInverse: '#14201a',
      accentPrimary: '#10b981',
      accentSecondary: '#059669',
      accentHover: '#34d399',
      accentActive: '#047857',
      borderPrimary: '#2a4d38',
      borderSecondary: '#213d2d',
    },
  },
  {
    id: 'desert',
    name: 'Desert',
    category: 'Nature',
    isDark: false,
    colors: {
      bgPrimary: '#fef6ee',
      bgSecondary: '#fceee1',
      bgTertiary: '#f9e4d1',
      bgHover: '#f4d4b8',
      bgActive: '#efc49f',
      bgInput: '#fef6ee',
      bgModal: '#fef6ee',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#451a03',
      textSecondary: '#78350f',
      textTertiary: '#a16207',
      textDisabled: '#c9a97c',
      textInverse: '#fef6ee',
      accentPrimary: '#d97706',
      accentSecondary: '#b45309',
      accentHover: '#f59e0b',
      accentActive: '#b45309',
      borderPrimary: '#f4d4b8',
      borderSecondary: '#f9e4d1',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    category: 'Nature',
    isDark: true,
    colors: {
      bgPrimary: '#1f1120',
      bgSecondary: '#2d1a2e',
      bgTertiary: '#3d233d',
      bgHover: '#4d2d4d',
      bgActive: '#5d375d',
      bgInput: '#2d1a2e',
      bgModal: '#1f1120',
      bgOverlay: 'rgba(31, 17, 32, 0.9)',
      textPrimary: '#fdf2f8',
      textSecondary: '#f9a8d4',
      textTertiary: '#f472b6',
      textDisabled: '#4d2d4d',
      textInverse: '#1f1120',
      accentPrimary: '#f97316',
      accentSecondary: '#ec4899',
      accentHover: '#fb923c',
      accentActive: '#ea580c',
      borderPrimary: '#4d2d4d',
      borderSecondary: '#3d233d',
    },
  },
  {
    id: 'arctic',
    name: 'Arctic',
    category: 'Nature',
    isDark: false,
    colors: {
      bgPrimary: '#f0f9ff',
      bgSecondary: '#e0f2fe',
      bgTertiary: '#d1ebfc',
      bgHover: '#bae6fd',
      bgActive: '#a3dafc',
      bgInput: '#f0f9ff',
      bgModal: '#f0f9ff',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#0c4a6e',
      textSecondary: '#0369a1',
      textTertiary: '#0284c7',
      textDisabled: '#7dd3fc',
      textInverse: '#f0f9ff',
      accentPrimary: '#0284c7',
      accentSecondary: '#0369a1',
      accentHover: '#0ea5e9',
      accentActive: '#0369a1',
      borderPrimary: '#bae6fd',
      borderSecondary: '#d1ebfc',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    category: 'Nature',
    isDark: true,
    colors: {
      bgPrimary: '#0f0f1a',
      bgSecondary: '#171727',
      bgTertiary: '#1f1f35',
      bgHover: '#282843',
      bgActive: '#313151',
      bgInput: '#171727',
      bgModal: '#0f0f1a',
      bgOverlay: 'rgba(15, 15, 26, 0.95)',
      textPrimary: '#e0e0ff',
      textSecondary: '#a0a0d0',
      textTertiary: '#7070a0',
      textDisabled: '#404060',
      textInverse: '#0f0f1a',
      accentPrimary: '#6366f1',
      accentSecondary: '#8b5cf6',
      accentHover: '#818cf8',
      accentActive: '#4f46e5',
      borderPrimary: '#282843',
      borderSecondary: '#1f1f35',
    },
  },

  // ============================================
  // SOFT & COZY (4)
  // ============================================
  {
    id: 'rose',
    name: 'Rose',
    category: 'Soft & Cozy',
    isDark: false,
    colors: {
      bgPrimary: '#fff1f2',
      bgSecondary: '#ffe4e6',
      bgTertiary: '#fecdd3',
      bgHover: '#fda4af',
      bgActive: '#fb7185',
      bgInput: '#fff1f2',
      bgModal: '#fff1f2',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#4c0519',
      textSecondary: '#881337',
      textTertiary: '#be123c',
      textDisabled: '#fda4af',
      textInverse: '#fff1f2',
      accentPrimary: '#e11d48',
      accentSecondary: '#be123c',
      accentHover: '#f43f5e',
      accentActive: '#be123c',
      borderPrimary: '#fda4af',
      borderSecondary: '#fecdd3',
    },
  },
  {
    id: 'lavender',
    name: 'Lavender',
    category: 'Soft & Cozy',
    isDark: false,
    colors: {
      bgPrimary: '#faf5ff',
      bgSecondary: '#f3e8ff',
      bgTertiary: '#e9d5ff',
      bgHover: '#d8b4fe',
      bgActive: '#c084fc',
      bgInput: '#faf5ff',
      bgModal: '#faf5ff',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#3b0764',
      textSecondary: '#6b21a8',
      textTertiary: '#9333ea',
      textDisabled: '#d8b4fe',
      textInverse: '#faf5ff',
      accentPrimary: '#9333ea',
      accentSecondary: '#7e22ce',
      accentHover: '#a855f7',
      accentActive: '#7e22ce',
      borderPrimary: '#d8b4fe',
      borderSecondary: '#e9d5ff',
    },
  },
  {
    id: 'mint',
    name: 'Mint',
    category: 'Soft & Cozy',
    isDark: false,
    colors: {
      bgPrimary: '#f0fdf4',
      bgSecondary: '#dcfce7',
      bgTertiary: '#bbf7d0',
      bgHover: '#86efac',
      bgActive: '#4ade80',
      bgInput: '#f0fdf4',
      bgModal: '#f0fdf4',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#052e16',
      textSecondary: '#166534',
      textTertiary: '#16a34a',
      textDisabled: '#86efac',
      textInverse: '#f0fdf4',
      accentPrimary: '#16a34a',
      accentSecondary: '#15803d',
      accentHover: '#22c55e',
      accentActive: '#15803d',
      borderPrimary: '#86efac',
      borderSecondary: '#bbf7d0',
    },
  },
  {
    id: 'peach',
    name: 'Peach',
    category: 'Soft & Cozy',
    isDark: false,
    colors: {
      bgPrimary: '#fff7ed',
      bgSecondary: '#ffedd5',
      bgTertiary: '#fed7aa',
      bgHover: '#fdba74',
      bgActive: '#fb923c',
      bgInput: '#fff7ed',
      bgModal: '#fff7ed',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#431407',
      textSecondary: '#9a3412',
      textTertiary: '#c2410c',
      textDisabled: '#fdba74',
      textInverse: '#fff7ed',
      accentPrimary: '#ea580c',
      accentSecondary: '#c2410c',
      accentHover: '#f97316',
      accentActive: '#c2410c',
      borderPrimary: '#fdba74',
      borderSecondary: '#fed7aa',
    },
  },

  // ============================================
  // BOLD & VIBRANT (4)
  // ============================================
  {
    id: 'neon',
    name: 'Neon',
    category: 'Bold & Vibrant',
    isDark: true,
    colors: {
      bgPrimary: '#0a0a0f',
      bgSecondary: '#12121a',
      bgTertiary: '#1a1a25',
      bgHover: '#252530',
      bgActive: '#30303b',
      bgInput: '#12121a',
      bgModal: '#0a0a0f',
      bgOverlay: 'rgba(10, 10, 15, 0.95)',
      textPrimary: '#00ff88',
      textSecondary: '#00ccff',
      textTertiary: '#8888ff',
      textDisabled: '#404050',
      textInverse: '#0a0a0f',
      accentPrimary: '#00ff88',
      accentSecondary: '#ff0088',
      accentHover: '#33ffaa',
      accentActive: '#00cc6e',
      borderPrimary: '#00ff88',
      borderSecondary: '#252530',
    },
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    category: 'Bold & Vibrant',
    isDark: true,
    colors: {
      bgPrimary: '#0d0d12',
      bgSecondary: '#15151d',
      bgTertiary: '#1d1d28',
      bgHover: '#262633',
      bgActive: '#30303e',
      bgInput: '#15151d',
      bgModal: '#0d0d12',
      bgOverlay: 'rgba(13, 13, 18, 0.95)',
      textPrimary: '#00fff5',
      textSecondary: '#ff2a6d',
      textTertiary: '#d1d1e9',
      textDisabled: '#404050',
      textInverse: '#0d0d12',
      accentPrimary: '#ff2a6d',
      accentSecondary: '#00fff5',
      accentHover: '#ff5c8d',
      accentActive: '#d6225a',
      borderPrimary: '#ff2a6d',
      borderSecondary: '#262633',
    },
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    category: 'Bold & Vibrant',
    isDark: true,
    colors: {
      bgPrimary: '#1a1025',
      bgSecondary: '#241734',
      bgTertiary: '#2e1e43',
      bgHover: '#3a2654',
      bgActive: '#462e65',
      bgInput: '#241734',
      bgModal: '#1a1025',
      bgOverlay: 'rgba(26, 16, 37, 0.95)',
      textPrimary: '#f5d3ff',
      textSecondary: '#ff7edb',
      textTertiary: '#b088f9',
      textDisabled: '#4a3560',
      textInverse: '#1a1025',
      accentPrimary: '#ff7edb',
      accentSecondary: '#b088f9',
      accentHover: '#ff9ee3',
      accentActive: '#e66bc5',
      borderPrimary: '#462e65',
      borderSecondary: '#2e1e43',
    },
  },
  {
    id: 'bubblegum',
    name: 'Bubblegum',
    category: 'Bold & Vibrant',
    isDark: false,
    colors: {
      bgPrimary: '#fef0f5',
      bgSecondary: '#fde1eb',
      bgTertiary: '#fcc8d9',
      bgHover: '#faa6c1',
      bgActive: '#f880a7',
      bgInput: '#fef0f5',
      bgModal: '#fef0f5',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#6d1a36',
      textSecondary: '#a12d52',
      textTertiary: '#d4406e',
      textDisabled: '#faa6c1',
      textInverse: '#fef0f5',
      accentPrimary: '#ec4899',
      accentSecondary: '#db2777',
      accentHover: '#f472b6',
      accentActive: '#db2777',
      borderPrimary: '#faa6c1',
      borderSecondary: '#fcc8d9',
    },
  },

  // ============================================
  // PROFESSIONAL (4)
  // ============================================
  {
    id: 'corporate',
    name: 'Corporate',
    category: 'Professional',
    isDark: false,
    colors: {
      bgPrimary: '#f8fafc',
      bgSecondary: '#f1f5f9',
      bgTertiary: '#e2e8f0',
      bgHover: '#cbd5e1',
      bgActive: '#94a3b8',
      bgInput: '#ffffff',
      bgModal: '#ffffff',
      bgOverlay: 'rgba(0, 0, 0, 0.5)',
      textPrimary: '#0f172a',
      textSecondary: '#334155',
      textTertiary: '#64748b',
      textDisabled: '#cbd5e1',
      textInverse: '#f8fafc',
      accentPrimary: '#2563eb',
      accentSecondary: '#1d4ed8',
      accentHover: '#3b82f6',
      accentActive: '#1d4ed8',
      borderPrimary: '#e2e8f0',
      borderSecondary: '#f1f5f9',
    },
  },
  {
    id: 'minimal',
    name: 'Minimal',
    category: 'Professional',
    isDark: false,
    colors: {
      bgPrimary: '#fafafa',
      bgSecondary: '#f5f5f5',
      bgTertiary: '#e5e5e5',
      bgHover: '#d4d4d4',
      bgActive: '#a3a3a3',
      bgInput: '#ffffff',
      bgModal: '#ffffff',
      bgOverlay: 'rgba(0, 0, 0, 0.5)',
      textPrimary: '#171717',
      textSecondary: '#404040',
      textTertiary: '#737373',
      textDisabled: '#d4d4d4',
      textInverse: '#fafafa',
      accentPrimary: '#171717',
      accentSecondary: '#404040',
      accentHover: '#404040',
      accentActive: '#0a0a0a',
      borderPrimary: '#e5e5e5',
      borderSecondary: '#f5f5f5',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    category: 'Professional',
    isDark: false,
    colors: {
      bgPrimary: '#fffbf5',
      bgSecondary: '#faf5ed',
      bgTertiary: '#f5efe5',
      bgHover: '#ebe5db',
      bgActive: '#dfd9cf',
      bgInput: '#fffbf5',
      bgModal: '#fffbf5',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#2d2a26',
      textSecondary: '#4d4a46',
      textTertiary: '#8d8a86',
      textDisabled: '#cdc9c5',
      textInverse: '#fffbf5',
      accentPrimary: '#8b7355',
      accentSecondary: '#6b5540',
      accentHover: '#a08b70',
      accentActive: '#6b5540',
      borderPrimary: '#e5dfd5',
      borderSecondary: '#f0eae0',
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    category: 'Professional',
    isDark: true,
    colors: {
      bgPrimary: '#1e293b',
      bgSecondary: '#283548',
      bgTertiary: '#334155',
      bgHover: '#3d4d63',
      bgActive: '#475a70',
      bgInput: '#283548',
      bgModal: '#1e293b',
      bgOverlay: 'rgba(30, 41, 59, 0.9)',
      textPrimary: '#f1f5f9',
      textSecondary: '#cbd5e1',
      textTertiary: '#94a3b8',
      textDisabled: '#475a70',
      textInverse: '#1e293b',
      accentPrimary: '#64748b',
      accentSecondary: '#475569',
      accentHover: '#94a3b8',
      accentActive: '#475569',
      borderPrimary: '#3d4d63',
      borderSecondary: '#334155',
    },
  },

  // ============================================
  // FUN & NOSTALGIC (4)
  // ============================================
  {
    id: 'terminal',
    name: 'Terminal',
    category: 'Fun & Nostalgic',
    isDark: true,
    colors: {
      bgPrimary: '#0a0a0a',
      bgSecondary: '#111111',
      bgTertiary: '#1a1a1a',
      bgHover: '#222222',
      bgActive: '#2a2a2a',
      bgInput: '#111111',
      bgModal: '#0a0a0a',
      bgOverlay: 'rgba(0, 0, 0, 0.95)',
      textPrimary: '#00ff00',
      textSecondary: '#00cc00',
      textTertiary: '#009900',
      textDisabled: '#004400',
      textInverse: '#0a0a0a',
      accentPrimary: '#00ff00',
      accentSecondary: '#00cc00',
      accentHover: '#33ff33',
      accentActive: '#00cc00',
      borderPrimary: '#00ff00',
      borderSecondary: '#004400',
    },
  },
  {
    id: 'sepia',
    name: 'Sepia',
    category: 'Fun & Nostalgic',
    isDark: false,
    colors: {
      bgPrimary: '#f4ecd8',
      bgSecondary: '#ebe3cf',
      bgTertiary: '#e2d9c5',
      bgHover: '#d4cab6',
      bgActive: '#c6bba7',
      bgInput: '#f4ecd8',
      bgModal: '#f4ecd8',
      bgOverlay: 'rgba(0, 0, 0, 0.4)',
      textPrimary: '#3d3427',
      textSecondary: '#5c5042',
      textTertiary: '#8a7e6e',
      textDisabled: '#b8ac9c',
      textInverse: '#f4ecd8',
      accentPrimary: '#8b7355',
      accentSecondary: '#6b5540',
      accentHover: '#a08b70',
      accentActive: '#6b5540',
      borderPrimary: '#d4cab6',
      borderSecondary: '#e2d9c5',
    },
  },
  {
    id: 'coffee',
    name: 'Coffee',
    category: 'Fun & Nostalgic',
    isDark: true,
    colors: {
      bgPrimary: '#1c1612',
      bgSecondary: '#2a211a',
      bgTertiary: '#382c23',
      bgHover: '#46382c',
      bgActive: '#554435',
      bgInput: '#2a211a',
      bgModal: '#1c1612',
      bgOverlay: 'rgba(28, 22, 18, 0.9)',
      textPrimary: '#f5e6d3',
      textSecondary: '#c4a882',
      textTertiary: '#9c8468',
      textDisabled: '#554435',
      textInverse: '#1c1612',
      accentPrimary: '#c4a882',
      accentSecondary: '#9c8468',
      accentHover: '#d4b892',
      accentActive: '#a49272',
      borderPrimary: '#46382c',
      borderSecondary: '#382c23',
    },
  },
  {
    id: 'berry',
    name: 'Berry',
    category: 'Fun & Nostalgic',
    isDark: true,
    colors: {
      bgPrimary: '#1a0f1f',
      bgSecondary: '#251529',
      bgTertiary: '#301b33',
      bgHover: '#3d223f',
      bgActive: '#4a294b',
      bgInput: '#251529',
      bgModal: '#1a0f1f',
      bgOverlay: 'rgba(26, 15, 31, 0.9)',
      textPrimary: '#f5e6ff',
      textSecondary: '#d4a5e8',
      textTertiary: '#b374c4',
      textDisabled: '#4a294b',
      textInverse: '#1a0f1f',
      accentPrimary: '#9f4bc4',
      accentSecondary: '#7c3a9d',
      accentHover: '#b86dd4',
      accentActive: '#7c3a9d',
      borderPrimary: '#3d223f',
      borderSecondary: '#301b33',
    },
  },
];

// Helper to get theme by ID
export function getTheme(id: string): ThemeDefinition | undefined {
  return themes.find(t => t.id === id);
}

// Get themes grouped by category
export function getThemesByCategory(): Map<ThemeCategory, ThemeDefinition[]> {
  const grouped = new Map<ThemeCategory, ThemeDefinition[]>();

  for (const category of categoryOrder) {
    grouped.set(category, themes.filter(t => t.category === category));
  }

  return grouped;
}

// Get all theme IDs
export function getThemeIds(): string[] {
  return themes.map(t => t.id);
}

// Check if a theme ID is valid
export function isValidTheme(id: string): boolean {
  return themes.some(t => t.id === id);
}

// Get only dark themes (for dark mode preference dropdown)
export function getDarkThemes(): ThemeDefinition[] {
  return themes.filter(t => t.isDark);
}

// Get only light themes (for light mode preference dropdown)
export function getLightThemes(): ThemeDefinition[] {
  return themes.filter(t => !t.isDark);
}

/**
 * Generate CSS custom properties for a theme.
 * Used for dynamically injecting user theme styles.
 */
// System font stack appended after a preferred font so a family that isn't
// installed on this machine fails open to the platform default. Mirrors the
// --font-sans default in styles/theme.css.
export const SYSTEM_FONT_FALLBACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', " +
  "'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif, " +
  "'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji'";

// Font-family values from theme JSON are interpolated into injected CSS —
// strip anything that could break out of the declaration (braces, semicolons,
// parens block url()/expression forms). Letters, digits, spaces, commas,
// quotes, hyphens, and underscores cover any legitimate font stack.
export function sanitizeFontFamily(value: string): string {
  return value.replace(/[^A-Za-z0-9 ,'"_-]/g, '').trim();
}

export function generateThemeCSS(theme: ThemeDefinition): string {
  const { colors, transparency, fonts } = theme;

  // Default status colors if not provided
  const statusSuccess = colors.statusSuccess || '#10b981';
  const statusWarning = colors.statusWarning || '#f59e0b';
  const statusError = colors.statusError || '#ef4444';
  const statusInfo = colors.statusInfo || '#3b82f6';

  // Transparency settings (only included if theme defines them)
  const transparencyCSS = transparency
    ? `
  /* Transparency Settings */
  --transparency-sidebar: ${transparency.sidebar ?? 1};
  --transparency-main: ${transparency.mainContent ?? 1};
  --ui-blur: ${transparency.uiBlur ?? 0}px;`
    : '';

  // Font stacks (only included if theme defines them). The user's Settings
  // font preference is applied as an inline style on the root, so it always
  // overrides these.
  const fontLines = [
    fonts?.sans ? `\n  --font-sans: ${sanitizeFontFamily(fonts.sans)};` : '',
    fonts?.mono ? `\n  --font-mono: ${sanitizeFontFamily(fonts.mono)};` : '',
  ].join('');
  const fontsCSS = fontLines ? `\n\n  /* Fonts */${fontLines}` : '';

  return `[data-theme='${theme.id}'] {
  /* Background Colors */
  --bg-primary: ${colors.bgPrimary};
  --bg-secondary: ${colors.bgSecondary};
  --bg-tertiary: ${colors.bgTertiary};
  --bg-hover: ${colors.bgHover};
  --bg-active: ${colors.bgActive};
  --bg-input: ${colors.bgInput};
  --bg-modal: ${colors.bgModal};
  --bg-overlay: ${colors.bgOverlay};

  /* Text Colors */
  --text-primary: ${colors.textPrimary};
  --text-secondary: ${colors.textSecondary};
  --text-tertiary: ${colors.textTertiary};
  --text-disabled: ${colors.textDisabled};
  --text-inverse: ${colors.textInverse};

  /* Accent Colors */
  --accent-primary: ${colors.accentPrimary};
  --accent-secondary: ${colors.accentSecondary};
  --accent-hover: ${colors.accentHover};
  --accent-active: ${colors.accentActive};

  /* Status Colors */
  --status-success: ${statusSuccess};
  --status-warning: ${statusWarning};
  --status-error: ${statusError};
  --status-info: ${statusInfo};

  /* Border Colors */
  --border-primary: ${colors.borderPrimary};
  --border-secondary: ${colors.borderSecondary};
  --border-focus: var(--accent-primary);
  --border-error: var(--status-error);${transparencyCSS}${fontsCSS}
}`;
}
