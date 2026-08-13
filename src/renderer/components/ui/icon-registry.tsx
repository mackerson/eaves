/**
 * Centralized Icon Registry
 *
 * Maps semantic icon names to different icon sets (emoji, pixelart, etc.)
 * Allows theme-based icon swapping across the entire application.
 */

import React from 'react';
import { Icon } from './icon';
import type { LucideIcon } from 'lucide-react';
import {
  MessageCircle,
  Hash,
  Folder,
  StickyNote,
  ListChecks,
  Calendar,
  Workflow,
  RefreshCw,
  Activity,
  Plug,
  Settings,
  LayoutDashboard,
  Import,
  Globe,
  Cloud,
  CloudUpload,
  Store,
  Brain,
  ScanSearch,
  Plus,
  Pencil,
  Trash2,
  Search,
  X,
  Check,
  Save,
  MessageSquare,
  FileText,
  SquareCheckBig,
  Bot,
  User,
  FolderKanban,
  TriangleAlert,
  CircleX,
  CircleCheck,
  Info,
  ChevronRight,
  ChevronDown,
  Menu,
  Ellipsis,
} from 'lucide-react';

export type IconName =
  // Navigation & Views
  | 'chat'
  | 'channels'
  | 'files'
  | 'notes'
  | 'tasks'
  | 'calendar'
  | 'workflows'
  | 'routines'
  | 'activity'
  | 'plugins'
  | 'settings'
  | 'dashboard'
  | 'imports'

  // Plugin icons
  | 'browser'
  | 'cloud'
  | 'sync'
  | 'marketplace'
  | 'memory'
  | 'inspector'

  // Actions
  | 'add'
  | 'edit'
  | 'delete'
  | 'search'
  | 'refresh'
  | 'close'
  | 'check'
  | 'save'

  // Content types
  | 'message'
  | 'file'
  | 'folder'
  | 'note'
  | 'task'
  | 'agent'
  | 'user'
  | 'project'

  // Status
  | 'alert'
  | 'error'
  | 'success'
  | 'info'
  | 'warning'

  // Misc
  | 'expand'
  | 'collapse'
  | 'menu'
  | 'more';

export type IconSet = 'emoji' | 'pixelart' | 'lucide';

interface IconConfig {
  emoji: string;
  pixelart?: string; // pixel art icon name
  lucide: LucideIcon;
  component?: React.ComponentType<any>; // custom component
}

/**
 * Icon Registry
 * Define all app icons here with their emoji and pixel art variants
 */
export const iconRegistry: Record<IconName, IconConfig> = {
  // Navigation & Views
  chat: { emoji: '💬', pixelart: 'chat', lucide: MessageCircle },
  channels: { emoji: '💬', pixelart: 'chat', lucide: Hash },
  files: { emoji: '📁', pixelart: 'folder', lucide: Folder },
  notes: { emoji: '📝', pixelart: 'note', lucide: StickyNote },
  tasks: { emoji: '✓', pixelart: 'checkbox', lucide: ListChecks },
  calendar: { emoji: '📅', pixelart: 'calendar', lucide: Calendar },
  workflows: { emoji: '🔀', pixelart: 'git-branch', lucide: Workflow },
  routines: { emoji: '🔄', pixelart: 'reload', lucide: RefreshCw },
  activity: { emoji: '📊', pixelart: 'chart', lucide: Activity },
  plugins: { emoji: '🔌', pixelart: 'power', lucide: Plug },
  settings: { emoji: '⚙️', pixelart: 'sliders', lucide: Settings },
  dashboard: { emoji: '📊', pixelart: 'calendar', lucide: LayoutDashboard }, // placeholder
  imports: { emoji: '📥', pixelart: 'folder', lucide: Import }, // placeholder

  // Plugin icons
  browser: { emoji: '🌐', pixelart: 'external-link', lucide: Globe },
  cloud: { emoji: '☁️', pixelart: 'cloud', lucide: Cloud },
  sync: { emoji: '🔄', pixelart: 'cloud-upload', lucide: CloudUpload },
  marketplace: { emoji: '🛒', pixelart: 'store', lucide: Store },
  memory: { emoji: '🧠', pixelart: 'folder', lucide: Brain }, // placeholder
  inspector: { emoji: '🔍', pixelart: 'search', lucide: ScanSearch },

  // Actions
  add: { emoji: '➕', pixelart: 'plus', lucide: Plus },
  edit: { emoji: '✏️', pixelart: 'edit', lucide: Pencil },
  delete: { emoji: '🗑️', pixelart: 'trash', lucide: Trash2 },
  search: { emoji: '🔍', pixelart: 'search', lucide: Search },
  refresh: { emoji: '🔄', pixelart: 'reload', lucide: RefreshCw },
  close: { emoji: '✕', pixelart: 'close', lucide: X },
  check: { emoji: '✓', pixelart: 'check', lucide: Check },
  save: { emoji: '💾', pixelart: 'check', lucide: Save }, // placeholder

  // Content types
  message: { emoji: '💬', pixelart: 'message', lucide: MessageSquare },
  file: { emoji: '📄', pixelart: 'file', lucide: FileText },
  folder: { emoji: '📁', pixelart: 'folder', lucide: Folder },
  note: { emoji: '📝', pixelart: 'note', lucide: StickyNote },
  task: { emoji: '✓', pixelart: 'checkbox', lucide: SquareCheckBig },
  agent: { emoji: '🤖', pixelart: 'chat', lucide: Bot }, // placeholder
  user: { emoji: '👤', pixelart: 'chat', lucide: User }, // placeholder
  project: { emoji: '📊', pixelart: 'folder', lucide: FolderKanban },

  // Status
  alert: { emoji: '⚠️', pixelart: 'alert', lucide: TriangleAlert },
  error: { emoji: '❌', pixelart: 'close', lucide: CircleX },
  success: { emoji: '✅', pixelart: 'check', lucide: CircleCheck },
  info: { emoji: 'ℹ️', pixelart: 'alert', lucide: Info }, // placeholder
  warning: { emoji: '⚠️', pixelart: 'alert', lucide: TriangleAlert },

  // Misc
  expand: { emoji: '▶', pixelart: 'plus', lucide: ChevronRight }, // placeholder
  collapse: { emoji: '▼', pixelart: 'close', lucide: ChevronDown }, // placeholder
  menu: { emoji: '☰', pixelart: 'sliders', lucide: Menu },
  more: { emoji: '⋯', pixelart: 'sliders', lucide: Ellipsis }, // placeholder
};

/**
 * Get icon component for current icon set
 */
export function getIcon(
  name: IconName,
  iconSet: IconSet,
  size?: number | string,
  className?: string
): React.ReactNode {
  const config = iconRegistry[name];

  if (!config) {
    console.warn(`Icon "${name}" not found in registry`);
    return null;
  }

  if (iconSet === 'emoji') {
    return (
      <span
        className={`inline-block ${className || ''}`}
        style={{
          fontSize: typeof size === 'number' ? `${size}px` : size,
          lineHeight: 1,
        }}
      >
        {config.emoji}
      </span>
    );
  }

  if (iconSet === 'pixelart' && config.pixelart) {
    return <Icon name={config.pixelart} size={size} className={className} />;
  }

  if (iconSet === 'lucide') {
    const LucideComponent = config.lucide;
    return <LucideComponent size={size ?? 24} className={className} />;
  }

  // Fallback to emoji if pixel art not available
  return (
    <span
      className={`inline-block ${className || ''}`}
      style={{
        fontSize: typeof size === 'number' ? `${size}px` : size,
        lineHeight: 1,
      }}
    >
      {config.emoji}
    </span>
  );
}
