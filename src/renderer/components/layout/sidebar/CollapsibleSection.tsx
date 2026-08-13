import { useState, ReactNode } from 'react';
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

  return (
    <div className="sidebar-section">
      <div className="section-header">
        <button
          className="section-arrow"
          onClick={() => setIsExpanded(!isExpanded)}
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
