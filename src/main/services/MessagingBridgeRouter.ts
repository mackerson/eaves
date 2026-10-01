/**
 * Messaging Bridge Router
 *
 * Routes outbound agent replies in bridge-owned chats to the plugin that
 * bridges them. A comms-bridge plugin (email, IRC, Telegram, …) creates its
 * chats with `bridge: true` — which stamps the chat's `bridge_plugin_id` with
 * the plugin's own identity — and registers a `messaging-provider` service.
 * When an agent's reply lands in such a chat, this router hands it to the
 * provider's `send`.
 *
 * ADR-001 compliance: this is a storage-side *consumer* of `message:created`.
 * It never starts an agent turn — the turn already happened; this only
 * forwards its finalized result outward. Delivery is fire-and-forget with
 * logging: a provider failure must never break the chat itself.
 */

import { eventBus } from './EventBus';
import { getChannelRepository } from '../repositories';
import { getServiceBridge } from './sandbox/ServiceBridge';
import { MESSAGING_PROVIDER_SERVICE_TYPE, MessagingSendParams } from '../../shared/types';
import { logger } from './logger';

interface MessageCreatedData {
  id?: string;
  chatId?: string;
  senderType?: string;
  senderDisplayName?: string;
  content?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
  context?: string;
  isDraft?: boolean;
}

export class MessagingBridgeRouter {
  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.onEvent('message:created', (event) => {
      void this.handleMessageCreated(event.data as MessageCreatedData | undefined);
    });
    logger.info('[MessagingBridgeRouter] Started');
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async handleMessageCreated(data: MessageCreatedData | undefined): Promise<void> {
    try {
      // Only finalized agent replies in 1:1 chats route outward. Greetings and
      // host-written error notices carry metadata markers and are the host or
      // a template speaking, not the agent replying to the bridged party.
      if (!data || data.context !== 'chat' || data.isDraft) return;
      if (data.senderType !== 'agent') return;
      if (!data.chatId || !data.id || typeof data.content !== 'string') return;
      if (data.metadata?.system === true || data.metadata?.greeting === true) return;

      const chat = getChannelRepository().getDirectChatById(data.chatId, { includeMessages: false });
      const bridgePluginId = chat?.bridgePluginId;
      if (!bridgePluginId) return;

      const serviceBridge = getServiceBridge();
      const methods = serviceBridge.getServiceMethods(MESSAGING_PROVIDER_SERVICE_TYPE, bridgePluginId);
      if (!methods || !methods.includes('send')) {
        // The owning plugin is not running or never registered the contract.
        // The reply stays local; say so once per occurrence, at warn.
        logger.warn(
          `[MessagingBridgeRouter] Chat ${data.chatId} is owned by ${bridgePluginId} ` +
          `but no messaging-provider 'send' is registered — reply not delivered outward`
        );
        return;
      }

      const params: MessagingSendParams = {
        chatId: data.chatId,
        messageId: data.id,
        content: data.content,
        timestamp: data.timestamp ?? Date.now(),
        senderDisplayName: data.senderDisplayName,
      };

      await serviceBridge.callServiceMethod(
        MESSAGING_PROVIDER_SERVICE_TYPE,
        bridgePluginId,
        'send',
        [params]
      );
    } catch (error) {
      logger.error(
        '[MessagingBridgeRouter] Outbound delivery failed',
        { chatId: data?.chatId, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: MessagingBridgeRouter | null = null;

export function getMessagingBridgeRouter(): MessagingBridgeRouter {
  if (!instance) {
    instance = new MessagingBridgeRouter();
  }
  return instance;
}

export function resetMessagingBridgeRouter(): void {
  instance?.stop();
  instance = null;
}
