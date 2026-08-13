import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './logger';
import { ThemeColors, ThemeDefinition } from '../../shared/types';

export type { ThemeColors, ThemeDefinition };

/**
 * Required color keys that must be present in a theme
 */
const REQUIRED_COLOR_KEYS: (keyof ThemeColors)[] = [
  'bgPrimary', 'bgSecondary', 'bgTertiary', 'bgHover', 'bgActive', 'bgInput', 'bgModal', 'bgOverlay',
  'textPrimary', 'textSecondary', 'textTertiary', 'textDisabled', 'textInverse',
  'accentPrimary', 'accentSecondary', 'accentHover', 'accentActive',
  'borderPrimary', 'borderSecondary',
];

/**
 * ThemeManager service
 * Handles loading bundled and user themes, validation, and CSS generation
 */
class ThemeManagerService {
  private _userThemesDir: string | null = null;
  private userThemes: Map<string, ThemeDefinition> = new Map();

  private get userThemesDir(): string {
    if (!this._userThemesDir) {
      this._userThemesDir = path.join(app.getPath('userData'), 'themes');
      if (!fs.existsSync(this._userThemesDir)) {
        fs.mkdirSync(this._userThemesDir, { recursive: true });
        logger.info('[ThemeManager] Created user themes directory', { path: this._userThemesDir });
      }
    }
    return this._userThemesDir;
  }

  /**
   * Get the user themes directory path
   */
  getThemesDirectory(): string {
    return this.userThemesDir;
  }

  /**
   * Load all user themes from the themes directory
   */
  loadUserThemes(): ThemeDefinition[] {
    this.userThemes.clear();

    try {
      const entries = fs.readdirSync(this.userThemesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const themePath = path.join(this.userThemesDir, entry.name, 'theme.json');
          if (fs.existsSync(themePath)) {
            const theme = this.loadThemeFromFile(themePath);
            if (theme) {
              this.userThemes.set(theme.id, theme);
            }
          }
        }
      }

      logger.info('[ThemeManager] Loaded user themes', { count: this.userThemes.size });
    } catch (error) {
      logger.error('[ThemeManager] Failed to load user themes', { error });
    }

    return Array.from(this.userThemes.values());
  }

  /**
   * Load a single theme from a file path
   */
  loadThemeFromFile(filePath: string): ThemeDefinition | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Validate the theme
      const validation = this.validateTheme(data);
      if (!validation.valid) {
        logger.warn('[ThemeManager] Invalid theme file', { filePath, errors: validation.errors });
        return null;
      }

      const theme: ThemeDefinition = {
        id: data.id,
        name: data.name,
        category: data.category || 'Custom',
        isDark: data.isDark ?? true,
        colors: data.colors,
        fonts: data.fonts, // Optional font stacks (sanitized at CSS generation)
        background: data.background, // Optional bundled background
        transparency: data.transparency, // Optional transparency settings
        iconSet: data.iconSet, // Optional icon set preference
        isUserTheme: true,
        filePath,
      };

      logger.debug('[ThemeManager] Loaded theme', { id: theme.id, name: theme.name });
      return theme;
    } catch (error) {
      logger.error('[ThemeManager] Failed to load theme file', { filePath, error });
      return null;
    }
  }

  /**
   * Validate a theme definition
   */
  validateTheme(data: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Required fields
    if (!data.id || typeof data.id !== 'string') {
      errors.push('Missing or invalid "id" field');
    }

    if (!data.name || typeof data.name !== 'string') {
      errors.push('Missing or invalid "name" field');
    }

    if (typeof data.isDark !== 'boolean' && data.isDark !== undefined) {
      errors.push('"isDark" must be a boolean');
    }

    // Fonts validation (optional)
    if (data.fonts !== undefined) {
      if (!data.fonts || typeof data.fonts !== 'object') {
        errors.push('"fonts" must be an object');
      } else {
        for (const key of ['sans', 'mono'] as const) {
          if (data.fonts[key] !== undefined && typeof data.fonts[key] !== 'string') {
            errors.push(`"fonts.${key}" must be a string`);
          }
        }
      }
    }

    // Colors validation
    if (!data.colors || typeof data.colors !== 'object') {
      errors.push('Missing or invalid "colors" object');
    } else {
      for (const key of REQUIRED_COLOR_KEYS) {
        if (!data.colors[key] || typeof data.colors[key] !== 'string') {
          errors.push(`Missing or invalid color: "${key}"`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get a user theme by ID
   */
  getUserTheme(id: string): ThemeDefinition | undefined {
    return this.userThemes.get(id);
  }

  /**
   * Get all user themes
   */
  getAllUserThemes(): ThemeDefinition[] {
    return Array.from(this.userThemes.values());
  }

  /**
   * Check if a theme ID belongs to a user theme
   */
  isUserTheme(id: string): boolean {
    return this.userThemes.has(id);
  }

  /**
   * Generate CSS custom properties for a theme
   */
  generateThemeCSS(theme: ThemeDefinition): string {
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

    // Font stacks (only included if theme defines them). Values come from
    // user-authored theme.json and are interpolated into CSS — sanitize so
    // they can't break out of the declaration. Mirrors
    // src/renderer/styles/themes.ts sanitizeFontFamily.
    const sanitizeFont = (value: string) => value.replace(/[^A-Za-z0-9 ,'"_-]/g, '').trim();
    const fontLines = [
      fonts?.sans ? `\n  --font-sans: ${sanitizeFont(fonts.sans)};` : '',
      fonts?.mono ? `\n  --font-mono: ${sanitizeFont(fonts.mono)};` : '',
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

  /**
   * Add or update a user theme (triggered by file watcher)
   */
  addOrUpdateTheme(filePath: string): ThemeDefinition | null {
    const theme = this.loadThemeFromFile(filePath);
    if (theme) {
      this.userThemes.set(theme.id, theme);
      logger.info('[ThemeManager] Theme added/updated', { id: theme.id });
    }
    return theme;
  }

  /**
   * Remove a user theme by file path (triggered by file watcher)
   */
  removeThemeByPath(filePath: string): string | null {
    for (const [id, theme] of this.userThemes) {
      if (theme.filePath === filePath) {
        this.userThemes.delete(id);
        logger.info('[ThemeManager] Theme removed', { id });
        return id;
      }
    }
    return null;
  }

  /**
   * Remove a user theme by ID
   */
  removeTheme(id: string): boolean {
    if (this.userThemes.has(id)) {
      this.userThemes.delete(id);
      logger.info('[ThemeManager] Theme removed', { id });
      return true;
    }
    return false;
  }
}

let _themeManagerInstance: ThemeManagerService | null = null;
export function getThemeManager(): ThemeManagerService {
  if (!_themeManagerInstance) _themeManagerInstance = new ThemeManagerService();
  return _themeManagerInstance;
}
export const themeManager = getThemeManager();
