import { create } from 'zustand';

interface OobeStreamState {
  streaming: boolean;
  streamingContent: string;
  displayedContent: string;
  generatingJson: boolean;
  completedContent: string | null;
  error: string | null;

  // Actions
  startStream: () => void;
  reset: () => void;
}

/**
 * Zustand store for OOBE stream state.
 * Lives outside React's lifecycle, so strict mode double-mount doesn't affect it.
 * The listener is registered once at module level and writes directly to the store.
 *
 * streamingContent is the raw accumulated text from IPC (the target).
 * displayedContent is animated toward it via requestAnimationFrame, revealing
 * ~8 chars/frame (~480 chars/sec) so text flows smoothly rather than jumping
 * word-at-a-time as tokens arrive.
 */
export const useOobeStreamStore = create<OobeStreamState>((set) => ({
  streaming: false,
  streamingContent: '',
  displayedContent: '',
  generatingJson: false,
  completedContent: null,
  error: null,

  startStream: () => set({
    streaming: true,
    streamingContent: '',
    displayedContent: '',
    generatingJson: false,
    completedContent: null,
    error: null,
  }),

  reset: () => set({
    streaming: false,
    streamingContent: '',
    displayedContent: '',
    generatingJson: false,
    completedContent: null,
    error: null,
  }),
}));

type OobeGenerateParams = Parameters<typeof window.electron.oobeGenerate>[0];

/**
 * Start a generation and mark the store streaming.
 *
 * Every call site used to fire `oobeGenerate` and discard the promise, leaving
 * the `oobe-stream` event the sole way out of `streaming: true`. The handler
 * now emits on all of its own exits, but an invoke that fails before reaching
 * it — or a `send` that throws on a closing window — still resolves with a
 * failure envelope and no event. Clearing the flag here closes that gap: the
 * wizard shows the error and its retry button instead of hanging on a disabled
 * input with no way forward but killing the app.
 */
export async function runOobeGenerate(params: OobeGenerateParams): Promise<void> {
  useOobeStreamStore.getState().startStream();
  let error: string | null = null;
  try {
    const result = await window.electron.oobeGenerate(params);
    if (result && result.success === false) {
      error = result.error || 'Generation failed';
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Generation failed';
  }
  // The handler's own `error` event usually lands first and clears `streaming`;
  // don't overwrite the specific message it sent with this generic one.
  if (error && useOobeStreamStore.getState().streaming) {
    stopAnimation();
    useOobeStreamStore.setState({
      streaming: false,
      error,
      streamingContent: '',
      displayedContent: '',
      generatingJson: false,
    });
  }
}

const CHARS_PER_FRAME = 8;
let animationFrameId: number | null = null;

function computeVisibleTarget(streamingContent: string): { text: string; hasJson: boolean } {
  const jsonIdx = streamingContent.indexOf('```json');
  if (jsonIdx >= 0) {
    return { text: streamingContent.slice(0, jsonIdx).trimEnd(), hasJson: true };
  }
  return { text: streamingContent, hasJson: false };
}

function tickAnimation() {
  const state = useOobeStreamStore.getState();
  const { text: target, hasJson } = computeVisibleTarget(state.streamingContent);
  const caughtUp = state.displayedContent.length >= target.length;

  if (caughtUp) {
    if (hasJson !== state.generatingJson) {
      useOobeStreamStore.setState({ generatingJson: hasJson });
    }
    if (!state.streaming) {
      animationFrameId = null;
      return;
    }
    animationFrameId = requestAnimationFrame(tickAnimation);
    return;
  }

  const nextLen = Math.min(state.displayedContent.length + CHARS_PER_FRAME, target.length);
  useOobeStreamStore.setState({
    displayedContent: target.slice(0, nextLen),
    generatingJson: hasJson,
  });
  animationFrameId = requestAnimationFrame(tickAnimation);
}

function startAnimation() {
  if (animationFrameId !== null) return;
  animationFrameId = requestAnimationFrame(tickAnimation);
}

function stopAnimation() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

// Module-level listener — registered once, never duplicated
let _listenerRegistered = false;

export function ensureOobeStreamListener() {
  if (_listenerRegistered) return;
  _listenerRegistered = true;

  window.electron.onOobeStream((event) => {
    const state = useOobeStreamStore.getState();
    if (!state.streaming && event.type !== 'error') return; // Ignore stale events

    if (event.type === 'text' && event.content) {
      useOobeStreamStore.setState({
        streamingContent: state.streamingContent + event.content,
      });
      startAnimation();
    }
    if (event.type === 'done') {
      stopAnimation();
      useOobeStreamStore.setState({
        streaming: false,
        completedContent: state.streamingContent,
        streamingContent: '',
        displayedContent: '',
        generatingJson: false,
      });
    }
    if (event.type === 'error') {
      stopAnimation();
      useOobeStreamStore.setState({
        streaming: false,
        error: event.error || 'Generation failed',
        streamingContent: '',
        displayedContent: '',
        generatingJson: false,
      });
    }
  });
}
