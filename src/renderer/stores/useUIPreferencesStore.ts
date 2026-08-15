import { create } from 'zustand';

/**
 * Per-device UI preferences persisted to localStorage. These are cosmetic,
 * device-local choices (deliberately NOT part of the synced settings store) —
 * two people on two machines can each pick their own view.
 */

export type MessageLayout = 'inline' | 'stacked';

const MESSAGE_LAYOUT_KEY = 'eaves-message-layout';
const ACTION_GUTTER_KEY = 'eaves-action-gutter-collapsed';
const SIDEBAR_COLLAPSED_KEY = 'eaves-sidebar-collapsed';
const COMPACT_MODE_KEY = 'eaves-compact-mode';
const COMPACT_HEADER_KEY = 'eaves-compact-header';

function readMessageLayout(): MessageLayout {
  try {
    return localStorage.getItem(MESSAGE_LAYOUT_KEY) === 'stacked' ? 'stacked' : 'inline';
  } catch {
    return 'inline';
  }
}

function readActionGutterCollapsed(): boolean {
  try {
    return localStorage.getItem(ACTION_GUTTER_KEY) === 'true';
  } catch {
    return false;
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function readCompactMode(): boolean {
  try {
    return localStorage.getItem(COMPACT_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Which parts of the compact header are shown. `visible: false` collapses the
 * whole thing to its control rail — which still has to render, because in
 * compact mode that bar *is* the title bar (see CompactHeader).
 */
export interface CompactHeaderPrefs {
  visible: boolean;
  identity: boolean;
  title: boolean;
  model: boolean;
}

export const DEFAULT_COMPACT_HEADER: CompactHeaderPrefs = {
  visible: true,
  identity: true,
  title: true,
  model: true,
};

function readCompactHeader(): CompactHeaderPrefs {
  try {
    const raw = localStorage.getItem(COMPACT_HEADER_KEY);
    if (!raw) return DEFAULT_COMPACT_HEADER;
    const parsed = JSON.parse(raw) as Partial<CompactHeaderPrefs>;
    // Merged onto the defaults rather than trusted wholesale: a stored blob
    // written by an older build is missing keys a newer one reads.
    return {
      visible: typeof parsed.visible === 'boolean' ? parsed.visible : DEFAULT_COMPACT_HEADER.visible,
      identity: typeof parsed.identity === 'boolean' ? parsed.identity : DEFAULT_COMPACT_HEADER.identity,
      title: typeof parsed.title === 'boolean' ? parsed.title : DEFAULT_COMPACT_HEADER.title,
      model: typeof parsed.model === 'boolean' ? parsed.model : DEFAULT_COMPACT_HEADER.model,
    };
  } catch {
    return DEFAULT_COMPACT_HEADER;
  }
}

interface UIPreferencesState {
  /**
   * How sender attribution renders in chat rows:
   *  - 'inline'  — name in a fixed-width gutter beside the message (default).
   *  - 'stacked' — name on its own line above the message.
   */
  messageLayout: MessageLayout;
  setMessageLayout: (layout: MessageLayout) => void;
  /**
   * Whether the pending-actions gutter is collapsed to its rail. Collapsed is
   * still visible — an agent waiting on approval must never become invisible,
   * or the conversation just looks stalled for no reason.
   */
  actionGutterCollapsed: boolean;
  setActionGutterCollapsed: (collapsed: boolean) => void;
  /**
   * Whether the main navigation sidebar is collapsed to its icon rail. Lives
   * here rather than in the Sidebar so the menu bar can drive it too.
   */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  /**
   * Compact ("companion") mode: one conversation, no app chrome. Only takes
   * effect on the two message surfaces — see useCompactMode, which is what UI
   * should read. This flag is the user's intent, not the current rendering.
   */
  compactMode: boolean;
  setCompactMode: (compact: boolean) => void;
  toggleCompactMode: () => void;
  compactHeader: CompactHeaderPrefs;
  setCompactHeaderPart: (part: keyof CompactHeaderPrefs, visible: boolean) => void;
  toggleCompactHeader: () => void;
}

export const useUIPreferencesStore = create<UIPreferencesState>((set, get) => ({
  actionGutterCollapsed: readActionGutterCollapsed(),
  setActionGutterCollapsed: (actionGutterCollapsed) => {
    try {
      localStorage.setItem(ACTION_GUTTER_KEY, String(actionGutterCollapsed));
    } catch {
      // Non-fatal: preference just won't persist across restarts.
    }
    set({ actionGutterCollapsed });
  },

  sidebarCollapsed: readSidebarCollapsed(),
  setSidebarCollapsed: (sidebarCollapsed) => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
    } catch {
      // Non-fatal: preference just won't persist across restarts.
    }
    set({ sidebarCollapsed });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),

  compactMode: readCompactMode(),
  setCompactMode: (compactMode) => {
    try {
      localStorage.setItem(COMPACT_MODE_KEY, String(compactMode));
    } catch {
      // Non-fatal: preference just won't persist across restarts.
    }
    set({ compactMode });
  },
  toggleCompactMode: () => get().setCompactMode(!get().compactMode),

  compactHeader: readCompactHeader(),
  setCompactHeaderPart: (part, visible) => {
    const compactHeader = { ...get().compactHeader, [part]: visible };
    try {
      localStorage.setItem(COMPACT_HEADER_KEY, JSON.stringify(compactHeader));
    } catch {
      // Non-fatal: preference just won't persist across restarts.
    }
    set({ compactHeader });
  },
  toggleCompactHeader: () => get().setCompactHeaderPart('visible', !get().compactHeader.visible),

  messageLayout: readMessageLayout(),
  setMessageLayout: (messageLayout) => {
    try {
      localStorage.setItem(MESSAGE_LAYOUT_KEY, messageLayout);
    } catch {
      // Non-fatal: preference just won't persist across restarts.
    }
    set({ messageLayout });
  },
}));
