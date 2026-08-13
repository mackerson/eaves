import { useState, useMemo } from 'react';
import { Check, ChevronDown, ChevronRight, FolderOpen, Sparkles } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import {
  themes,
  categoryOrder,
  type ThemeDefinition,
  type ThemeCategory,
} from '@/styles/themes';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

interface ThemeSwatchProps {
  theme: ThemeDefinition;
  isSelected: boolean;
  onClick: () => void;
}

function ThemeSwatch({ theme, isSelected, onClick }: ThemeSwatchProps) {
  return (
    <button
      onClick={onClick}
      className={`
        relative flex flex-col items-center gap-1 p-2 rounded-lg transition-all
        hover:scale-105 focus:outline-none focus:ring-2 focus:ring-accent-primary
        ${isSelected ? 'ring-2 ring-accent-primary' : 'hover:bg-[var(--bg-hover)]'}
      `}
      title={theme.name}
    >
      {/* Color preview swatch */}
      <div
        className="w-12 h-10 rounded-md border border-[var(--border-primary)] overflow-hidden shadow-sm"
        style={{ backgroundColor: theme.colors.bgPrimary }}
      >
        {/* Show accent color stripe */}
        <div
          className="h-2 w-full"
          style={{ backgroundColor: theme.colors.accentPrimary }}
        />
        {/* Show text preview */}
        <div className="p-1 flex flex-col gap-0.5">
          <div
            className="h-1 w-6 rounded-full"
            style={{ backgroundColor: theme.colors.textPrimary }}
          />
          <div
            className="h-1 w-4 rounded-full"
            style={{ backgroundColor: theme.colors.textSecondary }}
          />
        </div>
      </div>

      {/* Theme name */}
      <span className="text-xs text-[var(--text-secondary)] truncate max-w-[60px]">
        {theme.name}
      </span>

      {/* User theme indicator */}
      {theme.isUserTheme && (
        <div className="absolute top-1 left-1 w-4 h-4 bg-[var(--accent-secondary)] rounded-full flex items-center justify-center" title="Custom theme">
          <Sparkles className="w-2.5 h-2.5 text-[var(--text-inverse)]" />
        </div>
      )}

      {/* Selected indicator */}
      {isSelected && (
        <div className="absolute top-1 right-1 w-4 h-4 bg-[var(--accent-primary)] rounded-full flex items-center justify-center">
          <Check className="w-3 h-3 text-[var(--text-inverse)]" />
        </div>
      )}
    </button>
  );
}

interface CategorySectionProps {
  category: ThemeCategory;
  themes: ThemeDefinition[];
  currentTheme: string;
  onSelectTheme: (themeId: string) => void;
  defaultExpanded?: boolean;
}

function CategorySection({
  category,
  themes,
  currentTheme,
  onSelectTheme,
  defaultExpanded = false,
}: CategorySectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border-b border-[var(--border-secondary)] last:border-b-0">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 py-2 px-1 hover:bg-[var(--bg-hover)] rounded transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-[var(--text-tertiary)]" />
        ) : (
          <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
        )}
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {category}
        </span>
        <span className="text-xs text-[var(--text-tertiary)]">
          ({themes.length})
        </span>
      </button>

      {isExpanded && (
        <div className="flex flex-wrap gap-2 py-3 px-1">
          {themes.map((theme) => (
            <ThemeSwatch
              key={theme.id}
              theme={theme}
              isSelected={currentTheme === theme.id}
              onClick={() => onSelectTheme(theme.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ThemeSelector() {
  const {
    theme,
    lightTheme,
    darkTheme,
    setTheme,
    setLightTheme,
    setDarkTheme,
    allThemes,
    userThemes,
  } = useTheme();

  // Group themes by category, including user themes in 'Custom' category
  const themesByCategory = useMemo(() => {
    const grouped = new Map<ThemeCategory, ThemeDefinition[]>();

    // Initialize with bundled themes
    for (const category of categoryOrder) {
      grouped.set(category, themes.filter(t => t.category === category));
    }

    // Add user themes to Custom category
    if (userThemes.length > 0) {
      const customThemes = grouped.get('Custom') || [];
      grouped.set('Custom', [...customThemes, ...userThemes]);
    }

    return grouped;
  }, [userThemes]);

  // Get light and dark themes including user themes
  const lightThemes = useMemo(() => allThemes.filter(t => !t.isDark), [allThemes]);
  const darkThemes = useMemo(() => allThemes.filter(t => t.isDark), [allThemes]);

  const handleOpenThemesDirectory = async () => {
    await window.electron.openThemesDirectory();
  };

  return (
    <div className="space-y-6">
      {/* Theme Grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>Theme</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenThemesDirectory}
            className="text-xs gap-1.5"
            title="Open themes folder to add custom themes"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Custom Themes
          </Button>
        </div>
        <div className="border border-[var(--border-primary)] rounded-lg bg-[var(--bg-secondary)]">
          {categoryOrder.map((category, index) => {
            const categoryThemes = themesByCategory.get(category) || [];
            // Don't show empty categories (except Custom when there are user themes)
            if (categoryThemes.length === 0) return null;
            return (
              <CategorySection
                key={category}
                category={category}
                themes={categoryThemes}
                currentTheme={theme}
                onSelectTheme={setTheme}
                defaultExpanded={index === 0 || (category === 'Custom' && userThemes.length > 0)}
              />
            );
          })}
        </div>
        {userThemes.length === 0 && (
          <p className="text-xs text-[var(--text-tertiary)] mt-2">
            Add custom themes by creating a folder with theme.json in the themes directory
          </p>
        )}
      </div>

      {/* Quick Toggle Preferences */}
      <div className="pt-4 border-t border-[var(--border-secondary)]">
        <Label className="mb-3 block">Quick Toggle Preferences</Label>
        <p className="text-xs text-[var(--text-tertiary)] mb-4">
          Choose which themes the quick toggle button switches between
        </p>

        <div className="grid grid-cols-2 gap-4">
          {/* Light Theme Preference */}
          <div className="space-y-2">
            <Label htmlFor="light-theme-select" className="text-sm">
              Light Mode Theme
            </Label>
            <select
              id="light-theme-select"
              value={lightTheme}
              onChange={(e) => setLightTheme(e.target.value)}
              className="w-full px-3 py-2 border border-[var(--border-primary)] rounded-md bg-[var(--bg-input)] text-[var(--text-primary)] text-sm"
            >
              {lightThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.isUserTheme ? ' (Custom)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Dark Theme Preference */}
          <div className="space-y-2">
            <Label htmlFor="dark-theme-select" className="text-sm">
              Dark Mode Theme
            </Label>
            <select
              id="dark-theme-select"
              value={darkTheme}
              onChange={(e) => setDarkTheme(e.target.value)}
              className="w-full px-3 py-2 border border-[var(--border-primary)] rounded-md bg-[var(--bg-input)] text-[var(--text-primary)] text-sm"
            >
              {darkThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.isUserTheme ? ' (Custom)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
