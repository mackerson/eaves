import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerOOBEHandlers } from './oobe';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false },
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/logger', () => ({ logger: mockLogger, getLogger: () => mockLogger }));
vi.mock('../repositories', () => ({ getSettingsRepository: vi.fn(() => ({ update: vi.fn() })) }));
vi.mock('ai', () => ({ streamText: vi.fn() }));
vi.mock('../utils/fetchModels', () => ({ fetchModelsForProvider: vi.fn() }));
vi.mock('../services/providers', () => ({ getProviderAdapter: vi.fn() }));

import { getProviderAdapter } from '../services/providers';

/**
 * The renderer's only exit from `streaming: true` is an `oobe-stream` event of
 * type `done` or `error` — the IPC return value drives no UI. A handler exit
 * that skips the event leaves the wizard on "Preparing your interview" with a
 * disabled input and no retry, permanently.
 */
describe('oobe-generate: every failure path emits a stream event', () => {
  let handlers: Map<string, Function>;
  let sent: Array<[string, unknown]>;

  beforeEach(() => {
    vi.clearAllMocks();
    sent = [];
    const mainWindow = {
      webContents: { send: (channel: string, payload: unknown) => { sent.push([channel, payload]); } },
    };

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });
    registerOOBEHandlers(() => mainWindow as any);
  });

  const validParams = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: 'sk-test',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  function streamErrors(): string[] {
    return sent
      .filter(([channel, payload]) => channel === 'oobe-stream' && (payload as any).type === 'error')
      .map(([, payload]) => (payload as any).error);
  }

  it('emits error when the params fail validation', async () => {
    const result = await handlers.get('oobe-generate')!({}, { provider: 'anthropic' });

    expect(result.success).toBe(false);
    expect(streamErrors()).toHaveLength(1);
  });

  it('emits error when the provider has no adapter', async () => {
    (getProviderAdapter as Mock).mockReturnValue(null);

    const result = await handlers.get('oobe-generate')!({}, validParams);

    expect(result.success).toBe(false);
    expect(streamErrors()).toEqual([expect.stringContaining('Unknown provider')]);
  });

  it('returns a failure envelope when there is no window to notify', async () => {
    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });
    registerOOBEHandlers(() => null);

    const result = await handlers.get('oobe-generate')!({}, validParams);

    // Nothing to send to — the envelope is the only signal, which is why the
    // renderer checks it (see runOobeGenerate).
    expect(result).toEqual({ success: false, error: 'No main window' });
    expect(sent).toHaveLength(0);
  });
});
