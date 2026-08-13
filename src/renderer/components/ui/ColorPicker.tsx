import { cn } from '@/lib/utils';
import { NoteColor } from '@/types';
import { Check } from 'lucide-react';

interface ColorPickerProps {
  value: NoteColor;
  onChange: (color: NoteColor) => void;
  className?: string;
}

const colors: { value: NoteColor; label: string; bg: string; border: string }[] = [
  { value: 'default', label: 'Default', bg: 'bg-[var(--bg-secondary)]', border: 'border-[var(--border-primary)]' },
  { value: 'red', label: 'Red', bg: 'bg-red-500/20', border: 'border-red-500/40' },
  { value: 'orange', label: 'Orange', bg: 'bg-orange-500/20', border: 'border-orange-500/40' },
  { value: 'yellow', label: 'Yellow', bg: 'bg-yellow-500/20', border: 'border-yellow-500/40' },
  { value: 'green', label: 'Green', bg: 'bg-green-500/20', border: 'border-green-500/40' },
  { value: 'teal', label: 'Teal', bg: 'bg-teal-500/20', border: 'border-teal-500/40' },
  { value: 'blue', label: 'Blue', bg: 'bg-blue-500/20', border: 'border-blue-500/40' },
  { value: 'purple', label: 'Purple', bg: 'bg-purple-500/20', border: 'border-purple-500/40' },
];

export function ColorPicker({ value, onChange, className }: ColorPickerProps) {
  return (
    <div className={cn('flex gap-2', className)}>
      {colors.map((color) => (
        <button
          key={color.value}
          type="button"
          onClick={() => onChange(color.value)}
          title={color.label}
          className={cn(
            'w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all',
            color.bg,
            color.border,
            value === color.value
              ? 'ring-2 ring-offset-2 ring-offset-[var(--bg-primary)] ring-[var(--accent-primary)]'
              : 'hover:scale-110'
          )}
        >
          {value === color.value && (
            <Check className="w-4 h-4 text-[var(--text-primary)]" />
          )}
        </button>
      ))}
    </div>
  );
}

export function getNoteColorClass(color: NoteColor): string {
  const colorMap: Record<NoteColor, string> = {
    default: 'bg-[var(--bg-secondary)]',
    red: 'bg-red-500/20',
    orange: 'bg-orange-500/20',
    yellow: 'bg-yellow-500/20',
    green: 'bg-green-500/20',
    teal: 'bg-teal-500/20',
    blue: 'bg-blue-500/20',
    purple: 'bg-purple-500/20',
  };
  return colorMap[color] || colorMap.default;
}

export function getNoteColorBorder(color: NoteColor): string {
  const borderMap: Record<NoteColor, string> = {
    default: 'border-[var(--border-primary)]',
    red: 'border-red-500/40',
    orange: 'border-orange-500/40',
    yellow: 'border-yellow-500/40',
    green: 'border-green-500/40',
    teal: 'border-teal-500/40',
    blue: 'border-blue-500/40',
    purple: 'border-purple-500/40',
  };
  return borderMap[color] || borderMap.default;
}
