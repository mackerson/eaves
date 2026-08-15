/**
 * Import-action contract test.
 *
 * chatgpt-import drives three sandbox actions — createChat, bulkImportMessages,
 * bulkImportAttachments — that SandboxedPluginManager routes to
 * ChannelRepository.createDirectChat / bulkCreateDirectMessages and
 * MessageAttachmentRepository.bulkCreate. Nothing on the plugin side observes
 * whether those writes landed, so a broken contract fails silently: the import
 * reports success and persists nothing. This test reproduces the plugin's exact
 * data contract (the ContentConverter message shape + the FileExtractor
 * attachment shape, with the same deterministic ids) against the real repos, so
 * a shape or FK-ordering drift surfaces here instead of as a silent no-op.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelRepository } from './ChannelRepository';
import { MessageAttachmentRepository } from './MessageAttachmentRepository';
import { runMigrations } from '../services/migrations';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

// Mirror ContentConverter.convertMessage output: deterministic `id`,
// `originalId` (ChatGPT node id), and `parentMessageId` that references a
// *parent node id* (remapped through originalId during bulk insert). No chatId
// — the action handler injects it, which this test reproduces.
function converterMessage(nodeId: string, parentNodeId: string | null, content: string) {
  return {
    id: `m-${nodeId}`,
    originalId: nodeId,
    parentMessageId: parentNodeId,
    senderId: 'chatgpt',
    senderType: 'agent',
    senderDisplayName: 'ChatGPT',
    senderColor: '#10a37f',
    content,
    timestamp: 1_700_000_000_000 + nodeId.length,
    contentBlocks: [{ type: 'text', content }],
    metadata: { chatgpt: { nodeId } },
    branchIndex: 0,
    status: 'active',
  };
}

describe('chatgpt-import action contract', () => {
  let db: Database.Database;
  let channels: ChannelRepository;
  let attachments: MessageAttachmentRepository;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db, 0);
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, model, temperature, color, created_at)
      VALUES ('agent-1', 'Test Agent', '', 'anthropic', 'claude-3-sonnet', 0.7, '#667eea', ?)
    `).run(Date.now());

    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);

    channels = new ChannelRepository();
    attachments = new MessageAttachmentRepository();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('persists a chat, its message tree, and an attachment end-to-end', () => {
    // 1. createChat → createDirectChat
    const chat = channels.createDirectChat({
      name: 'Imported conversation',
      agentId: 'agent-1',
      tags: 'source:chatgpt,folder:Work',
    });
    expect(chat.id).toBeTruthy();

    // 2. bulkImportMessages → inject chatId, bulkCreateDirectMessages.
    // n1 (root) → n2 (child) → n3 (grandchild): parent links reference node ids
    // and must remap to the generated message ids.
    const messages = [
      converterMessage('n1', null, 'hello'),
      converterMessage('n2', 'n1', 'hi there'),
      converterMessage('n3', 'n2', 'follow-up'),
    ].map(m => ({ ...m, chatId: chat.id }));

    const ids = channels.bulkCreateDirectMessages(
      messages as unknown as Parameters<typeof channels.bulkCreateDirectMessages>[0]
    );
    expect(ids).toEqual(['m-n1', 'm-n2', 'm-n3']);

    const persisted = channels.getMessagesByChatId(chat.id);
    expect(persisted).toHaveLength(3);
    const byId = new Map(persisted.map(m => [m.id, m]));
    // Parent links remapped from node ids to real message ids.
    expect(byId.get('m-n2')!.parentMessageId).toBe('m-n1');
    expect(byId.get('m-n3')!.parentMessageId).toBe('m-n2');
    expect(byId.get('m-n1')!.parentMessageId).toBeFalsy();
    expect(byId.get('m-n1')!.content).toBe('hello');

    // 3. bulkImportAttachments → MessageAttachmentRepository.bulkCreate.
    // FileExtractor shape; messageId is the same deterministic id the message
    // was inserted with, so the FK resolves (import runs messages first).
    const attachmentIds = attachments.bulkCreate([
      {
        messageId: 'm-n2',
        filename: 'image.png',
        storedPath: '/eaves-data/attachments/image.png',
        mimeType: 'image/png',
        size: 2048,
        attachmentType: 'image',
        metadata: { asset_pointer: 'file-service://ptr-1' },
      },
    ] as unknown as Parameters<typeof attachments.bulkCreate>[0]);

    expect(attachmentIds).toHaveLength(1);
    const onMessage = attachments.getByMessageId('m-n2');
    expect(onMessage).toHaveLength(1);
    expect(onMessage[0].storedPath).toBe('/eaves-data/attachments/image.png');
  });
});
