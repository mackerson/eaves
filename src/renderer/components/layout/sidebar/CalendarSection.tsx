import { useUIStore } from '@/stores';
import { CollapsibleSection } from './CollapsibleSection';

export function CalendarSection() {
  const { setView } = useUIStore();

  const handleViewCalendar = () => {
    setView('calendar');
  };

  return (
    <CollapsibleSection
      title="Calendar"
      onTitleClick={handleViewCalendar}
    >
      <button className="section-view-all" onClick={handleViewCalendar}>
        View Calendar →
      </button>
    </CollapsibleSection>
  );
}
