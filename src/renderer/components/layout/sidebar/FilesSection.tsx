import { useUIStore } from '@/stores';
import { CollapsibleSection } from './CollapsibleSection';

export function FilesSection() {
  const { setView } = useUIStore();

  const handleViewFiles = () => {
    setView('files');
  };

  return (
    <CollapsibleSection
      title="Files & Folders"
      onTitleClick={handleViewFiles}
    >
      <button className="section-view-all" onClick={handleViewFiles}>
        View Files & Folders →
      </button>
    </CollapsibleSection>
  );
}
