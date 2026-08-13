import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  getTheme,
  isValidTheme,
  themes,
  ThemeDefinition,
  generateThemeCSS,
  SYSTEM_FONT_FALLBACK,
} from '@/styles/themes';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { applyShadcnTokens } from '@/lib/shadcnTokens';

// Theme is now a string ID (e.g., 'dark', 'dracula', 'nord')
export type Theme = string;

/**
 * Normalize a CSS color token to the 6-digit hex `setTitleBarOverlay` accepts.
 * Custom properties come back as authored, so this sees `#abc`, `#aabbcc`,
 * `#aabbccdd`, or `rgb()/rgba()`. Alpha is dropped — the native caption bar
 * can't be translucent. Returns null for anything unrecognized, which the
 * caller treats as "leave the overlay alone".
 */
function toHex6(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return `#${hex.slice(0, 3).split('').map((c) => c + c).join('')}`;
    }
    if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`;
    return null;
  }

  const parts = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (!parts) return null;
  const [r, g, b] = parts.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

interface ThemeContextType {
  theme: Theme;
  lightTheme: Theme;
  darkTheme: Theme;
  setTheme: (theme: Theme) => void;
  setLightTheme: (theme: Theme) => void;
  setDarkTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  isDark: boolean;
  userThemes: ThemeDefinition[];
  allThemes: ThemeDefinition[];
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Style element ID for injected user theme CSS
const USER_THEME_STYLE_ID = 'user-theme-styles';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme = 'dark' }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [lightTheme, setLightThemeState] = useState<Theme>('light');
  const [darkTheme, setDarkThemeState] = useState<Theme>('dark');
  const [userThemes, setUserThemes] = useState<ThemeDefinition[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  // Combine bundled themes with user themes
  const allThemes = [...themes, ...userThemes];

  // Check if theme is valid (bundled or user theme)
  const isThemeValid = useCallback((id: string) => {
    return isValidTheme(id) || userThemes.some(t => t.id === id);
  }, [userThemes]);

  // Get theme definition (bundled or user)
  const getThemeDefinition = useCallback((id: string): ThemeDefinition | undefined => {
    return getTheme(id) || userThemes.find(t => t.id === id);
  }, [userThemes]);

  // Get whether current theme is dark
  const isDark = getThemeDefinition(theme)?.isDark ?? true;

  // Inject CSS for user themes
  const injectUserThemeCSS = useCallback((themesToInject: ThemeDefinition[]) => {
    // Remove existing style element
    const existing = document.getElementById(USER_THEME_STYLE_ID);
    if (existing) {
      existing.remove();
    }

    if (themesToInject.length === 0) return;

    // Generate and inject CSS for all user themes
    const css = themesToInject.map(t => generateThemeCSS(t)).join('\n\n');
    const style = document.createElement('style');
    style.id = USER_THEME_STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }, []);

  // Load theme and user themes on mount
  useEffect(() => {
    async function loadTheme() {
      try {
        // Load user themes first
        const loadedUserThemes = await window.electron.getUserThemes();
        setUserThemes(loadedUserThemes);
        injectUserThemeCSS(loadedUserThemes);

        const memory = await window.electron.getMemory();
        const settings = memory.settings;

        // Load current theme
        const savedTheme = settings?.theme;
        const userThemeIds = loadedUserThemes.map((t: ThemeDefinition) => t.id);
        if (savedTheme && (isValidTheme(savedTheme) || userThemeIds.includes(savedTheme))) {
          setThemeState(savedTheme);
        }

        // Load preferred light/dark themes for toggle
        const savedLightTheme = settings?.lightTheme;
        if (savedLightTheme && (isValidTheme(savedLightTheme) || userThemeIds.includes(savedLightTheme))) {
          setLightThemeState(savedLightTheme);
        }

        const savedDarkTheme = settings?.darkTheme;
        if (savedDarkTheme && (isValidTheme(savedDarkTheme) || userThemeIds.includes(savedDarkTheme))) {
          setDarkThemeState(savedDarkTheme);
        }
      } catch (error) {
        console.error('Failed to load theme from settings:', error);
      } finally {
        setIsInitialized(true);
      }
    }

    loadTheme();
  }, [injectUserThemeCSS]);

  // Listen for user theme hot-reload events
  useEffect(() => {
    const handleThemeAdded = (newTheme: ThemeDefinition) => {
      setUserThemes(prev => {
        const updated = [...prev.filter(t => t.id !== newTheme.id), newTheme];
        injectUserThemeCSS(updated);
        return updated;
      });
    };

    const handleThemeUpdated = (updatedTheme: ThemeDefinition) => {
      setUserThemes(prev => {
        const updated = prev.map(t => t.id === updatedTheme.id ? updatedTheme : t);
        injectUserThemeCSS(updated);
        return updated;
      });
    };

    const handleThemeRemoved = (data: { id: string }) => {
      setUserThemes(prev => {
        const updated = prev.filter(t => t.id !== data.id);
        injectUserThemeCSS(updated);
        // If current theme was removed, switch to default
        if (theme === data.id) {
          setThemeState('dark');
        }
        return updated;
      });
    };

    const cleanupAdded = window.electron.on('theme:added', handleThemeAdded);
    const cleanupUpdated = window.electron.on('theme:updated', handleThemeUpdated);
    const cleanupRemoved = window.electron.on('theme:removed', handleThemeRemoved);

    return () => {
      cleanupAdded();
      cleanupUpdated();
      cleanupRemoved();
    };
  }, [theme, injectUserThemeCSS]);

  // Apply theme to DOM
  useEffect(() => {
    if (!isInitialized) return;

    const root = document.documentElement;
    const themeDef = getThemeDefinition(theme);

    // Set data-theme attribute for CSS variable selection
    root.setAttribute('data-theme', theme);

    // Set classes for both custom theme.css and Tailwind/shadcn
    // Remove all possible theme classes first
    root.classList.remove('theme-dark', 'theme-light', 'light', 'dark');
    allThemes.forEach(t => root.classList.remove(`theme-${t.id}`));

    // Add theme-specific class
    root.classList.add(`theme-${theme}`);

    // For Tailwind/shadcn dark mode - they expect 'light' or 'dark' class
    if (themeDef?.isDark) {
      root.classList.add('dark');
    } else {
      root.classList.add('light');
    }

    // Derive shadcn tokens (--primary, --border, …) from the theme palette so
    // Button/Input/etc. follow every theme, including user themes.
    applyShadcnTokens(root, themeDef);

    // Apply theme transparency settings if defined
    if (themeDef?.transparency) {
      const t = themeDef.transparency;
      root.style.setProperty('--transparency-sidebar', String(t.sidebar ?? 1));
      root.style.setProperty('--transparency-main', String(t.mainContent ?? 1));
      root.style.setProperty('--ui-blur', `${t.uiBlur ?? 0}px`);
    } else {
      // Reset to defaults if theme doesn't define transparency
      root.style.removeProperty('--transparency-sidebar');
      root.style.removeProperty('--transparency-main');
      root.style.removeProperty('--ui-blur');
    }
  }, [theme, isInitialized, getThemeDefinition, allThemes]);

  // Keep the Windows caption buttons in step with the theme. The overlay lives
  // in the native frame, so it can't inherit CSS — read the resolved values
  // back off the root instead of duplicating the palette here. No-op wherever
  // there is no overlay; failures are cosmetic, so they stay swallowed.
  useEffect(() => {
    if (!isInitialized || window.electron?.platform !== 'win32') return;

    // rAF so the [data-theme] switch above has painted and the computed
    // values are the new theme's, not the outgoing one's.
    const id = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const color = toHex6(styles.getPropertyValue('--bg-secondary'));
      const symbolColor = toHex6(styles.getPropertyValue('--text-primary'));
      if (!color || !symbolColor) return;
      void window.electron.setTitleBarOverlay({ color, symbolColor }).catch(() => { /* cosmetic */ });
    });
    return () => cancelAnimationFrame(id);
  }, [theme, isInitialized]);

  // Apply background active state to DOM
  // This enables transparent UI when a background is configured
  const background = useSettingsStore((state) => state.settings.background);

  useEffect(() => {
    if (!isInitialized) return;

    const root = document.documentElement;
    const hasBackground = background && background.type !== 'none';

    // Set data attribute that triggers transparent CSS variables
    root.setAttribute('data-background-active', String(!!hasBackground));
  }, [background, isInitialized]);

  // Apply the user's font preferences (Settings → Appearance) as inline styles
  // on the root. Inline styles outrank both the :root defaults in theme.css
  // and any per-theme [data-theme] font blocks, so an accessibility choice
  // survives theme switches; 'default' / 1.0 removes the override so theme
  // fonts show through again.
  const fontFamily = useSettingsStore((state) => state.settings.fontFamily);
  const customFontFamily = useSettingsStore((state) => state.settings.customFontFamily);
  const fontScale = useSettingsStore((state) => state.settings.fontScale);
  const lineSpacing = useSettingsStore((state) => state.settings.lineSpacing);

  useEffect(() => {
    const root = document.documentElement;

    let family: string | null = null;
    if (fontFamily === 'open-dyslexic') {
      family = `'OpenDyslexic', ${SYSTEM_FONT_FALLBACK}`;
    } else if (fontFamily === 'custom') {
      // Single family name, quoted below — same character class the
      // UpdateSettingsSchema enforces, so quotes/commas can't break out.
      const name = (customFontFamily ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim();
      // Fails open: an uninstalled family name falls through to the fallback
      // stack at render time.
      if (name) family = `'${name}', ${SYSTEM_FONT_FALLBACK}`;
    }

    if (family) {
      root.style.setProperty('--font-sans', family);
    } else {
      root.style.removeProperty('--font-sans');
    }

    if (fontScale && fontScale !== 1) {
      root.style.setProperty('--font-scale', String(fontScale));
    } else {
      root.style.removeProperty('--font-scale');
    }

    if (lineSpacing && lineSpacing !== 1) {
      root.style.setProperty('--line-scale', String(lineSpacing));
    } else {
      root.style.removeProperty('--line-scale');
    }
  }, [fontFamily, customFontFamily, fontScale, lineSpacing]);

  const setTheme = async (newTheme: Theme) => {
    if (!isThemeValid(newTheme)) {
      console.warn(`Invalid theme: ${newTheme}`);
      return;
    }

    setThemeState(newTheme);

    // Save to settings
    try {
      await window.electron.updateSettings({ theme: newTheme });
    } catch (error) {
      console.error('Failed to save theme to settings:', error);
    }
  };

  const setLightTheme = async (newTheme: Theme) => {
    if (!isThemeValid(newTheme)) {
      console.warn(`Invalid light theme: ${newTheme}`);
      return;
    }

    setLightThemeState(newTheme);

    try {
      await window.electron.updateSettings({ lightTheme: newTheme });
    } catch (error) {
      console.error('Failed to save light theme preference:', error);
    }
  };

  const setDarkTheme = async (newTheme: Theme) => {
    if (!isThemeValid(newTheme)) {
      console.warn(`Invalid dark theme: ${newTheme}`);
      return;
    }

    setDarkThemeState(newTheme);

    try {
      await window.electron.updateSettings({ darkTheme: newTheme });
    } catch (error) {
      console.error('Failed to save dark theme preference:', error);
    }
  };

  // Toggle between user's preferred light and dark themes
  const toggleTheme = () => {
    const currentIsDark = getThemeDefinition(theme)?.isDark ?? true;
    const newTheme = currentIsDark ? lightTheme : darkTheme;
    setTheme(newTheme);
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        lightTheme,
        darkTheme,
        setTheme,
        setLightTheme,
        setDarkTheme,
        toggleTheme,
        isDark,
        userThemes,
        allThemes,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
