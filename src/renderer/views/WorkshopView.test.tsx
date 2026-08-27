/**
 * @vitest-environment happy-dom
 *
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

// The real row hides regenerate/delete behind a dropdown menu. The wiring is
// what regressed (both were `() => {}`), so the stand-in exposes the handlers
// directly and the dropdown stays ChatMessageRow's own business.
vi.mock('@/components/ChatMessageRow', () => ({
  ChatMessageRow: ({ messageId, content, onRetry, onDelete }: any) => (
    <div>
      <span>{content}</span>
      <button data-testid={`retry-${messageId}`} onClick={() => onRetry(messageId)}>retry</button>
      <button data-testid={`delete-${messageId}`} onClick={() => onDelete(messageId)}>delete</button>
    </div>
  ),
}));

const SESSION = { id: 'chat-1', name: 'New build', agentId: 'agent-1', messages: [], participants: [], createdAt: 1 };

let electron: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  electron = {
    listPluginDrafts: vi.fn().mockResolvedValue({ success: true, drafts: [] }),
    listWorkshopSessions: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    // The bench subscribes to the preview verdict rather than polling for it.
    onPluginRenderReport: vi.fn().mockReturnValue(() => {}),
    startWorkshopSession: vi.fn().mockResolvedValue({ success: true, session: SESSION }),
    sendChatMessage: vi.fn().mockResolvedValue({ success: true }),
    getChat: vi.fn().mockResolvedValue({ success: true, chat: SESSION }),
    chatWithAgent: vi.fn().mockResolvedValue({ success: true }),
    updateChat: vi.fn().mockResolvedValue({ success: true }),
    deleteChat: vi.fn().mockResolvedValue({ success: true }),
    regenerateChatMessage: vi.fn().mockResolvedValue({ success: true }),
    deleteChatMessage: vi.fn().mockResolvedValue({ success: true }),
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
    // Leaks between tests otherwise, and the transcript filters the row it
    // names — a stale id silently empties the message list.
    regeneratingMessageId: null,
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

  // Regenerate was stubbed to a no-op when the transcript was composed out of
  // ChatMessageRow instead of reused from ChatsView: a button that looked live
  // and did nothing, worst at exactly the moment it is most wanted — a turn
  // died on a provider error and you switched models to get past it.
  // The real control lives behind a dropdown; what regressed was the wiring,
  // so that is what is asserted — the row is handed a handler that reaches
  // IPC, rather than the `() => {}` it used to get.
  it('regenerates a message rather than pretending to', async () => {
    const withReply = {
      ...SESSION,
      messages: [
        { id: 'm1', content: 'build me a snowglobe', senderType: 'human', senderId: 'u1' },
        { id: 'm2', content: 'Error: model retired', senderType: 'agent', senderId: 'a1' },
      ],
    };
    electron.getChat.mockResolvedValue({ success: true, chat: withReply });
    useConversationsStore.setState({ chats: [withReply as never], currentChatId: SESSION.id });

    render(<WorkshopView />);

    fireEvent.click(await screen.findByTestId('retry-m2'));

    await waitFor(() =>
      expect(electron.regenerateChatMessage).toHaveBeenCalledWith({ messageId: 'm2' }),
    );
    // The row vanishes while it restreams, so the new bubble lands in its place.
    expect(useConversationsStore.getState().regeneratingMessageId).toBe('m2');
  });

  it('deletes a message rather than pretending to', async () => {
    const withReply = {
      ...SESSION,
      messages: [{ id: 'm2', content: 'oops', senderType: 'agent', senderId: 'a1' }],
    };
    electron.getChat.mockResolvedValue({ success: true, chat: withReply });
    useConversationsStore.setState({ chats: [withReply as never], currentChatId: SESSION.id });

    render(<WorkshopView />);
    fireEvent.click(await screen.findByTestId('delete-m2'));

    await waitFor(() => expect(electron.deleteChatMessage).toHaveBeenCalledWith('m2'));
  });

  // Every "New build" is a chat row the chat list is deliberately blind to,
  // so without a delete here the only way to be rid of one is the database.
  it('deletes a build, once, and only after the confirmation', async () => {
    render(<WorkshopView />);

    fireEvent.change(await screen.findByPlaceholderText(/Describe what you want/i), {
      target: { value: 'a dice roller' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/Describe what you want/i), { key: 'Enter' });
    await waitFor(() => expect(electron.startWorkshopSession).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /Delete build/i }));
    expect(electron.deleteChat).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/i }));
    await waitFor(() => expect(electron.deleteChat).toHaveBeenCalledWith(SESSION.id));
  });
});
