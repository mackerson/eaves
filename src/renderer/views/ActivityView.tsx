import { useEffect, useMemo, useState } from 'react';
import { useActivityStore } from '@/stores/useActivityStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Activity } from '@/types';
import { cn } from '@/lib/utils';
import { describeActivity } from '@/lib/activityLabels';
import { LiveWorkSection } from '@/components/LiveWorkSection';
import {
  Search,
  Trash2,
  ChevronDown,
  ChevronRight,
  Activity as ActivityIcon,
  Loader2,
  RefreshCw,
} from 'lucide-react';

/**
 * Category colors for visual distinction
 */
const CATEGORY_COLORS: Record<string, string> = {
  agent: 'bg-indigo-500',
  chat: 'bg-emerald-500',
  channel: 'bg-blue-500',
  project: 'bg-violet-500',
  message: 'bg-indigo-400',
  task: 'bg-amber-500',
  note: 'bg-pink-500',
  plugin: 'bg-teal-500',
  system: 'bg-slate-500',
  workflow: 'bg-orange-500',
  routine: 'bg-rose-500',
  execution: 'bg-cyan-500',
  tool: 'bg-lime-500',
  mcp: 'bg-purple-500',
  service: 'bg-gray-500',
  ui: 'bg-sky-500',
  other: 'bg-gray-400',
};


/**
 * Format relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

/**
 * Format date for grouping
 */
function formatDateGroup(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'long' });

  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Activity item component
 */
function ActivityItem({ activity }: { activity: Activity }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const color = CATEGORY_COLORS[activity.category] || CATEGORY_COLORS.other;
  const { label, subject } = describeActivity(activity);

  return (
    <div
      className={cn(
        'p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-primary)]',
        'hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer'
      )}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <div className="flex items-center gap-3">
        {/* Category indicator */}
        <div className={cn('w-2 h-2 rounded-full flex-shrink-0', color)} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[var(--text-primary)] truncate" title={subject ? `${label} — ${subject}` : label}>
              {label}
              {subject && (
                <span className="text-[var(--text-secondary)] font-normal"> — {subject}</span>
              )}
            </span>
            <span className="text-xs text-[var(--text-tertiary)] whitespace-nowrap">
              {formatRelativeTime(activity.timestamp)}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-[var(--text-secondary)] capitalize">
              {activity.category}
            </span>
            {activity.source !== 'core' && (
              <span className="text-xs text-[var(--text-tertiary)]">
                via {activity.source}
              </span>
            )}
          </div>
        </div>

        {/* Expand indicator */}
        {!!activity.data && (
          <div className="text-[var(--text-tertiary)]">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </div>
        )}
      </div>

      {/* Expanded data */}
      {isExpanded && !!activity.data && (
        <div className="mt-3 p-2 bg-[var(--bg-primary)] rounded text-xs font-mono overflow-x-auto overflow-y-hidden border border-[var(--border-secondary)]">
          <pre className="text-[var(--text-secondary)] whitespace-pre-wrap break-words">
            {JSON.stringify(activity.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Activity View - displays system activity/events
 */
export function ActivityView() {
  const {
    activities,
    categories,
    selectedCategories,
    searchQuery,
    showSystem,
    isLoading,
    loadActivities,
    loadCategories,
    setSearchQuery,
    toggleCategory,
    toggleShowSystem,
    clearActivities,
    markViewed,
  } = useActivityStore();

  // Load data on mount
  useEffect(() => {
    loadActivities();
    loadCategories();
    markViewed();
  }, [loadActivities, loadCategories, markViewed]);

  // Set up real-time listener
  useEffect(() => {
    const cleanup = window.electron.onActivityNew((activity) => {
      useActivityStore.getState().addActivity(activity);
    });
    return cleanup;
  }, []);

  // Filter activities by search query
  const filteredActivities = useMemo(() => {
    if (!searchQuery.trim()) return activities;

    const query = searchQuery.toLowerCase();
    return activities.filter(
      (a) =>
        a.type.toLowerCase().includes(query) ||
        a.category.toLowerCase().includes(query) ||
        a.source.toLowerCase().includes(query) ||
        (a.data && JSON.stringify(a.data).toLowerCase().includes(query))
    );
  }, [activities, searchQuery]);

  // Group activities by date
  const groupedActivities = useMemo(() => {
    const groups: Record<string, Activity[]> = {};

    filteredActivities.forEach((activity) => {
      const dateKey = formatDateGroup(activity.timestamp);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(activity);
    });

    return groups;
  }, [filteredActivities]);

  const handleRefresh = () => {
    loadActivities();
    loadCategories();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ActivityIcon className="w-5 h-5 text-[var(--text-secondary)]" />
            <h1 className="text-xl font-semibold text-[var(--text-primary)]">Activity</h1>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearActivities}
              disabled={isLoading || activities.length === 0}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Clear
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <Input
            placeholder="Search activities..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Category filters */}
        <div className="flex gap-2 flex-wrap items-center">
          {categories.map((category) => {
            const isSelected = selectedCategories.includes(category);
            const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;

            return (
              <button
                key={category}
                onClick={() => toggleCategory(category)}
                className={cn(
                  'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                  'border',
                  isSelected
                    ? 'bg-[var(--accent-primary)] text-white border-transparent'
                    : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)]'
                )}
              >
                <span
                  className={cn('inline-block w-2 h-2 rounded-full mr-1.5', color)}
                />
                {category}
              </button>
            );
          })}
          <button
            onClick={toggleShowSystem}
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium transition-colors border ml-auto',
              showSystem
                ? 'bg-[var(--accent-primary)] text-white border-transparent'
                : 'bg-[var(--bg-primary)] text-[var(--text-tertiary)] border-dashed border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)]'
            )}
          >
            System events
          </button>
        </div>
      </div>

      {/* Activity Timeline */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* What is happening, above what happened. Deliberately inside the
            scroll area: it grows with pending approvals and spend rows, and a
            fixed block would eat the feed on a short window. */}
        <LiveWorkSection />

        {isLoading && activities.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : filteredActivities.length === 0 ? (
          <div className="text-center py-12">
            <ActivityIcon className="w-12 h-12 mx-auto mb-3 text-[var(--text-tertiary)]" />
            <p className="text-[var(--text-secondary)]">No activities to display</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">
              {searchQuery ? 'Try a different search term' : 'Activities will appear here as they happen'}
            </p>
          </div>
        ) : (
          Object.entries(groupedActivities).map(([date, items]) => (
            <div key={date} className="mb-6">
              <h3 className="text-sm font-medium text-[var(--text-tertiary)] mb-3 sticky top-0 bg-[var(--bg-primary)] py-1 z-10">
                {date}
              </h3>
              <div className="space-y-2">
                {items.map((activity) => (
                  <ActivityItem key={activity.id} activity={activity} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer Stats */}
      <div className="p-3 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)]">
          <span>
            Showing {filteredActivities.length} of {activities.length} activities
          </span>
          <span>
            {selectedCategories.length > 0 && (
              <span className="mr-2">
                Filtered by: {selectedCategories.join(', ')}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
