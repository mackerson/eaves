import { useTheme } from '../contexts/ThemeContext';
import { getTheme } from '@/styles/themes';

export function ThemeToggle() {
  const { lightTheme, darkTheme, isDark, toggleTheme } = useTheme();

  // Get the name of the theme we'll switch to
  const targetTheme = isDark ? lightTheme : darkTheme;
  const targetThemeName = getTheme(targetTheme)?.name || targetTheme;

  return (
    <button
      onClick={toggleTheme}
      className="theme-toggle"
      title={`Switch to ${targetThemeName}`}
      aria-label={`Switch to ${targetThemeName}`}
    >
      {isDark ? '\u2600\uFE0F' : '\uD83C\uDF19'}
    </button>
  );
}
