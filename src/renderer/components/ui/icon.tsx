import React from 'react';

/**
 * Icon component using pixelarticons
 * https://github.com/halfmage/pixelarticons
 *
 * 486 handmade pixel art icons on a 24x24 grid
 * Best displayed at 24px, 48px, 72px, or 96px
 */

// Import icons as Vite assets
import alertIcon from '@/assets/icons/alert.svg';
import calendarIcon from '@/assets/icons/calendar.svg';
import chatIcon from '@/assets/icons/chat.svg';
import checkIcon from '@/assets/icons/check.svg';
import checkboxIcon from '@/assets/icons/checkbox.svg';
import closeIcon from '@/assets/icons/close.svg';
import cloudIcon from '@/assets/icons/cloud.svg';
import cloudUploadIcon from '@/assets/icons/cloud-upload.svg';
import cloudDoneIcon from '@/assets/icons/cloud-done.svg';
import editIcon from '@/assets/icons/edit.svg';
import fileIcon from '@/assets/icons/file.svg';
import folderIcon from '@/assets/icons/folder.svg';
import gitBranchIcon from '@/assets/icons/git-branch.svg';
import messageIcon from '@/assets/icons/message.svg';
import noteIcon from '@/assets/icons/note.svg';
import plusIcon from '@/assets/icons/plus.svg';
import reloadIcon from '@/assets/icons/reload.svg';
import searchIcon from '@/assets/icons/search.svg';
import slidersIcon from '@/assets/icons/sliders.svg';
import storeIcon from '@/assets/icons/store.svg';
import trashIcon from '@/assets/icons/trash.svg';
import powerIcon from '@/assets/icons/power.svg';
import externalLinkIcon from '@/assets/icons/external-link.svg';
import chartIcon from '@/assets/icons/chart.svg';

const iconRegistry: Record<string, string> = {
  alert: alertIcon,
  calendar: calendarIcon,
  chat: chatIcon,
  check: checkIcon,
  checkbox: checkboxIcon,
  close: closeIcon,
  cloud: cloudIcon,
  'cloud-upload': cloudUploadIcon,
  'cloud-done': cloudDoneIcon,
  edit: editIcon,
  file: fileIcon,
  folder: folderIcon,
  'git-branch': gitBranchIcon,
  message: messageIcon,
  note: noteIcon,
  plus: plusIcon,
  reload: reloadIcon,
  search: searchIcon,
  sliders: slidersIcon,
  store: storeIcon,
  trash: trashIcon,
  power: powerIcon,
  'external-link': externalLinkIcon,
  chart: chartIcon,
};

interface IconProps {
  name: string;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 24, className = '', style, ...props }: IconProps) {
  const iconPath = iconRegistry[name];

  if (!iconPath) {
    console.warn(`Icon "${name}" not found in registry`);
    return null;
  }

  return (
    <img
      src={iconPath}
      alt={name}
      width={size}
      height={size}
      className={`inline-block dark:invert ${className}`}
      style={{
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
        imageRendering: 'pixelated', // Keeps pixels crisp
        ...style,
      }}
      {...props}
    />
  );
}

/**
 * Pre-configured icon components for common use cases
 */
export const ChatIcon = (props: Omit<IconProps, 'name'>) => <Icon name="chat" {...props} />;
export const MessageIcon = (props: Omit<IconProps, 'name'>) => <Icon name="message" {...props} />;
export const FileIcon = (props: Omit<IconProps, 'name'>) => <Icon name="file" {...props} />;
export const FolderIcon = (props: Omit<IconProps, 'name'>) => <Icon name="folder" {...props} />;
export const NoteIcon = (props: Omit<IconProps, 'name'>) => <Icon name="note" {...props} />;
export const TaskIcon = (props: Omit<IconProps, 'name'>) => <Icon name="checkbox" {...props} />;
export const CalendarIcon = (props: Omit<IconProps, 'name'>) => <Icon name="calendar" {...props} />;
export const WorkflowIcon = (props: Omit<IconProps, 'name'>) => <Icon name="git-branch" {...props} />;
export const RoutineIcon = (props: Omit<IconProps, 'name'>) => <Icon name="reload" {...props} />;
export const CloudIcon = (props: Omit<IconProps, 'name'>) => <Icon name="cloud" {...props} />;
export const SyncIcon = (props: Omit<IconProps, 'name'>) => <Icon name="cloud-upload" {...props} />;
export const MarketplaceIcon = (props: Omit<IconProps, 'name'>) => <Icon name="store" {...props} />;
export const PlusIcon = (props: Omit<IconProps, 'name'>) => <Icon name="plus" {...props} />;
export const EditIcon = (props: Omit<IconProps, 'name'>) => <Icon name="edit" {...props} />;
export const TrashIcon = (props: Omit<IconProps, 'name'>) => <Icon name="trash" {...props} />;
export const SettingsIcon = (props: Omit<IconProps, 'name'>) => <Icon name="sliders" {...props} />;
export const SearchIcon = (props: Omit<IconProps, 'name'>) => <Icon name="search" {...props} />;
export const CheckIcon = (props: Omit<IconProps, 'name'>) => <Icon name="check" {...props} />;
export const CloseIcon = (props: Omit<IconProps, 'name'>) => <Icon name="close" {...props} />;
export const AlertIcon = (props: Omit<IconProps, 'name'>) => <Icon name="alert" {...props} />;
