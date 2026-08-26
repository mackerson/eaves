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
import { AlertTriangle } from 'lucide-react';
import type { Chat, PluginDraft } from '@/../shared/types';

/**
 * The Workshop: a bench where a plugin gets built, with the human's hands on it.
 *
 * Left is the conversation — you say what you want Eaves to be able to do, and
 * an agent builds it. Right is the bench rail: what has actually been made so
 * far, what it asks for, and the controls only a person may use.
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

const ELEVATED = new Set(['network:http', 'system:filesystem']);

/** Stage is derived from what exists, never stored — state cannot disagree with itself. */
function stageOf(drafts: PluginDraft[], hasSession: boolean): 0 | 1 | 2 | 3 {
  if (drafts.some((d) => d.running)) return 2;
  if (drafts.length > 0) return 1;
  return hasSession ? 0 : 0;
}

const STAGES = ['Asked', 'Written', 'Running', 'Kept'] as const;

export function WorkshopView() {
  const enabled = useSettingsStore((s) => s.settings.pluginAuthoringEnabled) === true;
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const showToast = useToastStore((s) => s.showToast);

  const [sessions, setSessions] = useState<Chat[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PluginDraft[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<PluginDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const input = useConversationsStore((s) => s.input);
  const setInput = useConversationsStore((s) => s.setInput);
  const isLoading = useConversationsStore((s) => s.isLoading);
  const streamingContent = useConversationsStore((s) => s.streamingContent);
  const streamingContentBlocks = useConversationsStore((s) => s.streamingContentBlocks);
  const session = useConversationsStore((s) => s.chats.find((c) => c.id === s.currentChatId));

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

  const openDraft = async (draft: PluginDraft) => {
    if (openId === draft.id) { setOpenId(null); return; }
    const result = await window.electron.readPluginDraft(draft.id);
    if (!result?.success || !result.files) {
      showToast(result?.error || 'Could not read that draft', 'error');
      return;
    }
    setOpenId(draft.id);
    setFiles(result.files);
    setOpenFile(result.files[0]?.path ?? null);
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

  const stage = useMemo(() => stageOf(drafts, !!sessionId), [drafts, sessionId]);

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
            <Button variant="outline" size="sm" disabled={starting} onClick={() => void startSession()}>
              New build
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* The ask stays until there is something to read. A started-but-empty
              session with a blank pane tells a first-time user nothing. */}
          {!session || !session.messages?.length ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto">
              <p className="text-lg font-medium">What should Eaves be able to do?</p>
              <p className="text-sm text-muted-foreground mt-2">
                Describe it in your own words — "a dice roller for my roleplay chats", "a view
                that shows my notes as cards". An agent writes it, you watch it happen, and
                nothing is installed until you say so.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {session.messages?.map((msg) => (
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
                  onStartEdit={() => {}}
                  onSetEditContent={() => {}}
                  onSaveEdit={() => {}}
                  onCancelEdit={() => {}}
                  onDelete={() => {}}
                  onRetry={() => {}}
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
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-1.5">
            {STAGES.map((label, idx) => (
              <div key={label} className="flex items-center gap-1.5">
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    idx <= stage
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  {label}
                </span>
                {idx < STAGES.length - 1 && (
                  <span className="text-muted-foreground text-xs">›</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing on the bench yet. What the agent writes will show up here before it runs.
            </p>
          ) : (
            drafts.map((draft) => {
              const busy = busyId === draft.id;
              const elevated = draft.permissions.filter((p) => ELEVATED.has(p));
              return (
                <div key={draft.id} className="border border-border rounded-lg bg-card">
                  <div className="p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{draft.name}</span>
                      <span className="text-xs text-muted-foreground">v{draft.version}</span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          draft.running
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {draft.running ? 'running' : 'staged'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      <button className="underline underline-offset-2" onClick={() => void openDraft(draft)}>
                        {draft.files.length} file{draft.files.length === 1 ? '' : 's'}
                      </button>
                      {' · '}
                      {draft.permissions.length
                        ? `asks for: ${draft.permissions.join(', ')}`
                        : 'asks for no special access'}
                    </p>
                    {elevated.length > 0 && (
                      <p className="text-xs mt-2 flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        <span>Wants {elevated.join(' and ')} — read the code before you keep this.</span>
                      </p>
                    )}
                    {/* Running is not rendering, so the preview's verdict is its
                        own line. The agent reads the same fact through
                        plugin_inspect, so telling it "it's broken" is no longer
                        the only way it can find out. */}
                    {draft.lastRender?.status === 'failed' && (
                      <div className="text-xs mt-2 p-2 rounded border border-red-500/40 bg-red-500/10">
                        <p className="font-medium text-red-400">Preview failed to render</p>
                        <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground max-h-24 overflow-y-auto">
                          {draft.lastRender.message}
                        </pre>
                      </div>
                    )}
                    {draft.lastRender?.status === 'ok' && (
                      <p className="text-xs mt-2 text-emerald-600 dark:text-emerald-400">
                        Previewed and rendered cleanly.
                      </p>
                    )}
                    <div className="flex items-center flex-wrap gap-1.5 mt-3">
                      {draft.bundleUrl && (
                        <Button
                          variant="outline" size="sm" disabled={busy}
                          onClick={() =>
                            void act(draft, 'preview', () => window.electron.previewPluginDraft(draft.id), 'Preview opened')
                          }
                        >
                          Preview
                        </Button>
                      )}
                      {draft.running ? (
                        <Button
                          variant="outline" size="sm" disabled={busy}
                          onClick={() => act(draft, 'stop', () => window.electron.deactivatePluginDraft(draft.id), `${draft.name} stopped`)}
                        >
                          Stop
                        </Button>
                      ) : (
                        <Button
                          variant="outline" size="sm" disabled={busy}
                          onClick={() => act(draft, 'run', () => window.electron.activatePluginDraft(draft.id), `${draft.name} is running`)}
                        >
                          Run
                        </Button>
                      )}
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setDiscardTarget(draft)}>
                        Discard
                      </Button>
                      <Button
                        size="sm" disabled={busy}
                        onClick={() => act(draft, 'keep', () => window.electron.promotePluginDraft(draft.id), `${draft.name} is now installed`)}
                      >
                        Keep
                      </Button>
                    </div>
                  </div>

                  {openId === draft.id && (
                    <div className="border-t border-border">
                      <div className="flex gap-1 px-2 py-1.5 overflow-x-auto border-b border-border">
                        {files.map((file) => (
                          <button
                            key={file.path}
                            onClick={() => setOpenFile(file.path)}
                            className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${
                              openFile === file.path
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground hover:bg-accent/50'
                            }`}
                          >
                            {file.path}
                          </button>
                        ))}
                      </div>
                      <pre className="p-3 text-[11px] leading-relaxed overflow-x-auto max-h-64 overflow-y-auto font-mono">
                        {files.find((f) => f.path === openFile)?.content ?? ''}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>

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
            if (openId === target.id) setOpenId(null);
            void act(target, 'discard', () => window.electron.discardPluginDraft(target.id), `${target.name} discarded`);
          }}
        />
      )}
    </div>
  );
}
