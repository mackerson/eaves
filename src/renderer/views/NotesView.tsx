import { useMemo, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { spliceReorder } from '@/lib/reorder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Note, NoteColor } from '@/types';
import { useProjectStore } from '@/stores/useProjectStore';
import { getNoteColorClass, getNoteColorBorder } from '@/components/ui/ColorPicker';
import { LabelBadges } from '@/components/notes/LabelSelector';
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer';
import { cn } from '@/lib/utils';
import {
  Search,
  Plus,
  Trash2,
  Pin,
  PinOff,
  Sparkles,
  FileText,
  Loader2,
  Tag,
  X,
  Brain,
  GripVertical,
} from 'lucide-react';


function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'long' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

const colorOptions: { value: NoteColor; label: string; className: string }[] = [
  { value: 'default', label: 'All', className: 'bg-[var(--bg-secondary)]' },
  { value: 'red', label: 'Red', className: 'bg-red-500' },
  { value: 'orange', label: 'Orange', className: 'bg-orange-500' },
  { value: 'yellow', label: 'Yellow', className: 'bg-yellow-500' },
  { value: 'green', label: 'Green', className: 'bg-green-500' },
  { value: 'teal', label: 'Teal', className: 'bg-teal-500' },
  { value: 'blue', label: 'Blue', className: 'bg-blue-500' },
  { value: 'purple', label: 'Purple', className: 'bg-purple-500' },
];

function NoteCardContent({ note }: { note: Note }) {
  const [isGenerating, setIsGenerating] = useState(false);
  const { openNoteModal, deleteNote, toggleNotePin, generateNoteAI } = useProjectStore();

  const handleGenerateAI = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsGenerating(true);
    try {
      await generateNoteAI(note.id);
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleNotePin(note.id);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNote(note.id);
  };

  // Use title if set, otherwise first line of content
  const displayTitle = note.title || note.content.split('\n')[0].slice(0, 50);
  const preview = note.title
    ? note.content.slice(0, 150)
    : note.content.split('\n').slice(1).join('\n').slice(0, 150);

  return (
    <>
      {/* Pin indicator */}
      {note.pinned && (
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-[var(--accent-primary)] flex items-center justify-center shadow z-10">
          <Pin className="w-3 h-3 text-white" />
        </div>
      )}

      {/* Action buttons */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePin}
          className="h-7 w-7 p-0 bg-[var(--bg-primary)]/50 hover:bg-[var(--bg-primary)]"
          title={note.pinned ? 'Unpin' : 'Pin'}
        >
          {note.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleGenerateAI}
          disabled={isGenerating}
          className="h-7 w-7 p-0 bg-[var(--bg-primary)]/50 hover:bg-[var(--bg-primary)]"
          title="Generate AI summary"
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDelete}
          className="h-7 w-7 p-0 bg-[var(--bg-primary)]/50 hover:bg-destructive/20 hover:text-destructive"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Drag handle - visible on hover */}
      <div className="absolute top-2 left-2 opacity-0 group-hover:opacity-50 transition-opacity cursor-grab active:cursor-grabbing z-10">
        <GripVertical className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
      </div>

      {/* Content */}
      <div className="pr-8 pl-2" onClick={() => openNoteModal(note)}>
        <h3
          className="font-medium truncate mb-1"
          style={{ color: 'var(--text-primary)' }}
        >
          {displayTitle || 'Untitled'}
        </h3>
        {preview && (
          <div className="text-sm line-clamp-3 mb-2 overflow-hidden">
            <MarkdownRenderer
              content={preview}
              truncate
              maxLength={150}
              className="[&_*]:!mb-0 [&_*]:!mt-0 [&_p]:inline [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm text-[var(--text-secondary)]"
            />
          </div>
        )}

        {/* AI Metadata */}
        {note.aiMetadata && (
          <div className="mt-3 pt-3 border-t border-[var(--border-secondary)]">
            {note.aiMetadata.summary && (
              <p className="text-xs italic mb-2" style={{ color: 'var(--text-secondary)' }}>
                <Brain className="w-3 h-3 inline mr-1" />
                {note.aiMetadata.summary}
              </p>
            )}
            {note.aiMetadata.topics && note.aiMetadata.topics.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {note.aiMetadata.topics.slice(0, 4).map((topic, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)]/50"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {topic}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Labels */}
        {note.labels.length > 0 && (
          <div className="mt-2">
            <LabelBadges labelIds={note.labels} />
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between mt-3 pt-2 border-t border-[var(--border-secondary)]">
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {formatDate(note.updatedAt || note.createdAt)}
          </p>
          {note.aiMetadata?.type && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--accent-primary)/10',
                color: 'var(--accent-primary)',
              }}
            >
              {note.aiMetadata.type}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function SortableNoteCard({ note }: { note: Note }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: note.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 'auto',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'group rounded-lg border p-4 transition-all cursor-pointer relative',
        'hover:shadow-md',
        isDragging && 'shadow-lg ring-2 ring-[var(--accent-primary)]',
        getNoteColorClass(note.color),
        getNoteColorBorder(note.color)
      )}
    >
      <NoteCardContent note={note} />
    </div>
  );
}

interface SortableGridProps {
  notes: Note[];
  onReorder: (noteIds: string[]) => void;
}

function SortableGrid({ notes, onReorder }: SortableGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement before drag starts (prevents accidental drags)
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = notes.findIndex((n) => n.id === active.id);
      const newIndex = notes.findIndex((n) => n.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = [...notes];
        const [moved] = newOrder.splice(oldIndex, 1);
        newOrder.splice(newIndex, 0, moved);
        onReorder(newOrder.map((n) => n.id));
      }
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={notes.map((n) => n.id)} strategy={rectSortingStrategy}>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {notes.map((note) => (
            <SortableNoteCard key={note.id} note={note} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

export function NotesView() {
  const {
    notes,
    noteLabels,
    selectedLabelFilter,
    selectedColorFilter,
    setLabelFilter,
    setColorFilter,
    reorderNotes,
    openNoteModal,
  } = useProjectStore();
  const onAddNote = () => openNoteModal();
  const [searchQuery, setSearchQuery] = useState('');

  // Apply filters
  let filteredNotes = notes;

  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    filteredNotes = filteredNotes.filter(
      (note) =>
        note.content.toLowerCase().includes(query) ||
        note.title?.toLowerCase().includes(query)
    );
  }

  if (selectedLabelFilter) {
    filteredNotes = filteredNotes.filter((note) =>
      note.labels.includes(selectedLabelFilter)
    );
  }

  if (selectedColorFilter && selectedColorFilter !== 'default') {
    filteredNotes = filteredNotes.filter((note) => note.color === selectedColorFilter);
  }

  // Separate pinned and unpinned
  const pinnedNotes = filteredNotes.filter((n) => n.pinned);
  const unpinnedNotes = filteredNotes.filter((n) => !n.pinned);

  // Sort by sortOrder (already sorted by DB, but ensure)
  const sortedPinned = [...pinnedNotes].sort((a, b) => b.sortOrder - a.sortOrder);
  const sortedUnpinned = [...unpinnedNotes].sort((a, b) => b.sortOrder - a.sortOrder);

  const hasFilters = !!selectedLabelFilter || (!!selectedColorFilter && selectedColorFilter !== 'default');

  /**
   * Splice back into the *unfiltered* list. Both handlers used to rebuild the
   * order from the filtered sets alone, and reorderNotes assigns
   * `sortOrder = N - i` across exactly the ids it is given — so with a label
   * or colour filter active, every hidden note kept its old value and started
   * colliding with the freshly assigned ones. Reordering four visible notes
   * silently renumbered them over the top of forty hidden ones.
   */
  const allNoteIds = useMemo(
    () => [...notes].sort((a, b) => b.sortOrder - a.sortOrder).map((n) => n.id),
    [notes],
  );

  const handleReorderPinned = (noteIds: string[]) => {
    reorderNotes(spliceReorder(allNoteIds, noteIds));
  };

  const handleReorderUnpinned = (noteIds: string[]) => {
    reorderNotes(spliceReorder(allNoteIds, noteIds));
  };

  return (
    <div className="p-8 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-semibold">Notes</h2>
        <Button onClick={onAddNote}>
          <Plus className="h-4 w-4 mr-2" /> New Note
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search
          className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4"
          style={{ color: 'var(--text-tertiary)' }}
        />
        <Input
          type="text"
          placeholder="Search notes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-4 mb-6 flex-wrap">
        {/* Color Filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)]">Color:</span>
          <div className="flex gap-1">
            {colorOptions.map((color) => (
              <button
                key={color.value}
                onClick={() =>
                  setColorFilter(
                    selectedColorFilter === color.value ? null : color.value
                  )
                }
                className={cn(
                  'w-5 h-5 rounded-full transition-all border',
                  color.className,
                  selectedColorFilter === color.value
                    ? 'ring-2 ring-offset-1 ring-offset-[var(--bg-primary)] ring-[var(--accent-primary)]'
                    : 'hover:scale-110 border-[var(--border-primary)]',
                  color.value === 'default' && 'border-dashed'
                )}
                title={color.label}
              />
            ))}
          </div>
        </div>

        {/* Label Filter */}
        {noteLabels.length > 0 && (
          <div className="flex items-center gap-2">
            <Tag className="w-3 h-3 text-[var(--text-secondary)]" />
            <div className="flex gap-1 flex-wrap">
              {noteLabels.map((label) => (
                <button
                  key={label.id}
                  onClick={() =>
                    setLabelFilter(
                      selectedLabelFilter === label.id ? null : label.id
                    )
                  }
                  className={cn(
                    'px-2 py-0.5 text-xs rounded-full transition-all border',
                    selectedLabelFilter === label.id
                      ? 'bg-[var(--accent-primary)] text-white border-transparent'
                      : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border-primary)] hover:border-[var(--accent-primary)]'
                  )}
                >
                  {label.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Clear Filters */}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLabelFilter(null);
              setColorFilter(null);
            }}
            className="h-6 text-xs"
          >
            <X className="w-3 h-3 mr-1" /> Clear
          </Button>
        )}
      </div>

      {/* Empty State */}
      {filteredNotes.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-16 rounded-lg border-2 border-dashed"
          style={{ borderColor: 'var(--border-secondary)' }}
        >
          <FileText
            className="h-12 w-12 mb-4"
            style={{ color: 'var(--text-tertiary)' }}
          />
          <p
            className="text-lg font-medium mb-1"
            style={{ color: 'var(--text-secondary)' }}
          >
            {searchQuery || hasFilters ? 'No notes found' : 'No notes yet'}
          </p>
          <p
            className="text-sm mb-4"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {searchQuery || hasFilters
              ? 'Try different filters'
              : 'Create your first note to get started'}
          </p>
          {!searchQuery && !hasFilters && (
            <Button onClick={onAddNote} variant="outline">
              <Plus className="h-4 w-4 mr-2" /> Create Note
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Pinned Section */}
          {sortedPinned.length > 0 && (
            <div className="mb-8">
              <h3
                className="text-sm font-medium mb-3 flex items-center gap-2"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Pin className="w-4 h-4" /> Pinned
              </h3>
              <SortableGrid notes={sortedPinned} onReorder={handleReorderPinned} />
            </div>
          )}

          {/* Other Notes */}
          {sortedUnpinned.length > 0 && (
            <div>
              {sortedPinned.length > 0 && (
                <h3
                  className="text-sm font-medium mb-3"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Others
                </h3>
              )}
              <SortableGrid notes={sortedUnpinned} onReorder={handleReorderUnpinned} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
