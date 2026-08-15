import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramAdapter } from './TelegramAdapter';
import type { BridgeConfig } from '../MessagingBridge';

const { mockLogger, botState } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  botState: {
    getMe: vi.fn(),
    stopPolling: vi.fn().mockResolvedValue(undefined),
    handlers: new Map<string, (arg: unknown) => void>(),
  },
}));

vi.mock('../../logger', () => ({ logger: mockLogger }));

vi.mock('node-telegram-bot-api', () => ({
  default: class {
    getMe = botState.getMe;
    stopPolling = botState.stopPolling;
    on(event: string, handler: (arg: unknown) => void) {
      botState.handlers.set(event, handler);
    }
  },
}));

const config: BridgeConfig = {
  token: '123456789:AAFfakefakefakefakefakefakefake12345',
  allowedUserIds: ['1396418483'],
  autoStart: false,
};

const telegramError = (statusCode: number) => ({
  code: 'ETELEGRAM',
  message: `ETELEGRAM: ${statusCode} Not Found`,
  response: { statusCode },
});

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    botState.handlers.clear();
    botState.stopPolling.mockResolvedValue(undefined);
    adapter = new TelegramAdapter();
  });

  describe('start', () => {
    it('reports running after a successful handshake', async () => {
      botState.getMe.mockResolvedValue({ username: 'eaves_bot' });

      await adapter.start(config);

      expect(adapter.isRunning()).toBe(true);
      expect(adapter.getBotUsername()).toBe('eaves_bot');
    });

    // Regression: a swallowed getMe failure left the bridge reporting itself as
    // running, so the UI showed a green "Connected" bot that received nothing.
    it('rejects and stays not-running when the token is rejected', async () => {
      botState.getMe.mockRejectedValue(telegramError(404));

      await expect(adapter.start(config)).rejects.toThrow(/malformed \(HTTP 404\)/);

      expect(adapter.isRunning()).toBe(false);
      expect(botState.stopPolling).toHaveBeenCalled();
    });

    it('distinguishes a revoked token from a malformed one', async () => {
      botState.getMe.mockRejectedValue(telegramError(401));

      await expect(adapter.start(config)).rejects.toThrow(/revoked/);
      expect(adapter.isRunning()).toBe(false);
    });
  });

  describe('polling errors', () => {
    const emitPollingError = (statusCode: number) =>
      botState.handlers.get('polling_error')?.(telegramError(statusCode));

    beforeEach(async () => {
      botState.getMe.mockResolvedValue({ username: 'eaves_bot' });
      await adapter.start(config);
    });

    it('stops after repeated auth failures instead of polling forever', async () => {
      for (let i = 0; i < 5; i++) emitPollingError(404);
      await vi.waitFor(() => expect(adapter.isRunning()).toBe(false));
    });

    it('reports an unrequested shutdown so the service can surface it', async () => {
      const onError = vi.fn();
      adapter.setErrorHandler(onError);

      for (let i = 0; i < 5; i++) emitPollingError(401);

      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onError.mock.calls[0][0]).toMatch(/Connection lost.*revoked/);
    });

    it('keeps running through transient errors', () => {
      for (let i = 0; i < 20; i++) emitPollingError(502);
      expect(adapter.isRunning()).toBe(true);
    });

    it('does not count 409 conflicts as auth failures', () => {
      for (let i = 0; i < 10; i++) emitPollingError(409);
      expect(adapter.isRunning()).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('reports the bot identity without starting a polling loop', async () => {
      botState.getMe.mockResolvedValue({ username: 'eaves_bot' });

      await expect(adapter.testConnection(config)).resolves.toEqual({
        ok: true,
        botUsername: 'eaves_bot',
      });
      expect(adapter.isRunning()).toBe(false);
    });

    it('rejects a malformed token without calling the API', async () => {
      const result = await adapter.testConnection({ ...config, token: `${config.token} ` });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/whitespace/);
      expect(botState.getMe).not.toHaveBeenCalled();
    });

    it('explains an API rejection', async () => {
      botState.getMe.mockRejectedValue(telegramError(404));

      const result = await adapter.testConnection(config);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/malformed \(HTTP 404\)/);
    });
  });

  describe('validateToken', () => {
    it('accepts a well-formed token', () => {
      expect(adapter.validateToken(config.token)).toBeNull();
    });

    it.each([
      ['trailing space', `${config.token} `],
      ['leading space', ` ${config.token}`],
      ['trailing newline', `${config.token}\n`],
    ])('rejects a token with %s', (_label, token) => {
      expect(adapter.validateToken(token)).toMatch(/whitespace/);
    });

    it.each([
      ['empty', ''],
      ['no colon', '123456789AAFfakefakefakefakefake'],
      ['secret too short', '123456789:AAFfake'],
      ['no bot id', ':AAFfakefakefakefakefakefakefake12345'],
    ])('rejects a %s token', (_label, token) => {
      expect(adapter.validateToken(token)).toBeTruthy();
    });
  });
});
