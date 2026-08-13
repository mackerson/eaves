import { create } from 'zustand';
import type { Activity, ActivityFilter } from '@/types';
import { useToastStore } from './useToastStore';

export type { ActivityFilter };

interface ActivityState {
  // Data
  activities: Activity[];
  categories: string[];
  recentCount: number;
  lastViewedTimestamp: number;
  totalCount: number;

  // UI State
  filter: ActivityFilter;
  searchQuery: string;
  selectedCategories: string[];
  showSystem: boolean;
  isLoading: boolean;

  // Actions
  loadActivities: () => Promise<void>;
  loadCategories: () => Promise<void>;
  loadRecentCount: () => Promise<void>;
  setFilter: (filter: Partial<ActivityFilter>) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategories: (categories: string[]) => void;
  toggleCategory: (category: string) => void;
  toggleShowSystem: () => void;
  clearActivities: () => Promise<void>;
  markViewed: () => void;
  addActivity: (activity: Activity) => void;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  // Initial state
  activities: [],
  categories: [],
  recentCount: 0,
  lastViewedTimestamp: Date.now(),
  totalCount: 0,
  filter: { limit: 200 },
  searchQuery: '',
  selectedCategories: [],
  showSystem: false,
  isLoading: false,

  loadActivities: async () => {
    set({ isLoading: true });
    try {
      const { filter, selectedCategories, showSystem } = get();
      const finalFilter = {
        ...filter,
        categories: selectedCategories.length > 0 ? selectedCategories : undefined,
        audience: showSystem ? undefined : ('user' as const),
      };
      const result = await window.electron.getActivities(finalFilter);
      if (result.success) {
        set({ activities: result.activities ?? [] });
      } else {
        const msg = result.error || 'Failed to load activities';
        console.error('[useActivityStore] loadActivities failed:', msg);
        useToastStore.getState().showToast(msg, 'error');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[useActivityStore] loadActivities threw:', msg);
      useToastStore.getState().showToast(`Activity load failed: ${msg}`, 'error');
    } finally {
      set({ isLoading: false });
    }
  },

  loadCategories: async () => {
    try {
      const { showSystem } = get();
      const result = await window.electron.getActivityCategories(showSystem ? undefined : 'user');
      if (result.success) {
        set({ categories: result.categories ?? [] });
      } else {
        const msg = result.error || 'Failed to load activity categories';
        console.error('[useActivityStore] loadCategories failed:', msg);
        useToastStore.getState().showToast(msg, 'error');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[useActivityStore] loadCategories threw:', msg);
    }
  },

  loadRecentCount: async () => {
    try {
      const { lastViewedTimestamp } = get();
      const result = await window.electron.getActivityRecentCount(lastViewedTimestamp);
      if (result.success && typeof result.count === 'number') {
        set({ recentCount: result.count });
      }
    } catch (error) {
      console.error('Failed to load recent count:', error);
    }
  },

  setFilter: (newFilter) => {
    set((state) => ({
      filter: { ...state.filter, ...newFilter },
    }));
    get().loadActivities();
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSelectedCategories: (categories) => {
    set({ selectedCategories: categories });
    get().loadActivities();
  },

  toggleCategory: (category) => {
    const { selectedCategories } = get();
    const newCategories = selectedCategories.includes(category)
      ? selectedCategories.filter((c) => c !== category)
      : [...selectedCategories, category];
    set({ selectedCategories: newCategories });
    get().loadActivities();
  },

  toggleShowSystem: () => {
    set((state) => ({ showSystem: !state.showSystem }));
    get().loadActivities();
    get().loadCategories();
  },

  clearActivities: async () => {
    try {
      const result = await window.electron.clearActivities();
      if (result.success) {
        set({ activities: [], recentCount: 0, totalCount: 0 });
      }
    } catch (error) {
      console.error('Failed to clear activities:', error);
    }
  },

  markViewed: () => {
    set({ lastViewedTimestamp: Date.now(), recentCount: 0 });
  },

  addActivity: (activity) => {
    // System telemetry stays out of the default list and never bumps the badge
    set((state) => {
      // Several components subscribe to 'activity:new' and each forwards here,
      // so one event arrives as several calls — the feed was showing a single
      // error four or five times over. Identity is the row id; a repeat is a
      // redelivery, not a new event, and must not move the badge either.
      if (state.activities.some((a) => a.id === activity.id)) return state;

      return {
        activities:
          activity.audience === 'system' && !state.showSystem
            ? state.activities
            : [activity, ...state.activities].slice(0, 500),
        recentCount: activity.audience === 'user' ? state.recentCount + 1 : state.recentCount,
        totalCount: state.totalCount + 1,
      };
    });
  },
}));
