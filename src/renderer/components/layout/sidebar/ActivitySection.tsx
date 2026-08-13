import { useEffect } from 'react';
import { useActivityStore, useUIStore } from '@/stores';
import { CollapsibleSection } from './CollapsibleSection';
import { describeActivity } from '@/lib/activityLabels';

/**
 * Format relative time for sidebar display
 */
function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;

  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ActivitySection() {
  const { activities, recentCount, loadActivities, loadRecentCount } = useActivityStore();
  const { setView, view } = useUIStore();

  // Load activities and recent count on mount
  useEffect(() => {
    loadActivities();
    loadRecentCount();
  }, [loadActivities, loadRecentCount]);

  // Poll for recent count periodically
  useEffect(() => {
    const interval = setInterval(loadRecentCount, 30000); // Every 30s
    return () => clearInterval(interval);
  }, [loadRecentCount]);

  // Set up real-time listener
  useEffect(() => {
    const cleanup = window.electron.onActivityNew((activity) => {
      useActivityStore.getState().addActivity(activity);
    });
    return cleanup;
  }, []);

  const handleViewActivity = () => {
    useActivityStore.getState().markViewed();
    setView('activity');
  };

  // Get last 5 activities for sidebar preview
  const recentActivities = activities.slice(0, 5);

  return (
    <CollapsibleSection
      title="Activity"
      badge={recentCount > 0 ? recentCount : undefined}
      onTitleClick={handleViewActivity}
      isExpandedByDefault={false}
    >
      {recentActivities.length === 0 ? (
        <div className="section-empty">
          No recent activity
        </div>
      ) : (
        <div className="section-list">
          {recentActivities.map((activity) => {
            const { text } = describeActivity(activity);

            return (
              <button
                key={activity.id}
                className={`section-item ${view === 'activity' ? 'active' : ''}`}
                onClick={handleViewActivity}
                title={text}
              >
                <span className="item-label truncate text-xs">{text}</span>
                <span className="item-time text-xs">{formatTime(activity.timestamp)}</span>
              </button>
            );
          })}
          <button
            className="section-item section-more"
            onClick={handleViewActivity}
          >
            <span className="item-label text-xs">View all activity...</span>
          </button>
        </div>
      )}
    </CollapsibleSection>
  );
}
