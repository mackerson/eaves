/**
 * The send path, because it broke in a way that looked like nothing at all.
 *
 * `sendChatMessage` only STORES a message; the renderer has to ask for the
 * reply separately (`chatWithAgent`), exactly as ChatsView does. The first cut
 * of this view did not, so a build session accepted what you typed, showed
 * "Working…", and sat there forever with no agent ever answering. Nothing
 * errored and nothing logged — which is why it is pinned here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WorkshopView } from './WorkshopView';
import { useConversationsStore, useSettingsStore, useToastStore } from '@/stores';

const SESSION = { id: 'chat-1', name: 'New build', agentId: 'agent-1', messages: [], participants: [], createdAt: 1 };

let electron: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  electron = {
    listPluginDrafts: vi.fn().mockResolvedValue({ success: true, drafts: [] }),
    listWorkshopSessions: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    startWorkshopSession: vi.fn().mockResolvedValue({ success: true, session: SESSION }),
    sendChatMessage: vi.fn().mockResolvedValue({ success: true }),
    getChat: vi.fn().mockResolvedValue({ success: true, chat: SESSION }),
    chatWithAgent: vi.fn().mockResolvedValue({ success: true }),
    updateChat: vi.fn().mockResolvedValue({ success: true }),
    // switchChat() in the real store reaches for these; without them opening a
    // session throws and the send never gets as far as the thing under test.
    switchChat: vi.fn().mockResolvedValue({ success: true }),
    getChats: vi.fn().mockResolvedValue({ success: true, chats: [SESSION] }),
  };
  (window as never as { electron: unknown }).electron = electron;

  useSettingsStore.setState({ settings: { pluginAuthoringEnabled: true } } as never);
  useConversationsStore.setState({
    input: '', currentChatId: null, chats: [], isLoading: false,
    streamingContent: '', streamingContentBlocks: [],
  } as never);
  useToastStore.setState({ toasts: [] } as never);
});

const type = async (text: string) => {
  const box = await screen.findByPlaceholderText(/Describe what you want Eaves to do/i);
  fireEvent.change(box, { target: { value: text } });
  return box;
};

describe('WorkshopView send', () => {
  it('asks the agent for a reply, not just stores the message', async () => {
    render(<WorkshopView />);
    const box = await type('a dice roller');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(electron.sendChatMessage).toHaveBeenCalled());
    // The assertion that matters: storing without asking is the bug.
    await waitFor(() =>
      expect(electron.chatWithAgent).toHaveBeenCalledWith({ chatId: 'chat-1', agentId: 'agent-1' }),
    );
  });

  it('starts exactly one session however fast the send is repeated', async () => {
    // Creating a session is a round trip, and isLoading is not set until after
    // it — so a second Enter inside that window used to start a second session
    // and orphan the first, empty, in the past-builds list.
    let release: (v: unknown) => void = () => {};
    electron.startWorkshopSession.mockReturnValue(
      new Promise((resolve) => { release = resolve; }),
    );

    render(<WorkshopView />);
    const box = await type('a dice roller');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });

    release({ success: true, session: SESSION });
    await waitFor(() => expect(electron.sendChatMessage).toHaveBeenCalled());
    expect(electron.startWorkshopSession).toHaveBeenCalledTimes(1);
  });

  it('names the build after the ask, so past builds are told apart', async () => {
    render(<WorkshopView />);
    const box = await type('  a   dice roller  ');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() =>
      expect(electron.updateChat).toHaveBeenCalledWith('chat-1', { name: 'a dice roller' }),
    );
  });

  it('releases the composer when there is no agent to answer', async () => {
    electron.getChat.mockResolvedValue({ success: true, chat: { ...SESSION, agentId: undefined } });
    electron.startWorkshopSession.mockResolvedValue({
      success: true, session: { ...SESSION, agentId: undefined },
    });

    render(<WorkshopView />);
    const box = await type('a dice roller');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(electron.sendChatMessage).toHaveBeenCalled());
    expect(electron.chatWithAgent).not.toHaveBeenCalled();
    await waitFor(() => expect(useConversationsStore.getState().isLoading).toBe(false));
  });

  it('offers the trust decision instead of the bench when authoring is off', async () => {
    useSettingsStore.setState({ settings: { pluginAuthoringEnabled: false } } as never);
    render(<WorkshopView />);

    expect(await screen.findByText(/Agents can run code they wrote/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Describe what you want/i)).toBeNull();
  });
});
