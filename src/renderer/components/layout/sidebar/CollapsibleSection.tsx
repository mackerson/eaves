import { useEffect, useRef, useState, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import './SidebarSection.css';

interface CollapsibleSectionProps {
  title: string;
  badge?: number | string;
  onTitleClick: () => void;
  onActionClick?: (e: React.MouseEvent) => void;
  actionTitle?: string;
  children: ReactNode;
  isExpandedByDefault?: boolean;
}

export function CollapsibleSection({
  title,
  badge,
  onTitleClick,
  onActionClick,
  actionTitle,
  children,
  isExpandedByDefault = false,
}: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(isExpandedByDefault);

  /**
   * `isExpandedByDefault` is a prop, but `useState` only ever reads it once —
   * and every caller that passes something interesting computes it from data
   * that is not there on the first render. `PluginsSection` passes
   * `pluginViews.length > 0`, and plugin views arrive over IPC after mount, so
   * the section latched `false` and stayed collapsed no matter what turned up.
   * A freshly installed plugin *was* in the menu; the menu was just shut.
   *
   * So follow the prop while nobody has expressed a preference, and stop the
   * moment they do — a section a person collapsed must stay collapsed even if
   * its contents change underneath.
   */
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setIsExpanded(isExpandedByDefault);
  }, [isExpandedByDefault]);

  const toggle = () => {
    touched.current = true;
    setIsExpanded((open) => !open);
  };

  return (
    <div className="sidebar-section">
      <div className="section-header">
        <button
          className="section-arrow"
          onClick={toggle}
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          className="section-title"
          onClick={onTitleClick}
          title={`View ${title.toLowerCase()}`}
        >
          {title}
        </button>
        {badge !== undefined && badge !== 0 && (
          <span className="section-badge">{badge}</span>
        )}
        {onActionClick && (
          <button
            className="section-action"
            onClick={onActionClick}
            title={actionTitle || `New ${title.slice(0, -1)}`}
          >
            +
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="section-content">
          {children}
        </div>
      )}
    </div>
  );
}
