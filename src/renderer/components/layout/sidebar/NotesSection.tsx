import { useProjectStore, useUIStore } from '@/stores';
import { AppIcon } from '@/components/ui/AppIcon';
import { CollapsibleSection } from './CollapsibleSection';

export function NotesSection() {
  const { notes, openNoteModal } = useProjectStore();
  const { setView } = useUIStore();

  const handleViewAllNotes = () => {
    setView('notes');
  };

  const handleActionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openNoteModal();
  };

  return (
    <CollapsibleSection
      title="Notes"
      onTitleClick={handleViewAllNotes}
      onActionClick={handleActionClick}
      actionTitle="New Note"
    >
      {notes.length === 0 ? (
        <div className="section-empty">
          No notes yet. Click + to create one.
        </div>
      ) : (
        <>
          <div className="section-list">
            {notes.slice(0, 5).map((note) => (
              <button
                key={note.id}
                className="section-item"
                onClick={handleViewAllNotes}
                title={note.content}
              >
                <AppIcon name="notes" size={16} className="item-icon" />
                <span className="item-label">
                  {note.content.slice(0, 30)}
                  {note.content.length > 30 ? '...' : ''}
                </span>
              </button>
            ))}
          </div>
          {notes.length > 5 && (
            <button
              className="section-view-all"
              onClick={handleViewAllNotes}
            >
              View all {notes.length} notes →
            </button>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}
