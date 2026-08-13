/**
 * TelegramAdapter — MessagingBridge implementation for Telegram Bot API.
 *
 * Uses node-telegram-bot-api in polling mode (no webhook, no exposed ports).
 * Thin adapter: all REPL logic lives in MessagingBridgeService.
 *
 * node-telegram-bot-api is dynamically imported inside start() so a broken or
 * missing transitive dep can't crash app startup for users who don't use
 * Telegram. See commit history for the Windows packaging incident that
 * prompted this.
 */

import type TelegramBot from 'node-telegram-bot-api';
import {
  MessagingBridge,
  BridgeConfig,
  BridgeConnectionTest,
  IncomingMessage,
  SendOptions,
} from '../MessagingBridge';
import { logger } from '../../logger';

/** `<bot-id>:<secret>` as issued by @BotFather. Deliberately loose on the
 *  secret's length — the point is to catch whitespace and partial pastes. */
const TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{20,}$/;

/** Consecutive 401/404 polls before we stop. Neither status is transient. */
const MAX_AUTH_FAILURES = 5;

/**
 * Telegram distinguishes the two failure modes by status: a well-formed but
 * rejected token gets 401, while a malformed one never matches the /bot<token>/
 * route at all and gets 404. Saying which is which saves a debugging session.
 */
function describeAuthError(error: any): string {
  const status = error?.response?.statusCode;
  if (status === 404) {
    return 'the token is malformed (HTTP 404). Check for stray whitespace or an incomplete paste.';
  }
  if (status === 401) {
    return 'the token was rejected (HTTP 401). It may have been revoked — reissue it with @BotFather.';
  }
  return error?.message || String(error);
}

export class TelegramAdapter implements MessagingBridge {
  readonly platform = 'telegram';
  readonly maxMessageLength = 4096;

  private bot: TelegramBot | null = null;
  private running = false;
  private onMessage: ((msg: IncomingMessage) => void) | null = null;
  private botUsername: string | null = null;
  private authFailures = 0;
  private onError: ((message: string) => void) | null = null;

  setErrorHandler(handler: (message: string) => void): void {
    this.onError = handler;
  }

  /** Loads the client and resolves the constructor across the CJS interop. */
  private async loadBotCtor(): Promise<typeof TelegramBot> {
    // Dynamic import keeps the Telegram dep tree out of the startup path.
    // CJS default-export interop: prefer .default, fall back to the module.
    const mod = await import('node-telegram-bot-api');
    return ((mod as unknown as { default?: typeof TelegramBot }).default
      ?? (mod as unknown as typeof TelegramBot));
  }

  /** Verifies credentials without opening a polling loop. */
  async testConnection(config: BridgeConfig): Promise<BridgeConnectionTest> {
    const shapeError = this.validateToken(config.token);
    if (shapeError) return { ok: false, error: shapeError };

    const TelegramBotCtor = await this.loadBotCtor();
    const probe = new TelegramBotCtor(config.token, { polling: false });
    try {
      const me = await probe.getMe();
      return { ok: true, botUsername: me.username || undefined };
    } catch (error) {
      return { ok: false, error: describeAuthError(error) };
    }
  }

  validateToken(token: string): string | null {
    if (!token) return 'Bot token is required.';
    if (token !== token.trim()) {
      return 'Bot token has leading or trailing whitespace — re-copy it without the extra characters.';
    }
    if (!TOKEN_SHAPE.test(token)) {
      return 'That does not look like a Telegram bot token. Expected <bot-id>:<secret> from @BotFather.';
    }
    return null;
  }

  /**
   * Set the message handler. Called by MessagingBridgeService during setup.
   */
  setMessageHandler(handler: (msg: IncomingMessage) => void): void {
    this.onMessage = handler;
  }

  async start(config: BridgeConfig): Promise<void> {
    if (this.running) {
      await this.stop();
    }

    const TelegramBotCtor = await this.loadBotCtor();

    this.bot = new TelegramBotCtor(config.token, { polling: true });
    this.authFailures = 0;

    // getMe is the connection test. If it fails the bot will never receive
    // anything, so tear down and reject rather than leave a bridge that
    // reports itself as running while silently delivering nothing.
    try {
      const me = await this.bot.getMe();
      this.botUsername = me.username || null;
      logger.info(`[TelegramAdapter] Connected as @${this.botUsername}`);
    } catch (error) {
      logger.error('[TelegramAdapter] Failed to get bot info:', error);
      await this.stop();
      throw new Error(`Telegram authentication failed — ${describeAuthError(error)}`);
    }

    // Register message handler
    this.bot.on('message', (msg) => {
      this.authFailures = 0;
      if (!msg.text || !this.onMessage) return;

      this.onMessage({
        platform: 'telegram',
        externalChatId: String(msg.chat.id),
        externalUserId: String(msg.from?.id || msg.chat.id),
        text: msg.text,
        timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
      });
    });

    // Handle polling errors gracefully
    this.bot.on('polling_error', (error: any) => {
      const status = error?.response?.statusCode;

      // Don't log ETELEGRAM 409 (conflict) — happens when restarting
      if (error?.code === 'ETELEGRAM' && status === 409) return;

      // 401/404 mean the token is bad, not that the network blipped. Retrying
      // at the poll interval just burns requests and floods the log, so give
      // up and let the bridge report itself as stopped.
      if (status === 401 || status === 404) {
        this.authFailures++;
        if (this.authFailures >= MAX_AUTH_FAILURES) {
          const reason = describeAuthError(error);
          logger.error(
            `[TelegramAdapter] Stopping after ${this.authFailures} consecutive auth failures — ${reason}`
          );
          // Report before stopping: stop() resets state, and nothing else knows
          // this shutdown wasn't requested.
          this.onError?.(`Connection lost — ${reason}`);
          void this.stop();
          return;
        }
      } else {
        this.authFailures = 0;
      }

      logger.warn('[TelegramAdapter] Polling error:', error?.message || error);
    });

    this.running = true;
  }

  async stop(): Promise<void> {
    if (this.bot) {
      try {
        await this.bot.stopPolling();
      } catch {
        // Ignore stop errors
      }
      this.bot = null;
    }
    this.running = false;
    this.botUsername = null;
    this.authFailures = 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  getBotUsername(): string | null {
    return this.botUsername;
  }

  async sendMessage(externalChatId: string, text: string, options?: SendOptions): Promise<string> {
    if (!this.bot) throw new Error('Telegram bot not started');

    const telegramOpts: TelegramBot.SendMessageOptions = {};
    if (options?.parseMode === 'markdown') {
      telegramOpts.parse_mode = 'Markdown';
    } else if (options?.parseMode === 'html') {
      telegramOpts.parse_mode = 'HTML';
    }
    if (options?.replyToMessageId) {
      telegramOpts.reply_to_message_id = parseInt(options.replyToMessageId, 10);
    }

    const sent = await this.bot.sendMessage(parseInt(externalChatId, 10), text, telegramOpts);
    return String(sent.message_id);
  }

  async editMessage(externalChatId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');

    try {
      await this.bot.editMessageText(text, {
        chat_id: parseInt(externalChatId, 10),
        message_id: parseInt(messageId, 10),
      });
    } catch (error: any) {
      // "message is not modified" is not a real error — content hasn't changed
      if (error?.response?.body?.description?.includes('message is not modified')) return;
      throw error;
    }
  }

  async deleteMessage(externalChatId: string, messageId: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');
    await this.bot.deleteMessage(parseInt(externalChatId, 10), parseInt(messageId, 10));
  }

  async sendTypingIndicator(externalChatId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendChatAction(parseInt(externalChatId, 10), 'typing');
    } catch {
      // Non-critical
    }
  }
}
