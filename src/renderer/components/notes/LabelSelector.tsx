import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { NoteLabel } from '@/types';
import { useProjectStore } from '@/stores/useProjectStore';
import { X, Plus, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface LabelSelectorProps {
  selectedLabels: string[];
  onChange: (labels: string[]) => void;
  className?: string;
}

export function LabelSelector({ selectedLabels, onChange, className }: LabelSelectorProps) {
  const { noteLabels, createNoteLabel } = useProjectStore();
  const [isAdding, setIsAdding] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');

  const toggleLabel = (labelId: string) => {
    if (selectedLabels.includes(labelId)) {
      onChange(selectedLabels.filter((id) => id !== labelId));
    } else {
      onChange([...selectedLabels, labelId]);
    }
  };

  const handleAddLabel = async () => {
    if (newLabelName.trim()) {
      await createNoteLabel(newLabelName.trim());
      setNewLabelName('');
      setIsAdding(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddLabel();
    } else if (e.key === 'Escape') {
      // Escape here means "abandon this label", not "abandon the whole task".
      // Without stopping propagation the key reached the enclosing Radix
      // Dialog, which closed and took every unsaved edit with it — the Enter
      // branch above already guards itself with preventDefault.
      e.preventDefault();
      e.stopPropagation();
      setIsAdding(false);
      setNewLabelName('');
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
        <Tag className="w-3 h-3" />
        <span>Labels</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {noteLabels.map((label) => (
          <button
            key={label.id}
            type="button"
            onClick={() => toggleLabel(label.id)}
            className={cn(
              'px-2 py-1 text-xs rounded-full border transition-all',
              selectedLabels.includes(label.id)
                ? 'bg-[var(--accent-primary)] text-white border-transparent'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border-primary)] hover:border-[var(--accent-primary)]'
            )}
          >
            {label.name}
          </button>
        ))}

        {isAdding ? (
          <input
            type="text"
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleAddLabel}
            placeholder="Label name..."
            autoFocus
            className="px-2 py-1 text-xs rounded-full border border-[var(--accent-primary)] bg-[var(--bg-secondary)] text-[var(--text-primary)] outline-none w-24"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="px-2 py-1 text-xs rounded-full border border-dashed border-[var(--border-primary)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] transition-all flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            New
          </button>
        )}
      </div>
    </div>
  );
}

interface LabelBadgesProps {
  labelIds: string[];
  onRemove?: (labelId: string) => void;
  className?: string;
  /** Show at most this many, with a `+N` for the rest. */
  max?: number;
  /**
   * Rendered before the badges, and only when at least one label resolves —
   * so a caller's leading tag icon can't be left dangling on its own next to
   * labels that have since been deleted.
   */
  icon?: React.ReactNode;
}

export function LabelBadges({ labelIds, onRemove, className, max, icon }: LabelBadgesProps) {
  const { noteLabels } = useProjectStore();

  const labels = labelIds
    .map((id) => noteLabels.find((l) => l.id === id))
    .filter(Boolean) as NoteLabel[];

  if (labels.length === 0) return null;

  const shown = max === undefined ? labels : labels.slice(0, max);
  const overflow = labels.length - shown.length;

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {icon}
      {shown.map((label) => (
        <Badge
          key={label.id}
          variant="secondary"
          className="text-[10px] px-1.5 py-0 h-5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-0"
        >
          {label.name}
          {onRemove && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(label.id);
              }}
              className="ml-1 hover:text-[var(--text-primary)]"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </Badge>
      ))}
      {overflow > 0 && (
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          +{overflow}
        </span>
      )}
    </div>
  );
}
