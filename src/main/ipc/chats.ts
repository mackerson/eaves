import { ipcMain, BrowserWindow, app } from 'electron';
import { getChannelRepository, getAgentRepository, getSettingsRepository, getUserRepository, getMessageAttachmentRepository } from '../repositories';
import { logger } from '../services/logger';
import { eventBus } from '../services/EventBus';
import { ChatService } from '../services/ChatService';
import * as fs from 'fs';
import * as path from 'path';
import {
  getImageMimeType,
  getMimeType,
  isImageAttachmentExt,
  IMAGE_ATTACHMENT_EXTS,
  TEXT_ATTACHMENT_EXTS,
} from '../utils/mimeTypes';
import { substituteMustacheVars } from '../utils/substituteMustacheVars';
import { isInsideDirectory } from '../services/sandbox/pathContainment';
import { randomUUID } from 'crypto';
import {
  CreateChatRequest,
  UpdateChatRequest,
  SendChatMessageRequest,
  AddChatAgentMessageRequest,
  AddChatParticipantRequest,
  SearchChatsRequest,
  GetChatsByTagsRequest,
} from '../../shared/ipc-types';
import {
  EntityIdSchema,
  CreateChatSchema,
  UpdateChatSchema,
  SearchChatsSchema,
  GetChatsByTagsSchema,
  SendChatMessageSchema,
  EditMessageSchema,
  AddChatAgentMessageSchema,
  ChatWithAgentSchema,
  GenerateChatMetadataSchema,
  ToggleChatToolSchema,
  ReplaceAttachmentFileSchema,
  RegenerateChatMessageSchema,
  SwitchActiveBranchSchema,
  SwipeChatMessageBranchSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

// Per-message attachment limits. Enforced in the send-chat-message handler
// after path validation but before any disk I/O. Numbers picked to be
// generous for normal photo uploads while still protecting the data
// directory from runaway costs (a malicious renderer could otherwise stream
// gigabytes of files through this endpoint).
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;       // 10 MB per file
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB combined
// Images + text/document files. Sourced from the shared extension sets so the
// picker (files.ts) and this validation can't drift — closing the gap where a
// renderer could bypass the picker and post an arbitrary path. Images become
// vision parts; text files are read and inlined into the model context (see
// ChatService).
const ALLOWED_ATTACHMENT_EXTS = new Set([
  ...IMAGE_ATTACHMENT_EXTS,
  ...TEXT_ATTACHMENT_EXTS,
]);

export function registerChatHandlers(getMainWindow: () => BrowserWindow | null) {
  const chatService = new ChatService(getMainWindow);

  // Create new chat
  ipcMain.handle('create-chat', ipcResult('create-chat', async (_event, { name, agentId, tags }: CreateChatRequest) => {
    const validation = validateIPC(CreateChatSchema, { name, agentId, tags }, 'create-chat');
    if (!validation.success) return validation;
    const validData = validation.data;

    const chatRepo = getChannelRepository();
    const agentRepo = getAgentRepository();
    const userRepo = getUserRepository();

    const currentUser = userRepo.getCurrent();
    const agent = agentRepo.getById(validData.agentId);

    if (!currentUser) {
      return { success: false, error: 'No current user' };
    }

    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    const newChat = chatRepo.createDirectChat(
      { name: validData.name ?? `Chat with ${agent.name}`, agentId: validData.agentId, tags: validData.tags },
      [
        { id: currentUser.id, type: 'human', displayName: currentUser.name, color: currentUser.color, joinedAt: Date.now() },
        { id: validData.agentId, type: 'agent', displayName: agent.name, color: agent.color, joinedAt: Date.now() },
      ]
    );

    // Seed the chat with the agent's greeting (character-card "first message").
    // Posted as a regular agent message so the user can edit/delete it like any
    // other turn, and it flows into history naturally on the next streamText call.
    if (agent.greeting && agent.greeting.trim().length > 0) {
      // Substitute mustache vars at insert time so the user doesn't see literal
      // `{{user}}` / `{{char}}` in the chat. Same helper the system-prompt
      // builder uses, so a character card renders identically in both places.
      const rendered = substituteMustacheVars(agent.greeting, agent, currentUser.name);

      chatRepo.createDirectMessage({
        chatId: newChat.id,
        senderId: agent.id,
        senderType: 'agent',
        senderDisplayName: agent.name,
        senderColor: agent.color,
        metadata: { participantType: 'agent', greeting: true },
        content: rendered,
        timestamp: Date.now(),
      });
    }

    // createDirectChat returns the new chat with `messages: []` because the
    // row was just inserted; the greeting (if any) is added afterwards.
    // Re-read so the renderer receives the chat *with* the greeting in
    // its messages array — otherwise the user lands on a blank chat and
    // the greeting only appears after a chat-switch reload.
    const chatWithMessages = chatRepo.getDirectChatById(newChat.id) ?? newChat;

    logger.info(`[IPC] Created chat: ${newChat.id} with agent ${validData.agentId}${agent.greeting ? ' (with greeting)' : ''}`);
    return { success: true, chat: chatWithMessages };
  }));

  // Switch to a chat (update current chat in settings)
  ipcMain.handle('switch-chat', ipcResult('switch-chat', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'switch-chat');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const settingsRepo = getSettingsRepository();

    const chat = chatRepo.getDirectChatById(validation.data);
    if (chat) {
      settingsRepo.update({ currentChatId: validation.data });
      logger.debug(`[IPC] Switched to chat: ${validation.data}`);
    }
    return { success: !!chat };
  }));

  // Update chat
  ipcMain.handle('update-chat', ipcResult('update-chat', async (_event, { chatId, updates }: { chatId: string; updates: UpdateChatRequest }) => {
    const idValidation = validateIPC(EntityIdSchema, chatId, 'update-chat');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateChatSchema, updates, 'update-chat');
    if (!updatesValidation.success) return updatesValidation;

    const chatRepo = getChannelRepository();
    const chat = chatRepo.updateDirectChat(idValidation.data, updatesValidation.data);

    if (!chat) {
      return { success: false, error: 'Chat not found' };
    }

    logger.info(`[IPC] Updated chat: ${chatId}`);
    return { success: true, chat };
  }));

  // Archive chat
  ipcMain.handle('archive-chat', ipcResult('archive-chat', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'archive-chat');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const chat = chatRepo.archiveDirectChat(validation.data);

    if (!chat) {
      return { success: false, error: 'Chat not found' };
    }

    logger.info(`[IPC] Archived chat: ${chatId}`);
    return { success: true, chat };
  }));

  // Unarchive chat
  ipcMain.handle('unarchive-chat', ipcResult('unarchive-chat', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'unarchive-chat');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const chat = chatRepo.unarchiveDirectChat(validation.data);

    if (!chat) {
      return { success: false, error: 'Chat not found' };
    }

    logger.info(`[IPC] Unarchived chat: ${chatId}`);
    return { success: true, chat };
  }));

  // Delete chat
  ipcMain.handle('delete-chat', ipcResult('delete-chat', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'delete-chat');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const deleted = chatRepo.delete(validation.data);

    if (deleted) {
      // Clear any in-memory state for this chat (tool states, active streams)
      chatService.clearChatState(chatId);
      logger.info(`[IPC] Deleted chat: ${chatId}`);
      // A chat is a type='direct' channel — emit channel:deleted so the
      // deletion is recorded like any other channel removal (see delete-channel).
      eventBus.emitEvent('channel:deleted', { id: chatId });
    }

    return { success: deleted };
  }));

  // Get all chats
  ipcMain.handle('get-chats', ipcResult('get-chats', async (_event, options?: { includeArchived?: boolean }) => {
    const chatRepo = getChannelRepository();
    const chats = chatRepo.getDirectChats(options);
    return { success: true, chats };
  }));

  // Get chat by ID
  ipcMain.handle('get-chat', ipcResult('get-chat', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'get-chat');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const chat = chatRepo.getDirectChatById(validation.data);

    if (!chat) {
      return { success: false, error: 'Chat not found' };
    }

    return { success: true, chat };
  }));

  // Get chats by agent
  ipcMain.handle('get-chats-by-agent', ipcResult('get-chats-by-agent', async (_event, { agentId, options }: { agentId: string; options?: { includeArchived?: boolean } }) => {
    const validation = validateIPC(EntityIdSchema, agentId, 'get-chats-by-agent');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const chats = chatRepo.getDirectChatsByAgentId(validation.data, options);
    return { success: true, chats };
  }));

  // Search chats
  ipcMain.handle('search-chats', ipcResult('search-chats', async (_event, { query, includeArchived }: SearchChatsRequest) => {
    const validation = validateIPC(SearchChatsSchema, { query, includeArchived }, 'search-chats');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const chats = chatRepo.searchDirectChats(validation.data.query, { includeArchived: validation.data.includeArchived });
    return { success: true, chats };
  }));

  // Get chats by tags
  ipcMain.handle('get-chats-by-tags', ipcResult('get-chats-by-tags', async (_event, { tags, includeArchived }: GetChatsByTagsRequest) => {
    const validation = validateIPC(GetChatsByTagsSchema, { tags, includeArchived }, 'get-chats-by-tags');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const chats = chatRepo.getDirectChatsByTags(validation.data.tags, { includeArchived: validation.data.includeArchived });
    return { success: true, chats };
  }));

  // Send user message to chat
  ipcMain.handle('send-chat-message', ipcResult('send-chat-message', async (_event, params: SendChatMessageRequest) => {
    const validation = validateIPC(SendChatMessageSchema, params, 'send-chat-message');
    if (!validation.success) return validation;
    const { chatId, content, attachments } = validation.data;

    const chatRepo = getChannelRepository();
    const chat = chatRepo.getDirectChatById(chatId);
    const userRepo = getUserRepository();
    const currentUser = userRepo.getCurrent();

    if (!chat) {
      return { success: false, error: 'Chat not found' };
    }

    if (!currentUser) {
      return { success: false, error: 'No current user' };
    }

    // Build content blocks for the message
    const contentBlocks: any[] = [];

    // Add text content if present
    if (content && content.trim()) {
      contentBlocks.push({
        type: 'text',
        content: content.trim(),
      });
    }

    // Process attachments if present
    let failedAttachments = 0;
    if (attachments && attachments.length > 0) {
      // Upfront validation — reject the whole batch on any violation so we
      // don't half-process and leave orphan files on disk. Bypassing the
      // file picker is the threat model; the dialog already filters, but
      // the IPC accepts raw paths so we re-check here.
      if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return {
          success: false,
          error: `Too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message)`,
        };
      }
      let totalBytes = 0;
      for (const filePath of attachments) {
        const ext = path.extname(filePath).toLowerCase();
        if (!ALLOWED_ATTACHMENT_EXTS.has(ext)) {
          return {
            success: false,
            error: `Unsupported file type "${ext}" — allowed: images (jpg, png, gif, webp) and text/documents (md, txt, csv, json, code, …)`,
          };
        }
        let size: number;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          return { success: false, error: `Attachment not found or unreadable: ${path.basename(filePath)}` };
        }
        if (size > MAX_ATTACHMENT_BYTES) {
          return {
            success: false,
            error: `Attachment "${path.basename(filePath)}" exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per-file limit`,
          };
        }
        totalBytes += size;
      }
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return {
          success: false,
          error: `Total attachment size exceeds ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB limit`,
        };
      }

      const dataDir = path.join(app.getPath('userData'), 'enclave-data');
      const attachmentsDir = path.join(dataDir, 'enclave-attachments');

      // Ensure attachments directory exists
      if (!fs.existsSync(attachmentsDir)) {
        fs.mkdirSync(attachmentsDir, { recursive: true });
      }

      for (const filePath of attachments) {
        try {
          const ext = path.extname(filePath);
          const filename = path.basename(filePath);
          const stats = fs.statSync(filePath);

          const storedFilename = `${randomUUID()}${ext}`;
          const storedPath = path.join(attachmentsDir, storedFilename);

          fs.copyFileSync(filePath, storedPath);

          if (isImageAttachmentExt(ext)) {
            const mimeType = getImageMimeType(ext, 'application/octet-stream');
            contentBlocks.push({
              type: 'image',
              url: `file-service://${storedFilename}`,
              alt: filename,
              metadata: { storedPath, filename, mimeType, size: stats.size },
            });
          } else {
            // Text/document file — stored the same way, but rendered as a chip
            // and inlined as text (not a vision part) by ChatService.
            const mimeType = getMimeType(ext) ?? 'text/plain';
            contentBlocks.push({
              type: 'file',
              filename,
              mimeType,
              size: stats.size,
              url: `file-service://${storedFilename}`,
              metadata: { storedPath, filename, mimeType, size: stats.size },
            });
          }
        } catch (error) {
          failedAttachments++;
          logger.error(`[IPC] Failed to process attachment ${filePath}:`, error);
        }
      }
    }

    // Parent the user message onto the prior turn so the conversation is a
    // proper chain. Without this, every user message has parent_message_id
    // NULL, which would inflate branchCount on root-level rows.
    const parentMessageId = chatRepo.getLatestActiveMessageId(chatId) ?? undefined;

    const userMessage = chatRepo.createDirectMessage({
      chatId,
      senderId: currentUser.id,
      senderType: 'human',
      senderDisplayName: currentUser.name,
      senderColor: currentUser.color,
      metadata: { participantType: 'human' },
      content: content || '',
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      timestamp: Date.now(),
      parentMessageId,
    });

    // Now create attachment records in database and update content blocks with proper URLs
    if (attachments && attachments.length > 0) {
      const attachmentRepo = getMessageAttachmentRepository();
      const attachmentBlocks = contentBlocks.filter(
        b => (b.type === 'image' || b.type === 'file') && b.metadata?.storedPath,
      );

      for (const block of attachmentBlocks) {
        const attachment = attachmentRepo.create({
          messageId: userMessage.id,
          filename: block.metadata.filename,
          storedPath: block.metadata.storedPath,
          mimeType: block.metadata.mimeType,
          size: block.metadata.size,
          attachmentType: block.type === 'image' ? 'image' : 'file',
          metadata: {},
        });

        // Update the block URL to use the attachment ID
        block.url = `file-service://${attachment.id}`;
        delete block.metadata.storedPath;
      }

      // Update the message with corrected content blocks
      chatRepo.updateMessage(userMessage.id, { contentBlocks });
    }

    logger.info(`[IPC] User message sent to chat: ${chatId}${attachments ? ` with ${attachments.length} attachments` : ''}${failedAttachments > 0 ? ` (${failedAttachments} failed)` : ''}`);
    return { success: true, message: userMessage, ...(failedAttachments > 0 && { failedAttachments }) };
  }));

  // Add agent message to chat
  ipcMain.handle('add-chat-agent-message', ipcResult('add-chat-agent-message', async (_event, { chatId, agentId, content, toolCalls, contentBlocks, metrics }: AddChatAgentMessageRequest) => {
    const chatIdValidation = validateIPC(EntityIdSchema, chatId, 'add-chat-agent-message chatId');
    if (!chatIdValidation.success) return chatIdValidation;
    const agentIdValidation = validateIPC(EntityIdSchema, agentId, 'add-chat-agent-message agentId');
    if (!agentIdValidation.success) return agentIdValidation;

    const chatRepo = getChannelRepository();
    const chat = chatRepo.getDirectChatById(chatIdValidation.data);
    const agentRepo = getAgentRepository();
    const agent = agentRepo.getById(agentIdValidation.data);

    if (!chat) {
      return { success: false, error: 'Chat not found' };
    }

    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    // Ensure agent is a participant
    if (!chat.participants.some(p => p.id === agentId)) {
      chatRepo.addParticipant(chatId, {
        id: agentId,
        type: 'agent',
        displayName: agent.name,
        color: agent.color,
        joinedAt: Date.now(),
      });
    }

    const parentMessageId = chatRepo.getLatestActiveMessageId(chatId) ?? undefined;

    const agentMessage = chatRepo.createDirectMessage({
      chatId,
      senderId: agentId,
      senderType: 'agent',
      senderDisplayName: agent.name,
      senderColor: agent.color,
      metadata: { participantType: 'agent' },
      content,
      timestamp: Date.now(),
      toolCalls,
      contentBlocks,
      metrics,
      parentMessageId,
    });

    logger.info(`[IPC] Agent message added to chat: ${chatId}`);
    return { success: true, message: agentMessage };
  }));

  // Add participant to chat
  ipcMain.handle('add-chat-participant', ipcResult('add-chat-participant', async (_event, { chatId, participantId }: AddChatParticipantRequest) => {
    const chatIdValidation = validateIPC(EntityIdSchema, chatId, 'add-chat-participant chatId');
    if (!chatIdValidation.success) return chatIdValidation;
    const participantValidation = validateIPC(EntityIdSchema, participantId, 'add-chat-participant participantId');
    if (!participantValidation.success) return participantValidation;

    const chatRepo = getChannelRepository();
    const agentRepo = getAgentRepository();

    const chat = chatRepo.getDirectChatById(chatIdValidation.data);
    if (!chat) {
      return { success: false, error: 'Chat not found' };
    }

    const agent = agentRepo.getById(participantValidation.data);
    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    chatRepo.addParticipant(chatIdValidation.data, {
      id: participantValidation.data,
      type: 'agent',
      displayName: agent.name,
      color: agent.color,
      joinedAt: Date.now(),
    });

    logger.info(`[IPC] Added participant ${participantValidation.data} to chat: ${chatIdValidation.data}`);
    return { success: true };
  }));

  // Update chat message (user edit) — also rewrites the text content block,
  // since the renderer displays content_blocks when present.
  ipcMain.handle('update-chat-message', ipcResult('update-chat-message', async (_event, { messageId, content }: { messageId: string; content: string }) => {
    const validation = validateIPC(EditMessageSchema, { messageId, content }, 'update-chat-message');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const result = chatRepo.updateMessageText(validation.data.messageId, validation.data.content);
    if (!result) {
      return { success: false, error: 'Message not found' };
    }
    logger.info(`[IPC] Updated chat message: ${validation.data.messageId}`);
    return { success: true, contentBlocks: result.contentBlocks };
  }));

  // Delete chat message
  ipcMain.handle('delete-chat-message', ipcResult('delete-chat-message', async (_event, messageId: string) => {
    const validation = validateIPC(EntityIdSchema, messageId, 'delete-chat-message');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const deleted = chatRepo.deleteMessage(validation.data);
    if (deleted) {
      logger.info(`[IPC] Deleted chat message: ${messageId}`);
      eventBus.emitEvent('message:deleted', { id: validation.data });
    }
    return { success: deleted };
  }));

  // Chat with AI (for chats, not channels)
  ipcMain.handle('chat-with-agent', ipcResult('chat-with-agent', async (_event, { chatId, agentId }: { chatId: string; agentId: string }) => {
    const validation = validateIPC(ChatWithAgentSchema, { chatId, agentId }, 'chat-with-agent');
    if (!validation.success) return validation;
    const { chatId: validChatId, agentId: validAgentId } = validation.data;

    return chatService.chatWithAgent(validChatId, validAgentId);
  }));

  // Regenerate an agent message: archive the original (and its active
  // descendants), then re-stream a sibling reply with the next branch_index.
  // The carousel UI renders siblings; switch-active-branch lets the user
  // swipe between them after the fact.
  ipcMain.handle('regenerate-chat-message', ipcResult('regenerate-chat-message', async (_event, params: { messageId: string }) => {
    const validation = validateIPC(RegenerateChatMessageSchema, params, 'regenerate-chat-message');
    if (!validation.success) return validation;
    const { messageId } = validation.data;

    const chatRepo = getChannelRepository();

    // Look up the target via getSiblings (it already does the row lookup
    // and returns siblings — we only need the target itself for the
    // senderType guard).
    const siblings = chatRepo.getSiblings(messageId);
    const target = siblings.find(s => s.id === messageId);
    if (!target) return { success: false, error: 'Message not found' };
    if (target.senderType !== 'agent') {
      return { success: false, error: 'Only agent messages can be regenerated' };
    }

    const { chatId, parentMessageId, nextBranchIndex } = chatRepo.regenerateFrom(messageId);

    // Resolve the chat's agent. 1:1 chats have a single agent on the chat
    // record — that's the agent who'll produce the new variant.
    const chat = chatRepo.getDirectChatById(chatId, { includeMessages: false });
    if (!chat) return { success: false, error: 'Chat not found' };

    logger.info(`[IPC] Regenerating chat message: ${messageId} (chat ${chatId}, branch ${nextBranchIndex})`);

    return chatService.chatWithAgent(chatId, chat.agentId, {
      branchOverride: { parentMessageId, branchIndex: nextBranchIndex },
    });
  }));

  // Switch the active branch through `messageId`. Activates the path up
  // through ancestors and down through highest-branch_index descendants;
  // archives the displaced subtree. The renderer reloads the chat after
  // this resolves to pick up the new active path.
  ipcMain.handle('switch-active-branch', ipcResult('switch-active-branch', async (_event, params: { messageId: string }) => {
    const validation = validateIPC(SwitchActiveBranchSchema, params, 'switch-active-branch');
    if (!validation.success) return validation;
    const { messageId } = validation.data;

    const chatRepo = getChannelRepository();
    try {
      chatRepo.switchActiveBranch(messageId);
    } catch (error: any) {
      logger.error(`[IPC] switch-active-branch failed for ${messageId}:`, error);
      return { success: false, error: error?.message ?? 'Failed to switch branch' };
    }

    logger.info(`[IPC] Switched active branch to message: ${messageId}`);
    return { success: true };
  }));

  // Swipe to the prev/next sibling of `messageId` (i.e. activate the
  // sibling at branch_index ± 1). Single round trip from the carousel UI:
  // resolves the target sibling and switches the active path in one call.
  ipcMain.handle('swipe-chat-message-branch', ipcResult('swipe-chat-message-branch', async (_event, params: { messageId: string; direction: 'prev' | 'next' }) => {
    const validation = validateIPC(SwipeChatMessageBranchSchema, params, 'swipe-chat-message-branch');
    if (!validation.success) return validation;
    const { messageId, direction } = validation.data;

    const chatRepo = getChannelRepository();
    const siblings = chatRepo.getSiblings(messageId);
    const currentIdx = siblings.findIndex(s => s.id === messageId);
    if (currentIdx < 0) return { success: false, error: 'Message not found' };

    const targetIdx = direction === 'prev' ? currentIdx - 1 : currentIdx + 1;
    if (targetIdx < 0 || targetIdx >= siblings.length) {
      return { success: false, error: `No sibling ${direction} of branch ${currentIdx + 1}/${siblings.length}` };
    }

    const targetId = siblings[targetIdx].id;
    try {
      chatRepo.switchActiveBranch(targetId);
    } catch (error: any) {
      logger.error(`[IPC] swipe-chat-message-branch failed for ${messageId}->${targetId}:`, error);
      return { success: false, error: error?.message ?? 'Failed to swipe branch' };
    }

    logger.info(`[IPC] Swiped chat branch: ${messageId} -> ${targetId} (${direction})`);
    return { success: true, switchedToMessageId: targetId };
  }));

  // Stop stream for chats
  ipcMain.handle('stop-chat-stream', ipcResult('stop-chat-stream', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'stop-chat-stream');
    if (!validation.success) return validation;

    return chatService.stopStream(validation.data);
  }));

  // Generate chat metadata (title and tags) based on first messages
  ipcMain.handle('generate-chat-metadata', ipcResult('generate-chat-metadata', async (_event, { chatId, messages }: { chatId: string; messages: any[] }) => {
    const validation = validateIPC(GenerateChatMetadataSchema, { chatId, messages }, 'generate-chat-metadata');
    if (!validation.success) return validation;

    return chatService.generateMetadata(validation.data.chatId, validation.data.messages as any);
  }));

  // Get chat tools with their enabled status
  ipcMain.handle('get-chat-tools', ipcResult('get-chat-tools', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'get-chat-tools');
    if (!validation.success) return validation;

    return chatService.getChatTools(validation.data);
  }));

  // Toggle chat tool enabled/disabled
  ipcMain.handle('toggle-chat-tool', ipcResult('toggle-chat-tool', async (_event, { chatId, toolName, enabled }: { chatId: string; toolName: string; enabled: boolean }) => {
    const validation = validateIPC(ToggleChatToolSchema, { chatId, toolName, enabled }, 'toggle-chat-tool');
    if (!validation.success) return validation;

    return chatService.toggleChatTool(validation.data.chatId, validation.data.toolName, validation.data.enabled);
  }));

  // Duplicate a chat (copies name, agent, participants, and all messages)
  ipcMain.handle('duplicate-chat', ipcResult('duplicate-chat', async (_event, chatId: string) => {
    const validation = validateIPC(EntityIdSchema, chatId, 'duplicate-chat');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const source = chatRepo.getDirectChatById(validation.data);
    if (!source) return { success: false, error: 'Chat not found' };

    const newChat = chatRepo.createDirectChat(
      { name: `${source.name} (copy)`, agentId: source.agentId, tags: source.tags },
      source.participants
    );

    if (source.messages.length > 0) {
      // Pass originalId + parentMessageId so the bulk-insert two-pass logic
      // remaps each row's parent to its corresponding new-chat id. Without
      // this the clone would have NULL parents everywhere — the same broken
      // shape a repair migration had to backfill for rows written before the
      // branch tree existed, and it breaks regenerate/swipe in the copy.
      chatRepo.bulkCreateDirectMessages(
        source.messages.map((msg) => ({
          chatId: newChat.id,
          senderId: msg.senderId,
          senderType: msg.senderType,
          senderDisplayName: msg.senderDisplayName,
          senderColor: msg.senderColor,
          metadata: msg.metadata,
          metrics: msg.metrics,
          content: msg.content,
          contentBlocks: msg.contentBlocks,
          toolCalls: msg.toolCalls,
          timestamp: msg.timestamp,
          parentMessageId: msg.parentMessageId,
          originalId: msg.id,
        }) as any)
      );
    }

    const chat = chatRepo.getDirectChatById(newChat.id);
    logger.info(`[IPC] Duplicated chat ${validation.data} -> ${newChat.id}`);
    return { success: true, chat };
  }));

  // Export a chat as markdown
  ipcMain.handle('export-chat-markdown', ipcResult('export-chat-markdown', async (_event, chatId: string) => {
    const { dialog } = await import('electron');
    const validation = validateIPC(EntityIdSchema, chatId, 'export-chat-markdown');
    if (!validation.success) return validation;

    const chatRepo = getChannelRepository();
    const chat = chatRepo.getDirectChatById(validation.data);
    if (!chat) return { success: false, error: 'Chat not found' };

    // Build markdown
    const lines: string[] = [`# ${chat.name}`, ''];
    if (chat.tags) lines.push(`**Tags:** ${chat.tags}`, '');
    lines.push(`**Created:** ${new Date(chat.createdAt).toLocaleString()}`, '---', '');

    for (const msg of chat.messages) {
      const sender = msg.senderType === 'human' ? msg.senderDisplayName : `**${msg.senderDisplayName}** (agent)`;
      const time = new Date(msg.timestamp).toLocaleString();
      lines.push(`### ${sender}`, `*${time}*`, '');

      if (msg.contentBlocks && msg.contentBlocks.length > 0) {
        for (const block of msg.contentBlocks) {
          if (block.type === 'text' && block.content) {
            lines.push(block.content, '');
          } else if (block.type === 'image') {
            lines.push(`![${block.alt || 'image'}](${block.url || ''})`, '');
          } else if (block.type === 'tool-call') {
            const tc = block.toolCall;
            lines.push(`\`\`\`tool-call: ${tc.toolName}\n${JSON.stringify(tc.args, null, 2)}\n\`\`\``, '');
            if (tc.result !== undefined) {
              lines.push(`\`\`\`tool-result: ${tc.toolName}\n${typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}\n\`\`\``, '');
            }
          } else if (block.type === 'tool-approval') {
            // Human-in-the-loop tool call. A turn whose blocks are exclusively
            // approvals (common for execute_code/bash) would otherwise export
            // as a blank section under a real header.
            const ap = block.approval;
            lines.push(`\`\`\`tool-approval: ${ap.toolName} (${ap.status})\n${JSON.stringify(ap.input, null, 2)}\n\`\`\``, '');
          } else if (block.type === 'system' && block.content) {
            lines.push(`> ${block.content}`, '');
          }
        }
      } else {
        lines.push(msg.content, '');
      }

      lines.push('---', '');
    }

    const markdown = lines.join('\n');
    const safeName = chat.name.replace(/[^a-zA-Z0-9_-]/g, '_');

    const { canceled, filePath: savePath } = await dialog.showSaveDialog({
      title: 'Export Chat',
      defaultPath: `${safeName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (canceled || !savePath) return { success: false, error: 'Cancelled' };

    fs.writeFileSync(savePath, markdown, 'utf-8');
    logger.info(`[IPC] Exported chat ${chatId} to ${savePath}`);
    return { success: true, filePath: savePath };
  }));

  // Replace missing attachment file (or create new one if it doesn't exist)
  ipcMain.handle('replace-attachment-file', ipcResult('replace-attachment-file', async (_event, { assetPointer, filePath, messageId }: { assetPointer: string; filePath: string; messageId?: string }) => {
    const validation = validateIPC(ReplaceAttachmentFileSchema, { assetPointer, filePath, messageId }, 'replace-attachment-file');
    if (!validation.success) return validation;

    // Path traversal protection: resolve and verify the source path.
    // startsWith(homeDir) is unsafe (a sibling like /home/user2 passes for
    // /home/user); use a real containment check.
    const resolvedFilePath = path.resolve(validation.data.filePath);
    const homeDir = app.getPath('home');
    const tempDir = app.getPath('temp');
    if (!isInsideDirectory(resolvedFilePath, homeDir) && !isInsideDirectory(resolvedFilePath, tempDir)) {
      return { success: false, error: 'File path must be within user home or temp directory' };
    }

    const attachmentRepo = getMessageAttachmentRepository();

    // Get data directory
    const dataDir = path.join(app.getPath('userData'), 'enclave-data');
    const attachmentsDir = path.join(dataDir, 'enclave-attachments');

    // Ensure attachments directory exists
    if (!fs.existsSync(attachmentsDir)) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
    }

    // Find the attachment by asset_pointer
    let attachment = attachmentRepo.getByAssetPointer(assetPointer);

    const ext = path.extname(resolvedFilePath);
    const stats = fs.statSync(resolvedFilePath);
    const mimeType = getImageMimeType(ext, 'application/octet-stream');

    if (!attachment) {
      // Create new attachment record if we have a messageId
      if (!messageId) {
        return { success: false, error: 'Attachment not found and no messageId provided to create one' };
      }

      // Generate filename based on asset pointer
      const sanitizedPointer = assetPointer.replace(/[^a-zA-Z0-9_-]/g, '_');
      const newFilename = `${sanitizedPointer}${ext}`;
      const newStoredPath = path.join(attachmentsDir, newFilename);

      // Copy file
      fs.copyFileSync(resolvedFilePath, newStoredPath);

      // Create new attachment record
      attachment = attachmentRepo.create({
        messageId,
        filename: path.basename(resolvedFilePath),
        storedPath: newStoredPath,
        mimeType,
        size: stats.size,
        attachmentType: 'image',
        metadata: { asset_pointer: assetPointer },
      });

      logger.info(`[IPC] Created new attachment for ${assetPointer} -> ${attachment.id}`);
    } else {
      // Update existing attachment
      const newFilename = `${attachment.id}${ext}`;
      const newStoredPath = path.join(attachmentsDir, newFilename);

      fs.copyFileSync(resolvedFilePath, newStoredPath);

      attachmentRepo.updateFile(attachment.id, {
        storedPath: newStoredPath,
        filename: path.basename(resolvedFilePath),
        size: stats.size,
        mimeType,
      });

      logger.info(`[IPC] Replaced attachment file for ${assetPointer}`);
    }

    // Return new URL for immediate display
    const newUrl = `file-service://asset/${encodeURIComponent(assetPointer)}`;
    return { success: true, newUrl };
  }));
}
