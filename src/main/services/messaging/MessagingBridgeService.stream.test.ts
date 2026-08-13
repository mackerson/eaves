/**
 * Stream-relay regressions for the messaging bridge.
 *
 * Both behaviors under test are outbound paths to a third party (the remote
 * Telegram user), so they matter more than the usual internal wiring:
 *
 *  1. A relay that matched on agentId alone piped *any* turn by that agent —
 *     a desktop chat, a channel, another remote session — into this user's
 *     window. Conversation identity is (agent, container), not agent.
 *  2. `chatWithAgent` resolves rather than throws when a turn is aborted, and
 *     an aborted turn emitted no terminal bus event, so the in-flight slot was
 *     never released. The remote user got a dangling placeholder and then
 *     "please wait for the current response to finish" forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const chatWithAgent = vi.fn();

vi.mock('../ChatService', () => ({
  ChatService: class {
    chatWithAgent = chatWithAgent;
    stopStream = vi.fn();
  },
}));

vi.mock('../../repositories', () => ({
  getChannelRepository: () => ({
    getDirectChatById: (id: string) => ({ id, name: 'Remote chat', agentId: AGENT_ID }),
    createDirectMessage: vi.fn(),
  }),
  getAgentRepository: () => ({
    getById: (id: string) => ({ id, name: 'Ninja', provider: 'anthropic', model: 'claude-sonnet-5' }),
  }),
  getUserRepository: () => ({
    getCurrent: () => ({ id: 'user-1', name: 'Miz', color: '#667eea' }),
  }),
  getSettingsRepository: () => ({ get: () => ({}), getCurrentState: () => ({}) }),
}));

vi.mock('../database', () => ({ getDatabase: () => ({ prepare: () => ({ run: vi.fn(), get: vi.fn(), all: () => [] }) }) }));
vi.mock('../encryption', () => ({ encryptString: (s: string) => s, decryptString: (s: string) => s }));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const AGENT_ID = 'agent-ninja';
const CHAT_ID = 'chat-remote';
const OTHER_CHAT_ID = 'chat-desktop';
const EXTERNAL_CHAT_ID = 'tg-4242';
const BUFFER_KEY = `telegram:${EXTERNAL_CHAT_ID}`;

import { MessagingBridgeService } from './MessagingBridgeService';
import { eventBus } from '../EventBus';

function makeBridge() {
  return {
    platform: 'telegram',
    maxMessageLength: 4096,
    sendMessage: vi.fn(async () => 'placeholder-msg-id'),
    editMessage: vi.fn(async () => undefined),
    sendTypingIndicator: vi.fn(async () => undefined),
  };
}

function makeSession() {
  return {
    platform: 'telegram',
    externalUserId: 'tg-user-1',
    currentChatId: CHAT_ID,
    currentAgentId: AGENT_ID,
    lastActiveAt: Date.now(),
  };
}

/** Drive the private relay the way an inbound platform message would. */
function relay(service: MessagingBridgeService, bridge: ReturnType<typeof makeBridge>, text = 'hello') {
  return (service as any).handleTextMessage(bridge, EXTERNAL_CHAT_ID, makeSession(), text);
}

function emitChunk(containerId: string | undefined, chunk: string) {
  eventBus.emitEvent('chat:stream', { agentId: AGENT_ID, chunk, length: chunk.length, containerId, context: 'chat' });
}

describe('MessagingBridgeService stream relay', () => {
  let service: MessagingBridgeService;
  let bridge: ReturnType<typeof makeBridge>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MessagingBridgeService(() => null);
    bridge = makeBridge();
  });

  afterEach(() => {
    eventBus.removeAllListeners?.('chat:stream');
    eventBus.removeAllListeners?.('chat:complete');
    eventBus.removeAllListeners?.('chat:aborted');
    eventBus.removeAllListeners?.('chat:error');
  });

  it('relays chunks addressed to its own chat', async () => {
    chatWithAgent.mockImplementation(async () => {
      emitChunk(CHAT_ID, 'mine');
      eventBus.emitEvent('chat:complete', { agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
      return { success: true };
    });

    await relay(service, bridge);

    const relayed = bridge.editMessage.mock.calls.map((c) => String(c[2])).join('');
    expect(relayed).toContain('mine');
  });

  it('drops chunks from another chat driven by the same agent', async () => {
    chatWithAgent.mockImplementation(async () => {
      emitChunk(OTHER_CHAT_ID, 'SECRET-FROM-DESKTOP');
      eventBus.emitEvent('chat:complete', { agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
      return { success: true };
    });

    await relay(service, bridge);

    const everySentString = [...bridge.editMessage.mock.calls, ...bridge.sendMessage.mock.calls]
      .flat()
      .map(String)
      .join(' ');
    expect(everySentString).not.toContain('SECRET-FROM-DESKTOP');
  });

  it('drops unaddressed chunks rather than guessing (fails closed)', async () => {
    chatWithAgent.mockImplementation(async () => {
      emitChunk(undefined, 'UNTAGGED-LEAK');
      eventBus.emitEvent('chat:complete', { agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
      return { success: true };
    });

    await relay(service, bridge);

    const everySentString = [...bridge.editMessage.mock.calls, ...bridge.sendMessage.mock.calls]
      .flat()
      .map(String)
      .join(' ');
    expect(everySentString).not.toContain('UNTAGGED-LEAK');
  });

  it('releases the in-flight slot when a chat:aborted lands', async () => {
    chatWithAgent.mockImplementation(async () => {
      eventBus.emitEvent('chat:aborted', { agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
      return { success: false, aborted: true };
    });

    await relay(service, bridge);

    expect((service as any).inFlightRequests.has(BUFFER_KEY)).toBe(false);
  });

  it('releases the in-flight slot when an abort resolves with no bus event at all', async () => {
    // The wedge: chatWithAgent resolving (not throwing) with aborted:true and
    // no terminal event used to leave the slot held until app restart.
    chatWithAgent.mockImplementation(async () => ({ success: false, aborted: true }));

    await relay(service, bridge);

    expect((service as any).inFlightRequests.has(BUFFER_KEY)).toBe(false);
  });

  it('lets the user send again after their turn was taken over', async () => {
    chatWithAgent.mockImplementation(async () => ({ success: false, aborted: true }));
    await relay(service, bridge);

    chatWithAgent.mockImplementation(async () => {
      emitChunk(CHAT_ID, 'second answer');
      eventBus.emitEvent('chat:complete', { agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
      return { success: true };
    });
    await relay(service, bridge, 'try again');

    const everySentString = [...bridge.editMessage.mock.calls, ...bridge.sendMessage.mock.calls]
      .flat()
      .map(String)
      .join(' ');
    expect(everySentString).not.toContain('Please wait for the current response to finish');
    expect(everySentString).toContain('second answer');
  });

  it('tells the remote user their turn was cancelled elsewhere', async () => {
    chatWithAgent.mockImplementation(async () => {
      eventBus.emitEvent('chat:aborted', { agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
      return { success: false, aborted: true };
    });

    await relay(service, bridge);

    const everySentString = [...bridge.editMessage.mock.calls, ...bridge.sendMessage.mock.calls]
      .flat()
      .map(String)
      .join(' ');
    expect(everySentString).toMatch(/cancelled/i);
  });

  it('leaves no bus listeners behind after a turn ends', async () => {
    const before = eventBus.listenerCount?.('chat:stream') ?? 0;

    chatWithAgent.mockImplementation(async () => {
      eventBus.emitEvent('chat:complete', { agentId: AGENT_ID, containerId: CHAT_ID, context: 'chat' });
      return { success: true };
    });
    await relay(service, bridge);

    expect(eventBus.listenerCount?.('chat:stream') ?? 0).toBe(before);
  });
});
