import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useOobeStreamStore, runOobeGenerate } from './useOobeStreamStore';

const params = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-test',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('runOobeGenerate', () => {
  beforeEach(() => {
    useOobeStreamStore.getState().reset();
    (window.electron as any).oobeGenerate = vi.fn();
  });

  it('marks the store streaming while the call is in flight', async () => {
    let observed = false;
    (window.electron.oobeGenerate as any).mockImplementation(async () => {
      observed = useOobeStreamStore.getState().streaming;
      return { success: true, content: 'ok' };
    });

    await runOobeGenerate(params);

    expect(observed).toBe(true);
    // No `done` event arrives in this test, so streaming stays set — that's the
    // real contract: only the event ends a successful stream.
    expect(useOobeStreamStore.getState().streaming).toBe(true);
  });

  // A failure envelope is what a rejected invoke looks like — the promise
  // resolves, so nothing throws and no stream event is ever emitted.
  it('clears streaming and shows the error when the call returns a failure envelope', async () => {
    (window.electron.oobeGenerate as any).mockResolvedValue({
      success: false,
      error: 'API key or endpoint is required',
    });

    await runOobeGenerate(params);

    const state = useOobeStreamStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.error).toBe('API key or endpoint is required');
  });

  it('clears streaming when the invoke itself rejects', async () => {
    (window.electron.oobeGenerate as any).mockRejectedValue(new Error('bridge gone'));

    await runOobeGenerate(params);

    expect(useOobeStreamStore.getState().streaming).toBe(false);
    expect(useOobeStreamStore.getState().error).toBe('bridge gone');
  });

  // The handler emits its own `error` event before returning the envelope, and
  // that message is the specific one (friendlyAIErrorMessage). Don't replace it.
  it('leaves an error already delivered by the stream event intact', async () => {
    (window.electron.oobeGenerate as any).mockImplementation(async () => {
      useOobeStreamStore.setState({ streaming: false, error: 'Your Anthropic key was rejected' });
      return { success: false, error: 'Your Anthropic key was rejected' };
    });

    await runOobeGenerate(params);

    expect(useOobeStreamStore.getState().error).toBe('Your Anthropic key was rejected');
  });
});
