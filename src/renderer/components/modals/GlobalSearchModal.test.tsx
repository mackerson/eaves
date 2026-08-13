import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { GlobalSearchModal } from './GlobalSearchModal';
import { useAgentStore, useConversationsStore, useProjectStore, useUIStore } from '@/stores';

const note = (id: string, title: string) => ({
  id, title, content: `${title} body`, color: 'default', pinned: false,
  labels: [], sortOrder: 0, createdAt: 1, updatedAt: 1,
});

const file = (id: string, name: string, path: string) => ({
  id, projectId: 'p1', name, path, type: 'file', size: 1, createdAt: 1, updatedAt: 1,
});

let searchChats: ReturnType<typeof vi.fn>;
let searchChannels: ReturnType<typeof vi.fn>;
let listNotes: ReturnType<typeof vi.fn>;
let listFiles: ReturnType<typeof vi.fn>;
let switchChat: ReturnType<typeof vi.fn>;
let switchChannel: ReturnType<typeof vi.fn>;
let openNoteModal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  searchChats = vi.fn().mockResolvedValue({ success: true, chats: [] });
  searchChannels = vi.fn().mockResolvedValue({ success: true, channels: [] });
  listNotes = vi.fn().mockResolvedValue([]);
  listFiles = vi.fn().mockResolvedValue([]);
  (window as any).electron = { searchChats, searchChannels, listNotes, listFiles };

  switchChat = vi.fn().mockResolvedValue(undefined);
  switchChannel = vi.fn().mockResolvedValue(undefined);
  openNoteModal = vi.fn();

  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'Alpha', description: '', tasks: [], notes: [], events: [], files: [], createdAt: 1 }],
    currentProjectId: 'p1',
    openNoteModal,
  } as never);
  useAgentStore.setState({ agents: [{ id: 'a1', name: 'Scout' }] } as never);
  useConversationsStore.setState({ switchChat, switchChannel } as never);
  useUIStore.setState({ view: 'agents' } as never);
});

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('Search everything'), { target: { value } });

describe('GlobalSearchModal', () => {
  it('shows nothing and queries nothing for an empty box', async () => {
    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Start typing to search.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 250));
    expect(searchChats).not.toHaveBeenCalled();
  });

  it('groups results by kind', async () => {
    searchChats.mockResolvedValue({ success: true, chats: [{ id: 'c1', name: 'Chat One', agentId: 'a1' }] });
    searchChannels.mockResolvedValue({ success: true, channels: [{ id: 'ch1', name: 'general', projectId: 'p1' }] });
    listNotes.mockResolvedValue([note('n1', 'Note One')]);
    listFiles.mockResolvedValue([file('f1', 'one.txt', '/tmp/one.txt')]);

    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);
    type('one');

    await waitFor(() => expect(screen.getByText('Chat One')).toBeTruthy());
    expect(screen.getByText('Chats')).toBeTruthy();
    expect(screen.getByText('Channels')).toBeTruthy();
    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.getByText('Files')).toBeTruthy();
    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.getByText('Note One')).toBeTruthy();
    expect(screen.getByText('one.txt')).toBeTruthy();
    // Chat subtitle resolves the agent name.
    expect(screen.getByText('Scout')).toBeTruthy();
  });

  it('debounces so a burst of keystrokes fires one query', async () => {
    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);
    type('o');
    type('on');
    type('one');

    await waitFor(() => expect(searchChats).toHaveBeenCalledTimes(1));
    expect(searchChats).toHaveBeenCalledWith({ query: 'one' });
  });

  it('says so plainly when nothing matches', async () => {
    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);
    type('zzz');

    await waitFor(() => expect(screen.getByText(/No results for/)).toBeTruthy());
  });

  it('filters files client-side — files:list has no query support', async () => {
    listFiles.mockResolvedValue([file('f1', 'one.txt', '/tmp/one.txt'), file('f2', 'other.md', '/tmp/other.md')]);

    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);
    type('one.txt');

    await waitFor(() => expect(screen.getByText('one.txt')).toBeTruthy());
    expect(listFiles).toHaveBeenCalledWith('p1');
    expect(screen.queryByText('other.md')).toBeNull();
  });

  it('opens the highlighted result on Enter and closes', async () => {
    searchChats.mockResolvedValue({ success: true, chats: [{ id: 'c1', name: 'Chat One', agentId: 'a1' }] });
    const onOpenChange = vi.fn();

    render(<GlobalSearchModal open onOpenChange={onOpenChange} />);
    type('one');
    await waitFor(() => expect(screen.getByText('Chat One')).toBeTruthy());

    fireEvent.keyDown(screen.getByLabelText('Search everything'), { key: 'Enter' });

    expect(switchChat).toHaveBeenCalledWith('c1');
    expect(useUIStore.getState().view).toBe('chats');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('moves the highlight across group boundaries with the arrow keys', async () => {
    searchChats.mockResolvedValue({ success: true, chats: [{ id: 'c1', name: 'Chat One', agentId: 'a1' }] });
    searchChannels.mockResolvedValue({ success: true, channels: [{ id: 'ch1', name: 'general' }] });

    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);
    type('one');
    await waitFor(() => expect(screen.getByText('general')).toBeTruthy());

    const input = screen.getByLabelText('Search everything');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(switchChannel).toHaveBeenCalledWith('ch1');
    expect(switchChat).not.toHaveBeenCalled();
    expect(useUIStore.getState().view).toBe('channels');
  });

  it('opens a note in its project', async () => {
    const n = note('n1', 'Note One');
    listNotes.mockResolvedValue([n]);

    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);
    type('one');
    await waitFor(() => expect(screen.getByText('Note One')).toBeTruthy());

    fireEvent.click(screen.getByText('Note One'));

    expect(useUIStore.getState().view).toBe('notes');
    expect(openNoteModal).toHaveBeenCalledWith(n);
  });

  // Regression guard: with a per-keystroke debounce a slow early query can still
  // land after a fast later one, and without the sequence check it repaints the
  // list with results for a query the user has already moved past.
  it('ignores a stale query that resolves after a newer one', async () => {
    let resolveSlow: (v: unknown) => void = () => {};
    searchChats
      .mockImplementationOnce(() => new Promise((res) => { resolveSlow = res; }))
      .mockResolvedValue({ success: true, chats: [{ id: 'c2', name: 'Fast Result', agentId: 'a1' }] });

    render(<GlobalSearchModal open onOpenChange={vi.fn()} />);
    type('slow');
    await waitFor(() => expect(searchChats).toHaveBeenCalledTimes(1));

    type('fast');
    await waitFor(() => expect(screen.getByText('Fast Result')).toBeTruthy());

    resolveSlow({ success: true, chats: [{ id: 'c1', name: 'Stale Result', agentId: 'a1' }] });
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.queryByText('Stale Result')).toBeNull();
    expect(screen.getByText('Fast Result')).toBeTruthy();
  });
});
