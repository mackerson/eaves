import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NoteContentSchema, NoteTitleSchema, validateWithSchema } from '@shared/validation';
import { useToastStore, useProjectStore } from '@/stores';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { LabelSelector } from '@/components/notes/LabelSelector';
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer';
import { NoteColor } from '@/types';
import { Pencil, Eye, Pin, PinOff } from 'lucide-react';
import { cn } from '@/lib/utils';

const NOTE_COLORS: Record<NoteColor, { bg: string; border: string }> = {
  default: { bg: 'var(--bg-secondary)', border: 'var(--border-primary)' },
  red: { bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.4)' },
  orange: { bg: 'rgba(249, 115, 22, 0.15)', border: 'rgba(249, 115, 22, 0.4)' },
  yellow: { bg: 'rgba(234, 179, 8, 0.15)', border: 'rgba(234, 179, 8, 0.4)' },
  green: { bg: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.4)' },
  teal: { bg: 'rgba(20, 184, 166, 0.15)', border: 'rgba(20, 184, 166, 0.4)' },
  blue: { bg: 'rgba(59, 130, 246, 0.15)', border: 'rgba(59, 130, 246, 0.4)' },
  purple: { bg: 'rgba(168, 85, 247, 0.15)', border: 'rgba(168, 85, 247, 0.4)' },
};

interface NoteModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NoteModal({ open, onOpenChange }: NoteModalProps) {
  const showToast = useToastStore((state) => state.showToast);
  const {
    editingNote,
    closeNoteModal,
    addNote,
    updateNote,
    loadNoteLabels,
  } = useProjectStore();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [color, setColor] = useState<NoteColor>('default');
  const [pinned, setPinned] = useState(false);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [isViewMode, setIsViewMode] = useState(false);

  const isEditing = !!editingNote;

  // Load labels on mount and populate form when editing
  useEffect(() => {
    if (open) {
      loadNoteLabels();

      if (editingNote) {
        setTitle(editingNote.title || '');
        setContent(editingNote.content);
        setColor(editingNote.color);
        setPinned(editingNote.pinned || false);
        setSelectedLabels(editingNote.labels || []);
        // Start in view mode when editing existing note
        setIsViewMode(true);
      } else {
        setTitle('');
        setContent('');
        setColor('default');
        setPinned(false);
        setSelectedLabels([]);
        // Start in edit mode when creating new note
        setIsViewMode(false);
      }
    }
  }, [open, editingNote, loadNoteLabels]);

  const handleClose = () => {
    onOpenChange(false);
    closeNoteModal();
    setTitle('');
    setContent('');
    setColor('default');
    setPinned(false);
    setSelectedLabels([]);
    setIsViewMode(false);
  };

  const handleSubmit = async () => {
    // Validate content
    const contentValidation = validateWithSchema(NoteContentSchema, content);
    if (!contentValidation.success) {
      showToast(contentValidation.error, 'warning');
      return;
    }

    // Validate title if provided
    if (title) {
      const titleValidation = validateWithSchema(NoteTitleSchema, title);
      if (!titleValidation.success) {
        showToast(titleValidation.error, 'warning');
        return;
      }
    }

    try {
      if (isEditing) {
        await updateNote(editingNote.id, {
          title: title.trim() || undefined,
          content: contentValidation.data,
          color,
          pinned,
          labels: selectedLabels,
        });
        showToast('Note updated', 'success');
      } else {
        await addNote({
          title: title.trim() || undefined,
          content: contentValidation.data,
          color,
          pinned,
          labels: selectedLabels,
        });
        showToast('Note created', 'success');
      }
      handleClose();
    } catch (error) {
      showToast('Failed to save note', 'error');
    }
  };

  const colorStyle = NOTE_COLORS[color];

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        className="sm:max-w-4xl h-[85vh] flex flex-col"
        style={{
          backgroundColor: colorStyle.bg,
          borderColor: colorStyle.border,
        }}
      >
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex-1">
              {isViewMode ? (
                <span className="text-xl font-semibold">
                  {title || 'Untitled Note'}
                </span>
              ) : (
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Note title..."
                  className="text-xl font-semibold border-none bg-transparent px-0 focus-visible:ring-0"
                />
              )}
            </DialogTitle>
            <div className="flex items-center gap-2">
              {/* Pin toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPinned(!pinned)}
                className={cn(
                  'h-8 w-8 p-0',
                  pinned && 'app-text-primary'
                )}
              >
                {pinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
              </Button>
              {/* View/Edit toggle */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsViewMode(!isViewMode)}
                className="gap-2"
              >
                {isViewMode ? (
                  <>
                    <Pencil className="h-4 w-4" /> Edit
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4" /> Preview
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* Main content area */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0 py-4">
          {isViewMode ? (
            /* View Mode - Rendered Markdown */
            <div className="flex-1 overflow-y-auto pr-2">
              {content ? (
                <MarkdownRenderer content={content} className="text-base" />
              ) : (
                <p className="text-muted-foreground italic">No content yet. Click Edit to add content.</p>
              )}
            </div>
          ) : (
            /* Edit Mode - Raw textarea */
            <div className="flex-1 flex flex-col min-h-0">
              <Label htmlFor="note-content" className="mb-2 text-sm text-muted-foreground">
                Content (Markdown supported)
              </Label>
              <Textarea
                id="note-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.metaKey) {
                    handleSubmit();
                  }
                }}
                placeholder="Write your note using Markdown...

# Headings
**Bold** and *italic* text
- Bullet lists
1. Numbered lists

```code blocks```

> Blockquotes"
                autoFocus
                className="flex-1 resize-none font-mono text-sm bg-background/50"
              />
            </div>
          )}
        </div>

        {/* Bottom controls - always visible */}
        <div className="flex-shrink-0 space-y-4 border-t pt-4">
          {/* Color Picker */}
          <div className="flex items-center gap-4">
            <Label className="text-sm text-muted-foreground">Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>

          {/* Labels */}
          <LabelSelector
            selectedLabels={selectedLabels}
            onChange={setSelectedLabels}
          />
        </div>

        <DialogFooter className="flex-shrink-0">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!content.trim()}>
            {isEditing ? 'Save Changes' : 'Add Note'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
