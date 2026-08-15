import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIPreferencesStore, DEFAULT_COMPACT_HEADER } from './useUIPreferencesStore';

const SIDEBAR_COLLAPSED_KEY = 'eaves-sidebar-collapsed';
const COMPACT_MODE_KEY = 'eaves-compact-mode';
const COMPACT_HEADER_KEY = 'eaves-compact-header';

describe('useUIPreferencesStore — sidebarCollapsed', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIPreferencesStore.setState({ sidebarCollapsed: false });
  });

  it('defaults to expanded', () => {
    expect(useUIPreferencesStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setSidebarCollapsed writes state and persists it', () => {
    useUIPreferencesStore.getState().setSidebarCollapsed(true);

    expect(useUIPreferencesStore.getState().sidebarCollapsed).toBe(true);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('true');

    useUIPreferencesStore.getState().setSidebarCollapsed(false);

    expect(useUIPreferencesStore.getState().sidebarCollapsed).toBe(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('false');
  });

  it('toggleSidebar flips the current value and persists it', () => {
    useUIPreferencesStore.getState().toggleSidebar();

    expect(useUIPreferencesStore.getState().sidebarCollapsed).toBe(true);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('true');

    useUIPreferencesStore.getState().toggleSidebar();

    expect(useUIPreferencesStore.getState().sidebarCollapsed).toBe(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('false');
  });

  it('restores the persisted value on load', async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true');

    vi.resetModules();
    const { useUIPreferencesStore: freshStore } = await import('./useUIPreferencesStore');

    expect(freshStore.getState().sidebarCollapsed).toBe(true);
  });
});

describe('useUIPreferencesStore — compact mode', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIPreferencesStore.setState({
      compactMode: false,
      compactHeader: { ...DEFAULT_COMPACT_HEADER },
    });
  });

  it('defaults to off with a fully visible header', () => {
    expect(useUIPreferencesStore.getState().compactMode).toBe(false);
    expect(useUIPreferencesStore.getState().compactHeader).toEqual(DEFAULT_COMPACT_HEADER);
  });

  it('toggleCompactMode flips the value and persists it', () => {
    useUIPreferencesStore.getState().toggleCompactMode();

    expect(useUIPreferencesStore.getState().compactMode).toBe(true);
    expect(localStorage.getItem(COMPACT_MODE_KEY)).toBe('true');

    useUIPreferencesStore.getState().toggleCompactMode();

    expect(useUIPreferencesStore.getState().compactMode).toBe(false);
    expect(localStorage.getItem(COMPACT_MODE_KEY)).toBe('false');
  });

  it('setCompactHeaderPart changes one part and leaves the rest alone', () => {
    useUIPreferencesStore.getState().setCompactHeaderPart('model', false);

    expect(useUIPreferencesStore.getState().compactHeader).toEqual({
      ...DEFAULT_COMPACT_HEADER,
      model: false,
    });
    expect(JSON.parse(localStorage.getItem(COMPACT_HEADER_KEY)!)).toEqual({
      ...DEFAULT_COMPACT_HEADER,
      model: false,
    });
  });

  it('toggleCompactHeader hides and restores the whole header', () => {
    useUIPreferencesStore.getState().toggleCompactHeader();
    expect(useUIPreferencesStore.getState().compactHeader.visible).toBe(false);
    // Hiding the header must not discard which parts were on — showing it
    // again should bring back the same header, not a reset one.
    expect(useUIPreferencesStore.getState().compactHeader.identity).toBe(true);

    useUIPreferencesStore.getState().toggleCompactHeader();
    expect(useUIPreferencesStore.getState().compactHeader.visible).toBe(true);
  });

  it('restores persisted compact state on load', async () => {
    localStorage.setItem(COMPACT_MODE_KEY, 'true');
    localStorage.setItem(COMPACT_HEADER_KEY, JSON.stringify({ ...DEFAULT_COMPACT_HEADER, title: false }));

    vi.resetModules();
    const { useUIPreferencesStore: freshStore } = await import('./useUIPreferencesStore');

    expect(freshStore.getState().compactMode).toBe(true);
    expect(freshStore.getState().compactHeader.title).toBe(false);
  });

  it('fills in missing keys from a blob written by an older build', async () => {
    localStorage.setItem(COMPACT_HEADER_KEY, JSON.stringify({ identity: false }));

    vi.resetModules();
    const { useUIPreferencesStore: freshStore } = await import('./useUIPreferencesStore');

    expect(freshStore.getState().compactHeader).toEqual({
      ...DEFAULT_COMPACT_HEADER,
      identity: false,
    });
  });

  it('falls back to defaults when the stored header blob is corrupt', async () => {
    localStorage.setItem(COMPACT_HEADER_KEY, 'not json');

    vi.resetModules();
    const { useUIPreferencesStore: freshStore } = await import('./useUIPreferencesStore');

    expect(freshStore.getState().compactHeader).toEqual(DEFAULT_COMPACT_HEADER);
  });
});
