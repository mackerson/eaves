import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCompactMode } from './useCompactMode';
import { useConversationsStore, useUIPreferencesStore, useUIStore } from '@/stores';

function setup(opts: {
  compactMode: boolean;
  view: 'chats' | 'channels' | 'settings';
  currentChatId?: string | null;
  currentChannelId?: string | null;
}) {
  useUIPreferencesStore.setState({ compactMode: opts.compactMode });
  useUIStore.setState({ view: opts.view });
  useConversationsStore.setState({
    currentChatId: opts.currentChatId ?? null,
    currentChannelId: opts.currentChannelId ?? null,
  });
}

describe('useCompactMode', () => {
  beforeEach(() => {
    localStorage.clear();
    setup({ compactMode: false, view: 'chats', currentChatId: 'chat-1' });
  });

  it('is off while the preference is off', () => {
    const { result } = renderHook(() => useCompactMode());
    expect(result.current).toBe(false);
  });

  it('engages on a chat that is actually open', () => {
    setup({ compactMode: true, view: 'chats', currentChatId: 'chat-1' });
    const { result } = renderHook(() => useCompactMode());
    expect(result.current).toBe(true);
  });

  it('engages on a channel that is actually open', () => {
    setup({ compactMode: true, view: 'channels', currentChannelId: 'chan-1' });
    const { result } = renderHook(() => useCompactMode());
    expect(result.current).toBe(true);
  });

  // The three cases below are the whole point of the hook: compact mode hides
  // the sidebar, the menu bar and the conversation list, so engaging it with
  // nothing to show would leave a window with no way to navigate out.
  it('stays off on a non-message view', () => {
    setup({ compactMode: true, view: 'settings', currentChatId: 'chat-1' });
    const { result } = renderHook(() => useCompactMode());
    expect(result.current).toBe(false);
  });

  it('stays off when no chat is selected', () => {
    setup({ compactMode: true, view: 'chats', currentChatId: null });
    const { result } = renderHook(() => useCompactMode());
    expect(result.current).toBe(false);
  });

  it('stays off when no channel is selected', () => {
    setup({ compactMode: true, view: 'channels', currentChannelId: null });
    const { result } = renderHook(() => useCompactMode());
    expect(result.current).toBe(false);
  });

  it('does not confuse a chat selection for a channel one', () => {
    // Both surfaces keep their own "current" id, and both survive navigation.
    // Reading the wrong one would engage compact on an empty channel view.
    setup({ compactMode: true, view: 'channels', currentChatId: 'chat-1', currentChannelId: null });
    const { result } = renderHook(() => useCompactMode());
    expect(result.current).toBe(false);
  });
});
