/**
 * Icon Context
 *
 * Provides current icon set across the application.
 * Icon set is determined by the current theme's iconSet preference.
 */

import React, { createContext, useContext, useMemo } from 'react';
import { IconSet } from '@/components/ui/icon-registry';
import { useTheme } from '@/contexts/ThemeContext';
import { getTheme } from '@/styles/themes';

interface IconContextValue {
  iconSet: IconSet;
}

const IconContext = createContext<IconContextValue | undefined>(undefined);

export function IconProvider({ children }: { children: React.ReactNode }) {
  const { theme, userThemes } = useTheme();

  const iconSet = useMemo((): IconSet => {
    // Check bundled themes first
    const bundledTheme = getTheme(theme);
    if (bundledTheme?.iconSet) {
      return bundledTheme.iconSet;
    }
    // Check user themes
    const userTheme = userThemes.find((t) => t.id === theme);
    if (userTheme?.iconSet) {
      return userTheme.iconSet;
    }
    // Default to lucide
    return 'lucide';
  }, [theme, userThemes]);

  return (
    <IconContext.Provider value={{ iconSet }}>
      {children}
    </IconContext.Provider>
  );
}

export function useIconSet() {
  const context = useContext(IconContext);
  if (!context) {
    throw new Error('useIconSet must be used within IconProvider');
  }
  return context;
}
