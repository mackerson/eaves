import { useEffect } from 'react';
import { useToastStore, useConversationsStore } from '@/stores';
import type { ContentBlock, ToolCall } from '@/types';

/**
 * The single app-lifetime consumer of the main-process 'chat-stream' IPC.
 * Every event carries a { turnId, agentId, containerId, context } envelope
 * stamped by AgentTurnService; this hook routes by it into the one
 * conversations store:
 *
 *   - context 'channel' → per-turn accumulators keyed by turnId, rendered
 *     into the store's draft-preview row (the draft the server announced via
 *     'channel-message-added'). Keying by turnId is what keeps concurrent
 *     turns (a selected turn + a dispatcher turn from a mention in the same
 *     send) from interleaving: each accumulates separately, and only the turn
 *     that owns a draft row renders a preview.
 *   - context 'chat' (or untagged, which is tolerated so an unstamped emitter
 *     degrades to the chat surface rather than dropping) → the chat-surface
 *     lifecycle: `isLoading`, `streamingContent`, `streamingContentBlocks`,
 *     `activeToolCalls` through start → text/tool-call/error → end, plus the
 *     stream:end chat reload and first-exchange auto-titling.
 *
 * Both contexts accumulate through one TurnAccumulator (blocks, trailing
 * text buffer, tool calls). The commit policy deliberately diverges, because
 * it is product behavior rather than plumbing: the chat surface shows a
 * running tool call the moment it starts (block committed at tool-call-start,
 * patched on result), while the channel draft preview commits a tool-call
 * block only when its result/error arrives, and additionally renders approval
 * blocks mid-stream. Converging them is a UX decision, not a cleanup.
 *
 * The 'stream:start' / 'stream:end' sentinels bracket the chat surface's busy
 * state. They arrive envelope-stamped like everything else and are attributed
 * the same way — a turn in another chat (a messaging bridge) or in a channel
 * (an approval resume) must not flip this window's composer. Bare-string
 * sentinels from an unstamped emitter stay tolerated and fall back to the
 * visible chat.
 *
 * Mount exactly once, at the app root — both surfaces depend on it.
 */

interface StreamEnvelope {
  turnId: string;
  agentId: string;
  containerId: string;
  context: 'chat' | 'channel';
}

type StreamEvent = string | (Partial<StreamEnvelope> & {
  type: string;
  content?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string | { message?: string };
  // Tool-approval-request fields (HITL)
  approvalId?: string;
  toolCallId?: string;
  input?: unknown;
});

/** ToolCall (the contentBlock shape) plus the id the stores key on. */
type PreviewToolCall = ToolCall & { id: string };

/**
 * Per-turn accumulation shared by both contexts. All mutations are
 * copy-on-write so array references double as change signals for zustand
 * selectors on the chat surface.
 */
interface TurnAccumulator {
  /** Committed blocks (flushed text, tool calls, approvals). */
  blocks: ContentBlock[];
  /** Trailing text since the last flush. */
  textBuffer: string;
  /** All text this turn — drives the channel view's autoscroll. */
  fullContent: string;
  toolCalls: PreviewToolCall[];
}

/**
 * Channel turns additionally track their server-announced draft row.
 * `draftId` is resolved once on the turn's first event: the server announces
 * the selected-agent draft via 'channel-message-added' *before* any stream
 * event (IPC pushes are FIFO), so a turn with no matching draft row at that
 * point is a broadcast turn — tombstoned (draftId null) and skipped, which is
 * exactly the no-interleave guarantee.
 */
interface ChannelTurn extends TurnAccumulator {
  channelId: string;
  agentId: string;
  draftId: string | null;
  /** Draft finalized or removed — ignore any straggler events. */
  done: boolean;
}

/** Bound the accumulator map: turns are short-lived and have no terminal
 *  chat-stream event (finalize arrives via 'message-updated'), so evict
 *  oldest-first past a small cap instead of tracking completion. */
const MAX_TRACKED_TURNS = 16;

function newAccumulator(): TurnAccumulator {
  return { blocks: [], textBuffer: '', fullContent: '', toolCalls: [] };
}

function appendText(turn: TurnAccumulator, content: string): void {
  turn.textBuffer += content;
  turn.fullContent += content;
}

/** Commit the trailing text buffer as a text block, if any. */
function flushTextBuffer(turn: TurnAccumulator): void {
  if (!turn.textBuffer) return;
  turn.blocks = [...turn.blocks, { type: 'text', content: turn.textBuffer, timestamp: Date.now() }];
  turn.textBuffer = '';
}

/** Patch the running tool call matching `toolName`; returns the updated call
 *  (or null when nothing matched, e.g. a stale/duplicated result event). */
function patchRunningToolCall(
  turn: TurnAccumulator,
  toolName: string | undefined,
  patch: Partial<PreviewToolCall>,
): PreviewToolCall | null {
  const match = turn.toolCalls.find((tc) => tc.toolName === toolName && tc.status === 'running');
  if (!match) return null;
  const updated = { ...match, ...patch };
  turn.toolCalls = turn.toolCalls.map((tc) => (tc === match ? updated : tc));
  return updated;
}

function resolveDraftId(channelId: string, agentId: string): string | null {
  const { channels } = useConversationsStore.getState();
  const channel = channels.find((c) => c.id === channelId);
  const draft = channel?.messages.find((m) => m.isDraft && m.senderId === agentId);
  return draft?.id ?? null;
}

/** Patch the turn's draft row with the accumulated preview (display-only —
 *  persistence is owned by the main process). */
function renderChannelPreview(turn: ChannelTurn): void {
  if (!turn.draftId || turn.done) return;
  const state = useConversationsStore.getState();
  const channel = state.channels.find((c) => c.id === turn.channelId);
  const row = channel?.messages.find((m) => m.id === turn.draftId);
  if (!row) return; // removed (stop / empty-turn cleanup) — nothing to render
  if (!row.isDraft) {
    // Finalized server-side; the persisted content won — stop previewing.
    turn.done = true;
    return;
  }
  const blocks = turn.textBuffer
    ? [...turn.blocks, { type: 'text' as const, content: turn.textBuffer, timestamp: Date.now() }]
    : [...turn.blocks];
  state.setChannels(state.channels.map((c) => {
    if (c.id !== turn.channelId) return c;
    return {
      ...c,
      messages: c.messages.map((m) =>
        m.id === turn.draftId ? { ...m, contentBlocks: blocks, content: turn.fullContent } : m,
      ),
    };
  }));
  // Drives the channel view's autoscroll while the draft row grows.
  if (state.currentChannelId === turn.channelId) {
    state.setChannelStreamingContent(turn.fullContent);
  }
}

/** Write the chat turn's accumulated state into the store's chat-surface
 *  streaming fields. Unchanged array references are no-ops for selectors. */
function renderChatPreview(turn: TurnAccumulator): void {
  useConversationsStore.setState({
    streamingContent: turn.textBuffer,
    streamingContentBlocks: turn.blocks,
    activeToolCalls: turn.toolCalls,
  });
}

export function useChatStream(): void {
  useEffect(() => {
    // ── Chat-context state (kept out of the store to avoid a render per
    // chunk; the sentinels guarantee a single active chat turn) ──
    let chatTurn = newAccumulator();

    /**
     * The chat whose turn owns the chat surface's busy state, or null when
     * nothing this window started is running. Matching `stream:end` against
     * this rather than against the *current* selection is what lets the user
     * navigate away mid-turn and still have the composer released.
     */
    let loadingContainerId: string | null = null;

    const startChatTurn = (containerId: string | undefined): void => {
      // Unstamped emitters can only be this window's — historical behavior.
      const owner = containerId ?? useConversationsStore.getState().currentChatId;
      // A turn in a chat we're not looking at (a bridge-driven one) has no
      // business marking this composer busy.
      if (!owner || owner !== useConversationsStore.getState().currentChatId) return;

      loadingContainerId = owner;
      chatTurn = newAccumulator();
      useConversationsStore.setState({
        isLoading: true,
        streamingContent: '',
        streamingContentBlocks: [],
        activeToolCalls: [],
      });
    };

    const endChatTurn = (containerId: string | undefined): void => {
      const owner = containerId ?? loadingContainerId ?? useConversationsStore.getState().currentChatId;
      if (!owner || owner !== loadingContainerId) return;

      loadingContainerId = null;
      chatTurn = newAccumulator();
      // Clear regeneratingMessageId together with stream state. By the
      // time the chat reload below resolves, the original message is
      // archived and gone from chat.messages anyway, so dropping the
      // hide-flag in lockstep avoids any flicker.
      useConversationsStore.setState({
        isLoading: false,
        streamingContent: '',
        streamingContentBlocks: [],
        activeToolCalls: [],
        regeneratingMessageId: null,
      });

      // Reload the chat that just finished — not whatever is selected now —
      // so the persisted message replaces the streaming preview, then
      // auto-title if this is the first turn.
      window.electron.getChat(owner).then(async (result) => {
        if (!result.success || !result.chat) return;
        const reloaded = result.chat;
        useConversationsStore.setState((state) => ({
          chats: state.chats.map((c) => (c.id === owner ? reloaded : c)),
        }));

        // First exchange (user + assistant) on a default-named chat
        // → ask the model for a title + tags.
        if (reloaded.messages.length === 2 && reloaded.name === 'New Chat') {
          try {
            const gen = await window.electron.generateChatMetadata({
              chatId: reloaded.id,
              messages: reloaded.messages,
            });
            if (gen.success && (gen.title || gen.tags)) {
              await useConversationsStore.getState().updateChat(reloaded.id, {
                name: gen.title || reloaded.name,
                tags: gen.tags,
              }, { silent: true });
            }
          } catch {
            // Auto-titling is best-effort; never surface as an error.
          }
        }
      });
    };

    // ── Channel-context state ──
    const channelTurns = new Map<string, ChannelTurn>();

    const handleChannelEvent = (event: Exclude<StreamEvent, string> & StreamEnvelope): void => {
      // No channel UI for compaction; the draft's typing indicator covers it.
      if (event.type === 'compaction-start' || event.type === 'compaction-end') return;

      let turn = channelTurns.get(event.turnId);
      if (!turn) {
        if (channelTurns.size >= MAX_TRACKED_TURNS) {
          const oldest = channelTurns.keys().next().value;
          if (oldest !== undefined) channelTurns.delete(oldest);
        }
        turn = {
          ...newAccumulator(),
          channelId: event.containerId,
          agentId: event.agentId,
          draftId: resolveDraftId(event.containerId, event.agentId),
          done: false,
        };
        channelTurns.set(event.turnId, turn);
      }

      if (event.type === 'error') {
        // Surface immediately; the server persists the same system block at
        // finalize, this only previews it.
        const message = typeof event.error === 'string'
          ? event.error
          : event.error?.message || 'Unknown error occurred';
        window.electron.logError({ message: 'Stream error', error: event.error });
        useToastStore.getState().showToast(message, 'error');
        if (turn.draftId && !turn.done) {
          flushTextBuffer(turn);
          turn.blocks = [...turn.blocks, { type: 'system', content: `Error: ${message}`, timestamp: Date.now() }];
          renderChannelPreview(turn);
        }
        return;
      }

      // Broadcast turn (no draft row) — nothing to preview, nothing to keep.
      if (!turn.draftId || turn.done) return;

      if (event.type === 'text' || event.type === 'content') {
        appendText(turn, event.content ?? '');
        renderChannelPreview(turn);
      } else if (event.type === 'tool-call-start') {
        flushTextBuffer(turn);
        if (turn.fullContent && !turn.fullContent.endsWith('\n\n')) {
          turn.fullContent += '\n\n';
        }
        turn.toolCalls = [...turn.toolCalls, {
          id: `${event.toolName}-${Date.now()}`,
          toolName: event.toolName!,
          args: event.args,
          status: 'running',
        }];
      } else if (event.type === 'tool-call-result') {
        // Commit policy: the draft preview shows a tool call only once its
        // result lands (see file-top note on the chat/channel divergence).
        const updated = patchRunningToolCall(turn, event.toolName, { result: event.result, status: 'completed' });
        if (updated) {
          turn.blocks = [...turn.blocks, { type: 'tool-call', toolCall: updated, timestamp: Date.now() }];
          renderChannelPreview(turn);
        }
      } else if (event.type === 'tool-call-error') {
        const errorText = typeof event.error === 'string' ? event.error : event.error?.message;
        const updated = patchRunningToolCall(turn, event.toolName, { error: errorText, status: 'error' });
        if (updated) {
          turn.blocks = [...turn.blocks, { type: 'tool-call', toolCall: updated, timestamp: Date.now() }];
          renderChannelPreview(turn);
        }
      } else if (event.type === 'tool-approval-request') {
        // Render the approval prompt optimistically — the block is finalized
        // server-side; the inline ApprovalCard needs it the moment it streams.
        flushTextBuffer(turn);
        turn.blocks = [...turn.blocks, {
          type: 'tool-approval',
          approval: {
            approvalId: event.approvalId!,
            toolCallId: event.toolCallId!,
            toolName: event.toolName!,
            input: event.input,
            status: 'pending',
          },
          timestamp: Date.now(),
        }];
        renderChannelPreview(turn);
      } else if (event.type === 'tool-output-denied') {
        // Drop the in-flight placeholder; the approval block is the record.
        turn.toolCalls = turn.toolCalls.filter(
          (tc) => !(tc.toolName === event.toolName && tc.status === 'running'),
        );
      }
    };

    const cleanup = window.electron.onChatStream((rawEvent) => {
      const event = rawEvent as StreamEvent;
      if (typeof event === 'string') {
        if (event === 'stream:start') startChatTurn(undefined);
        else if (event === 'stream:end') endChatTurn(undefined);
        return;
      }

      if (event.type === 'stream:start' || event.type === 'stream:end') {
        // A channel turn brackets its draft row's typing indicator, not this.
        if (event.context === 'channel') return;
        if (event.type === 'stream:start') startChatTurn(event.containerId);
        else endChatTurn(event.containerId);
        return;
      }

      // Envelope routing: channel turns render into the store's draft
      // preview; chat turns (and untagged events, tolerated) keep the
      // historical chat-surface behavior below.
      if (event.context === 'channel') {
        handleChannelEvent(event as Exclude<StreamEvent, string> & StreamEnvelope);
        return;
      }

      // Chat turns are not always started by this window. A messaging bridge
      // (Telegram) drives real turns in real chats, and those events arrive
      // here too — without a container check their text accumulates into
      // whatever chat happens to be open, then disappears on the completion
      // reload. Drop anything addressed to a different chat. Untagged events
      // stay tolerated: pre-envelope emitters can only be this window's.
      const { currentChatId } = useConversationsStore.getState();
      if (event.containerId && event.containerId !== currentChatId) return;

      if (event.type === 'compaction-start') {
        useConversationsStore.setState({ isCompacting: true });
        return;
      }
      if (event.type === 'compaction-end') {
        useConversationsStore.setState({ isCompacting: false });
        return;
      }

      if (event.type === 'content' || event.type === 'text') {
        appendText(chatTurn, event.content ?? '');
        renderChatPreview(chatTurn);
      } else if (event.type === 'tool-call-start') {
        // Commit policy: the chat preview shows the tool call as soon as it
        // starts (running), then patches it in place on result/error.
        flushTextBuffer(chatTurn);
        const toolCall: PreviewToolCall = {
          id: `${event.toolName}-${Date.now()}`,
          toolName: event.toolName!,
          args: event.args,
          status: 'running',
        };
        chatTurn.toolCalls = [...chatTurn.toolCalls, toolCall];
        chatTurn.blocks = [...chatTurn.blocks, { type: 'tool-call', toolCall, timestamp: Date.now() }];
        renderChatPreview(chatTurn);
      } else if (event.type === 'tool-call-result') {
        const updated = patchRunningToolCall(chatTurn, event.toolName, { result: event.result, status: 'completed' });
        if (updated) {
          chatTurn.blocks = chatTurn.blocks.map((block) =>
            block.type === 'tool-call' && block.toolCall.toolName === event.toolName && block.toolCall.status === 'running'
              ? { ...block, toolCall: updated }
              : block,
          );
          renderChatPreview(chatTurn);
        }
      } else if (event.type === 'tool-call-error') {
        const updated = patchRunningToolCall(chatTurn, event.toolName, { error: event.error as any, status: 'error' });
        if (updated) {
          chatTurn.blocks = chatTurn.blocks.map((block) =>
            block.type === 'tool-call' && block.toolCall.toolName === event.toolName && block.toolCall.status === 'running'
              ? { ...block, toolCall: updated }
              : block,
          );
          renderChatPreview(chatTurn);
        }
      } else if (event.type === 'error') {
        const errorMsg = (event.error as any)?.message || String(event.error) || 'An error occurred';
        useToastStore.getState().showToast(errorMsg, 'error');
      }
    });

    return cleanup;
  }, []); // Listener is stable for the app lifetime; no deps.
}
