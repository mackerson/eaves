import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChatInput } from '@/components/ChatInput';
import { ChatMessageRow } from '@/components/ChatMessageRow';
import { ContentBlock } from '@/components/content/ContentBlock';
import { ConfirmDialog } from '@/components/modals/ConfirmDialog';
import { useConversationsStore, useSettingsStore, useToastStore } from '@/stores';
import {
  PLUGIN_AUTHORING_TITLE,
  PLUGIN_AUTHORING_EXPLAINER,
  PLUGIN_AUTHORING_WARNING_TITLE,
  PLUGIN_AUTHORING_WARNING,
} from '@/lib/pluginAuthoringCopy';
import { DraftManifest } from '@/components/workshop/DraftManifest';
import { DraftCodeDialog } from '@/components/workshop/DraftCodeDialog';
import { WorkshopScaffolds } from '@/components/workshop/WorkshopScaffolds';
import type { Chat, PluginDraft } from '@/../shared/types';

/**
 * The Workshop: a bench where a plugin gets built, with the human's hands on it.
 *
 * Left is the conversation — you say what you want Eaves to be able to do, and
 * an agent builds it. Right is the bench: not a list of cards, but one panel
 * describing the thing being made — what state the build is in, what it will
 * be able to do (read off its own source, not just its manifest), what it
 * actually added once it ran, and only then the controls that commit. There is
 * normally exactly one draft in flight, so a list was answering a question
 * nobody had while leaving the real one unanswered. See DraftManifest.
 *
 * The transcript is composed from `ChatMessageRow` and `ChatInput` rather than
 * extracted out of `ChatsView`, which owns queueing, attachments, editing and
 * branch-swiping that a bench has no use for. The one prop that carries real
 * weight is `approvalContext`: it is what lets the inline tool-approval cards
 * resume the right stream, and those cards *are* the tactile moment — writing a
 * plugin and running it both stop and ask, right there in the transcript.
 *
 * A workshop session is a `direct` chat with `workshop = 1`, so everything else
 * — streaming, persistence, approvals — is the ordinary chat path untouched.
 * `useChatStream()` is mounted app-wide and follows `currentChatId`.
 */

interface DraftFile { path: string; content: string }

export function WorkshopView() {
  const enabled = useSettingsStore((s) => s.settings.pluginAuthoringEnabled) === true;
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const showToast = useToastStore((s) => s.showToast);

  const [sessions, setSessions] = useState<Chat[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PluginDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reading, setReading] = useState<{
    name: string; files: DraftFile[]; previous?: DraftFile[];
  } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<PluginDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const input = useConversationsStore((s) => s.input);
  const setInput = useConversationsStore((s) => s.setInput);
  const isLoading = useConversationsStore((s) => s.isLoading);
  const streamingContent = useConversationsStore((s) => s.streamingContent);
  const streamingContentBlocks = useConversationsStore((s) => s.streamingContentBlocks);
  const session = useConversationsStore((s) => s.chats.find((c) => c.id === s.currentChatId));
  const regeneratingMessageId = useConversationsStore((s) => s.regeneratingMessageId);

  const bottomRef = useRef<HTMLDivElement>(null);
  /** One send at a time — see the comment in send(). */
  const sending = useRef(false);

  const refreshDrafts = useCallback(async () => {
    const result = await window.electron.listPluginDrafts();
    setDrafts(result?.drafts ?? []);
  }, []);

  const refreshSessions = useCallback(async () => {
    const result = await window.electron.listWorkshopSessions();
    setSessions(result?.sessions ?? []);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refreshDrafts();
    void refreshSessions();
  }, [enabled, refreshDrafts, refreshSessions]);

  // A preview's verdict arrives once, seconds after a click, and never again.
  // That is the worst possible shape for a poll — the old one ran every 1.5s
  // for 30s and then gave up, so a slow bundle rendered into a bench that had
  // stopped listening. Main pushes it instead.
  useEffect(() => {
    if (!enabled) return;
    return window.electron.onPluginRenderReport(() => void refreshDrafts());
  }, [enabled, refreshDrafts]);

  // A turn ending is when the bench changes: a draft was written, or started.
  const wasLoading = useRef(isLoading);
  useEffect(() => {
    const ended = wasLoading.current && !isLoading;
    wasLoading.current = isLoading;
    if (ended) void refreshDrafts();
  }, [isLoading, refreshDrafts]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages?.length, streamingContent]);

  const openSession = useCallback(async (id: string) => {
    setSessionId(id);
    await useConversationsStore.getState().switchChat(id);
  }, []);

  /**
   * Builds accumulate: every "New build" is a chat row that the chat list is
   * deliberately blind to, so without this the only way to be rid of one is
   * the database. Deleting the conversation is all it takes — the drafts it
   * produced live on disk and are discarded separately, on the bench.
   */
  const deleteSession = useCallback(async (id: string) => {
    const result = await window.electron.deleteChat(id);
    if (result && result.success === false) {
      showToast('Could not delete that build', 'error');
      return;
    }
    if (sessionId === id) {
      setSessionId(null);
      useConversationsStore.setState({ currentChatId: null });
    }
    useConversationsStore.setState((state) => ({
      chats: state.chats.filter((c) => c.id !== id),
    }));
    await refreshSessions();
    showToast('Build deleted', 'success');
  }, [sessionId, refreshSessions, showToast]);

  const startSession = useCallback(async (): Promise<string | null> => {
    setStarting(true);
    try {
      const result = await window.electron.startWorkshopSession();
      if (!result?.success || !result.session) {
        showToast(result?.error || 'Could not start a build', 'error');
        return null;
      }
      // The session is a chat the store has never seen — put it in place before
      // switching, or switchChat has nothing to render.
      useConversationsStore.setState((state) => ({
        chats: [result.session as Chat, ...state.chats],
      }));
      await refreshSessions();
      await openSession(result.session.id);
      return result.session.id;
    } finally {
      setStarting(false);
    }
  }, [openSession, refreshSessions, showToast]);

  const send = useCallback(async () => {
    const { input: text, setInput: clear, isLoading: busy } = useConversationsStore.getState();
    if (!text.trim() || busy || sending.current) return;

    // Claim the send before the first await. Creating a session is a round
    // trip, and `isLoading` is not set until after it — so without this a
    // second Enter during that window passed both guards and started a second
    // session, leaving an empty one orphaned in the past-builds list.
    sending.current = true;
    const text_ = text;
    clear('');

    try {
      let target = sessionId;
      const isFirstMessage = !target || !session?.messages?.length;
      if (!target) {
        target = await startSession();
        if (!target) return;
      }

      // Name the build after what was asked for. Every session is created as
      // "New build", which makes the past-builds list a row of identical
      // entries — useless exactly when you want to go back to one.
      if (isFirstMessage) {
        const name = text_.trim().replace(/\s+/g, ' ').slice(0, 60);
        void window.electron
          .updateChat(target, { name })
          .then(() => refreshSessions())
          .catch(() => { /* naming is cosmetic; never fail a send over it */ });
      }

      useConversationsStore.setState({
        isLoading: true, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [],
      });

      const sent = await window.electron.sendChatMessage({ chatId: target, content: text_ });
      if (sent && sent.success === false) {
        showToast(sent.error || 'Message could not be sent', 'error');
        useConversationsStore.setState({ isLoading: false });
        return;
      }

      const reloaded = await window.electron.getChat(target);
      const fresh = reloaded.success ? reloaded.chat : undefined;
      if (fresh) {
        useConversationsStore.setState((state) => ({
          chats: state.chats.map((c) => (c.id === fresh.id ? fresh : c)),
        }));
      }

      // sendChatMessage only STORES the message. Nothing on the main side
      // starts a turn from it — the renderer asks for the reply, which is what
      // ChatsView.dispatchSend does too. Without this the message lands, no
      // agent ever answers, and the composer sits on "Working…" forever.
      const agentId = fresh?.agentId ?? session?.agentId;
      if (agentId) {
        await window.electron.chatWithAgent({ chatId: target, agentId });
      } else {
        // Nobody to answer: release the busy state rather than waiting for a
        // stream:end that will never arrive.
        useConversationsStore.setState({
          isLoading: false, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [],
        });
        showToast('This build has no agent to answer', 'error');
      }
    } catch (error: any) {
      showToast(error?.message || 'Message could not be sent', 'error');
      useConversationsStore.setState({
        isLoading: false, streamingContent: '', streamingContentBlocks: [], activeToolCalls: [],
      });
    } finally {
      sending.current = false;
    }
  }, [sessionId, session, startSession, refreshSessions, showToast]);

  /**
   * Regenerate, on the bench.
   *
   * This was stubbed to a no-op when the transcript was composed out of
   * ChatMessageRow rather than reused from ChatsView, which left a button that
   * looked live and did nothing — worst at exactly the moment it is most
   * wanted, when a turn has died on a provider error and you have just
   * switched models to get past it.
   */
  const regenerate = useCallback(async (messageId: string) => {
    // Deliberately not gated on the local `sessionId`: regeneration is
    // addressed by message, main resolves the conversation from it, and a row
    // you can see is a row you can regenerate. Requiring the local state to
    // agree is how the button goes dead again the first time the two drift.
    if (isLoading) return;
    // Hiding the row immediately is what makes the streaming bubble appear in
    // its place rather than below it. Cleared by the stream:end listener.
    useConversationsStore.setState({
      isLoading: true,
      streamingContent: '',
      streamingContentBlocks: [],
      activeToolCalls: [],
      regeneratingMessageId: messageId,
    });
    try {
      const result = await window.electron.regenerateChatMessage({ messageId });
      if (!result.success && !result.aborted && result.error) showToast(result.error, 'error');
    } catch (error: any) {
      showToast(error?.message || 'Could not regenerate', 'error');
      useConversationsStore.setState({
        isLoading: false,
        streamingContent: '',
        streamingContentBlocks: [],
        activeToolCalls: [],
        regeneratingMessageId: null,
      });
    }
  }, [isLoading, showToast]);

  const deleteMessage = useCallback(async (messageId: string) => {
    const openId = session?.id ?? sessionId;
    if (!openId) return;
    const result = await window.electron.deleteChatMessage(messageId);
    if (result && result.success === false) {
      showToast('Could not delete that message', 'error');
      return;
    }
    const reloaded = await window.electron.getChat(openId);
    if (reloaded.success && reloaded.chat) {
      const fresh = reloaded.chat;
      useConversationsStore.setState((state) => ({
        chats: state.chats.map((c) => (c.id === fresh.id ? fresh : c)),
      }));
    }
  }, [session, sessionId, showToast]);

  const readCode = async (draft: PluginDraft) => {
    const result = await window.electron.readPluginDraft(draft.id);
    if (!result?.success || !result.files) {
      showToast(result?.error || 'Could not read that draft', 'error');
      return;
    }
    setReading({ name: draft.name, files: result.files, previous: result.previous });
  };

  /** Every bench control is the same shape: act, say what happened, re-read. */
  const act = async (
    draft: PluginDraft,
    verb: string,
    run: () => Promise<{ success: boolean; error?: string }>,
    done: string,
  ) => {
    setBusyId(draft.id);
    try {
      const result = await run();
      if (!result?.success) {
        showToast(result?.error || `Could not ${verb} ${draft.name}`, 'error');
        return;
      }
      showToast(done, 'success');
      await refreshDrafts();
    } catch (error: any) {
      showToast(error?.message || `Could not ${verb} ${draft.name}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  // One draft is the normal case; the selector only appears past that.
  const selected = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? drafts[0],
    [drafts, selectedId],
  );

  /** The ask that started this build — the first thing the human said in it. */
  const ask = useMemo(
    () => session?.messages?.find((m) => m.senderType === 'human')?.content?.trim(),
    [session],
  );

  // ── The trust decision, offered where it is actually met ───────────────────
  if (!enabled) {
    return (
      <div className="p-8 overflow-y-auto">
        <div className="mb-6">
          <h2 className="text-3xl font-semibold">Workshop</h2>
          <p className="text-muted-foreground mt-2">
            Ask for something and an agent builds it. You watch, and you decide.
          </p>
        </div>
        <div className="max-w-2xl border border-border rounded-lg p-6 space-y-4">
          <div>
            <h3 className="font-medium">{PLUGIN_AUTHORING_TITLE}</h3>
            <p className="text-sm text-muted-foreground mt-1">{PLUGIN_AUTHORING_EXPLAINER}</p>
          </div>
          <div
            className="p-3 rounded-md border"
            style={{ background: 'rgba(220, 38, 38, 0.08)', borderColor: 'rgb(220, 38, 38)' }}
          >
            <p className="text-sm font-semibold" style={{ color: 'rgb(220, 38, 38)' }}>
              {PLUGIN_AUTHORING_WARNING_TITLE}
            </p>
            <p className="text-sm mt-1 text-muted-foreground">{PLUGIN_AUTHORING_WARNING}</p>
          </div>
          <Button
            onClick={() =>
              updateSettings({ pluginAuthoringEnabled: true }).catch((error: unknown) =>
                showToast(error instanceof Error ? error.message : 'Save failed', 'error'),
              )
            }
          >
            Turn this on
          </Button>
        </div>
      </div>
    );
  }

  const streamingBlocks = [
    ...streamingContentBlocks,
    ...(streamingContent
      ? [{ type: 'text' as const, content: streamingContent, timestamp: Date.now() }]
      : []),
  ];

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-0">
      {/* ── The conversation ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="px-6 pt-6 pb-3 border-b border-border flex items-center justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold">Workshop</h2>
            <p className="text-sm text-muted-foreground">
              {session ? session.name : 'Ask for something and an agent builds it.'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {sessions.length > 0 && (
              <select
                className="bg-background border border-border rounded-md text-sm px-2 py-1 max-w-48"
                value={sessionId ?? ''}
                onChange={(e) => e.target.value && void openSession(e.target.value)}
              >
                <option value="">Past builds…</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            {session && (
              <Button
                variant="outline" size="sm"
                onClick={() => setDeleteTarget({ id: session.id, name: session.name })}
              >
                Delete build
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={starting} onClick={() => void startSession()}>
              New build
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* The ask stays until there is something to read. A started-but-empty
              session with a blank pane tells a first-time user nothing. */}
          {!session || !session.messages?.length ? (
            <div className="h-full flex flex-col items-center justify-center">
              <WorkshopScaffolds onPick={setInput} />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {session.messages?.filter((msg) => msg.id !== regeneratingMessageId).map((msg) => (
                <ChatMessageRow
                  key={msg.id}
                  messageId={msg.id}
                  content={msg.content}
                  senderType={msg.senderType}
                  displayName={msg.senderDisplayName || (msg.senderType === 'human' ? 'You' : 'Agent')}
                  nameColor={msg.senderColor || (msg.senderType === 'human' ? '#60a5fa' : '#c084fc')}
                  contentBlocks={msg.contentBlocks}
                  metrics={msg.metrics}
                  isEditing={false}
                  editingContent=""
                  // The load-bearing prop: this is what lets the inline
                  // approval cards resume the right stream when you allow a
                  // define or an activate.
                  approvalContext={
                    msg.senderType === 'agent' && sessionId
                      ? { context: 'chat', contextId: sessionId, agentId: msg.senderId }
                      : undefined
                  }
                  // Editing a message mid-build would desync the transcript
                  // from the drafts already written from it, so the bench does
                  // not offer it — isEditing is pinned false above and these
                  // are never reached. Regenerate and delete are real.
                  onStartEdit={() => {}}
                  onSetEditContent={() => {}}
                  onSaveEdit={() => {}}
                  onCancelEdit={() => {}}
                  onDelete={(id) => void deleteMessage(id)}
                  onRetry={(id) => void regenerate(id)}
                />
              ))}
              {isLoading && streamingBlocks.length > 0 && (
                <div className="w-full">
                  {streamingBlocks.map((block, idx) => (
                    <div key={`stream-${idx}`} className={idx > 0 ? 'mt-2' : ''}>
                      <ContentBlock block={block} />
                    </div>
                  ))}
                </div>
              )}
              {isLoading && streamingBlocks.length === 0 && (
                <div className="text-sm text-muted-foreground">Working…</div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="px-6 pb-6">
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={() => void send()}
            disabled={isLoading || starting}
            disabledReason={isLoading ? 'The agent is working' : undefined}
            placeholder={session ? 'Say what to change…' : 'Describe what you want Eaves to do…'}
          />
        </div>
      </div>

      {/* ── The bench ──────────────────────────────────────────────────────── */}
      <aside className="w-full lg:w-80 flex-shrink-0 border-t lg:border-t-0 lg:border-l border-border flex flex-col min-h-0 max-h-[45%] lg:max-h-none">
        {/* A selector only when there is genuinely more than one thing being
            built. The normal case is one draft, and a list of one is furniture. */}
        {drafts.length > 1 && (
          <div className="px-4 py-2 border-b border-border">
            <select
              className="w-full bg-background border border-border rounded-md text-sm px-2 py-1"
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {drafts.map((draft) => (
                <option key={draft.id} value={draft.id}>
                  {draft.name}{draft.running ? ' · running' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {!selected ? (
            <div className="text-sm text-muted-foreground space-y-2">
              <p>Nothing on the bench yet.</p>
              <p className="text-xs">
                When the agent writes a plugin it appears here first — what it is, what it will be
                able to do, and every file it contains — before anything is installed.
              </p>
            </div>
          ) : (
            <DraftManifest
              draft={selected}
              ask={ask}
              busy={busyId === selected.id}
              onPreview={() =>
                void act(selected, 'preview', () => window.electron.previewPluginDraft(selected.id), 'Preview opened')
              }
              onReadCode={() => void readCode(selected)}
              onRun={() =>
                void act(selected, 'run', () => window.electron.activatePluginDraft(selected.id), `${selected.name} is running`)
              }
              onStop={() =>
                void act(selected, 'stop', () => window.electron.deactivatePluginDraft(selected.id), `${selected.name} stopped`)
              }
              onKeep={() =>
                void act(selected, 'keep', () => window.electron.promotePluginDraft(selected.id), `${selected.name} is now installed`)
              }
              onDiscard={() => setDiscardTarget(selected)}
            />
          )}
        </div>
      </aside>

      {reading && (
        <DraftCodeDialog
          open={true}
          onOpenChange={(open) => { if (!open) setReading(null); }}
          name={reading.name}
          files={reading.files}
          previous={reading.previous}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          open={true}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          title={`Delete ${deleteTarget.name}?`}
          message={
            `This deletes the conversation and everything said in it. Anything the agent built ` +
            `stays on the bench until you discard it separately.`
          }
          confirmLabel="Delete"
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void deleteSession(target.id);
          }}
        />
      )}

      {discardTarget && (
        <ConfirmDialog
          open={true}
          onOpenChange={(open) => { if (!open) setDiscardTarget(null); }}
          title={`Discard ${discardTarget.name}?`}
          message={
            `This stops ${discardTarget.name} and deletes it. It was never installed, so nothing else ` +
            `changes — but the agent's work on it is gone and it would have to be written again.`
          }
          confirmLabel="Discard"
          onConfirm={() => {
            const target = discardTarget;
            setDiscardTarget(null);
            void act(target, 'discard', () => window.electron.discardPluginDraft(target.id), `${target.name} discarded`);
          }}
        />
      )}
    </div>
  );
}
