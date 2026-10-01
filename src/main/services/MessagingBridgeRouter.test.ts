/**
 * Tests for the outbound half of the messaging-provider contract: an agent
 * reply in a bridge-owned chat reaches the owning plugin's `send`, and
 * nothing else does — not channel messages, not human messages, not the
 * host's own error notices, not chats nobody bridges.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { getDirectChatById, getServiceMethods, callServiceMethod } = vi.hoisted(() => ({
  getDirectChatById: vi.fn(),
  getServiceMethods: vi.fn(),
  callServiceMethod: vi.fn(),
}));

vi.mock('../repositories', () => ({
  getChannelRepository: () => ({ getDirectChatById }),
}));

vi.mock('./sandbox/ServiceBridge', () => ({
  getServiceBridge: () => ({ getServiceMethods, callServiceMethod }),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { eventBus } from './EventBus';
import { getMessagingBridgeRouter, resetMessagingBridgeRouter } from './MessagingBridgeRouter';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const agentReply = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg-1',
  chatId: 'chat-1',
  senderType: 'agent',
  senderDisplayName: 'Pam',
  content: 'On it.',
  timestamp: 1234,
  metadata: { participantType: 'agent' },
  context: 'chat',
  isDraft: false,
  ...overrides,
});

describe('MessagingBridgeRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDirectChatById.mockReturnValue({ id: 'chat-1', bridgePluginId: 'com.eaves.telegram' });
    getServiceMethods.mockReturnValue(['send', 'listThreads', 'markRead', 'capabilities']);
    callServiceMethod.mockResolvedValue({ success: true });
    getMessagingBridgeRouter().start();
  });

  afterEach(() => {
    resetMessagingBridgeRouter();
  });

  it('routes an agent reply in a bridge-owned chat to the provider send', async () => {
    eventBus.emitEvent('message:created', agentReply());
    await flush();

    expect(callServiceMethod).toHaveBeenCalledWith(
      'messaging-provider',
      'com.eaves.telegram',
      'send',
      [{
        chatId: 'chat-1',
        messageId: 'msg-1',
        content: 'On it.',
        timestamp: 1234,
        senderDisplayName: 'Pam',
      }]
    );
  });

  it('ignores chats no plugin bridges', async () => {
    getDirectChatById.mockReturnValue({ id: 'chat-1', bridgePluginId: undefined });
    eventBus.emitEvent('message:created', agentReply());
    await flush();

    expect(callServiceMethod).not.toHaveBeenCalled();
  });

  it('ignores human messages, channel messages, and drafts', async () => {
    eventBus.emitEvent('message:created', agentReply({ senderType: 'human' }));
    eventBus.emitEvent('message:created', agentReply({ context: 'channel', channelId: 'chan-1' }));
    eventBus.emitEvent('message:created', agentReply({ isDraft: true }));
    await flush();

    expect(callServiceMethod).not.toHaveBeenCalled();
  });

  it('ignores host error notices and greetings', async () => {
    eventBus.emitEvent('message:created', agentReply({
      metadata: { participantType: 'agent', system: true },
      content: '[Error: provider exploded]',
    }));
    eventBus.emitEvent('message:created', agentReply({
      metadata: { participantType: 'agent', greeting: true },
    }));
    await flush();

    expect(callServiceMethod).not.toHaveBeenCalled();
  });

  it('does not call send when the owning plugin has no messaging-provider registered', async () => {
    getServiceMethods.mockReturnValue(null);
    eventBus.emitEvent('message:created', agentReply());
    await flush();

    expect(callServiceMethod).not.toHaveBeenCalled();
  });

  it('survives a provider send that rejects', async () => {
    callServiceMethod.mockRejectedValue(new Error('gateway down'));
    eventBus.emitEvent('message:created', agentReply());
    await flush();

    // A second message still routes — the subscription did not die with the error.
    callServiceMethod.mockResolvedValue({ success: true });
    eventBus.emitEvent('message:created', agentReply({ id: 'msg-2' }));
    await flush();

    expect(callServiceMethod).toHaveBeenCalledTimes(2);
  });
});
