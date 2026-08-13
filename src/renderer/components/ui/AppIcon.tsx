/**
 * AppIcon Component
 *
 * Universal icon component that renders based on current icon set (emoji/pixelart)
 * Usage: <AppIcon name="chat" size={24} />
 */

import { useIconSet } from '@/contexts/IconContext';
import { IconName, getIcon } from './icon-registry';

interface AppIconProps {
  name: IconName;
  size?: number | string;
  className?: string;
  onClick?: () => void;
  title?: string;
}

export function AppIcon({ name, size = 24, className = '', onClick, title }: AppIconProps) {
  const { iconSet } = useIconSet();
  const icon = getIcon(name, iconSet, size, className);

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`inline-flex items-center justify-center ${className}`}
        title={title}
        type="button"
      >
        {icon}
      </button>
    );
  }

  return (
    <span className={`inline-flex items-center justify-center ${className}`} title={title}>
      {icon}
    </span>
  );
}

