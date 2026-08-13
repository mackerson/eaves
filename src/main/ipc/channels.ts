import { ipcMain, BrowserWindow } from 'electron';
import { getChannelRepository, getAgentRepository, getSettingsRepository, getUserRepository, getToolStateRepository, getConversationFolderRepository } from '../repositories';
import { logger } from '../services/logger';
import { eventBus } from '../services/EventBus';
import {
  EntityIdSchema,
  CreateChannelIPCSchema,
  SendMessageSchema,
  EditMessageSchema,
  SetConversationPinnedSchema,
  SetConversationFolderSchema,
  CreateConversationFolderSchema,
  RenameConversationFolderSchema,
  UpdateChannelSchema,
  ListChannelsSchema,
  SearchChannelsSchema,
  GetChannelsByTagsSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { ingestAttachments, bindAttachmentRecords } from './attachmentIngest';
import { clearChannelDispatcherState, getChannelDispatcher } from '../services/ChannelDispatcher';
import type {
  UpdateChannelRequest,
  SearchChannelsRequest,
  GetChannelsByTagsRequest,
} from '../../shared/ipc-types';

export function registerChannelHandlers(getMainWindow: () => BrowserWindow | null) {
  // --- Conversation pinning + folders (chats and channels share the table) ---

  ipcMain.handle('conversation:set-pinned', ipcResult('conversation:set-pinned', async (_event, params: { conversationId: string; pinned: boolean }) => {
    const validation = validateIPC(SetConversationPinnedSchema, params, 'conversation:set-pinned');
    if (!validation.success) return validation;
    const updated = getChannelRepository().setConversationPinned(validation.data.conversationId, validation.data.pinned);
    return updated ? { success: true } : { success: false, error: 'Conversation not found' };
  }));

  ipcMain.handle('conversation:set-folder', ipcResult('conversation:set-folder', async (_event, params: { conversationId: string; folderId: string | null }) => {
    const validation = validateIPC(SetConversationFolderSchema, params, 'conversation:set-folder');
    if (!validation.success) return validation;
    const updated = getChannelRepository().setConversationFolder(validation.data.conversationId, validation.data.folderId);
    return updated ? { success: true } : { success: false, error: 'Conversation not found' };
  }));

  ipcMain.handle('conversation-folders:list', ipcResult('conversation-folders:list', async (_event, projectId?: string) => {
    if (projectId !== undefined) {
      const validation = validateIPC(EntityIdSchema, projectId, 'conversation-folders:list');
      if (!validation.success) return validation;
    }
    return { success: true, folders: getConversationFolderRepository().getAll(projectId) };
  }));

  ipcMain.handle('conversation-folders:create', ipcResult('conversation-folders:create', async (_event, params: { name: string; projectId?: string }) => {
    const validation = validateIPC(CreateConversationFolderSchema, params, 'conversation-folders:create');
    if (!validation.success) return validation;
    const folder = getConversationFolderRepository().create(validation.data);
    return { success: true, folder };
  }));

  ipcMain.handle('conversation-folders:rename', ipcResult('conversation-folders:rename', async (_event, params: { folderId: string; name: string }) => {
    const validation = validateIPC(RenameConversationFolderSchema, params, 'conversation-folders:rename');
    if (!validation.success) return validation;
    const renamed = getConversationFolderRepository().rename(validation.data.folderId, validation.data.name);
    return renamed ? { success: true } : { success: false, error: 'Folder not found' };
  }));

  ipcMain.handle('conversation-folders:delete', ipcResult('conversation-folders:delete', async (_event, folderId: string) => {
    const validation = validateIPC(EntityIdSchema, folderId, 'conversation-folders:delete');
    if (!validation.success) return validation;
    const deleted = getConversationFolderRepository().delete(validation.data);
    return deleted ? { success: true } : { success: false, error: 'Folder not found' };
  }));

  ipcMain.handle('create-channel', ipcResult('create-channel', async (_event, { name, type, projectId }: { name: string; type: 'public' | 'project' | 'direct'; projectId?: string }) => {
    const validation = validateIPC(CreateChannelIPCSchema, { name, type, projectId }, 'create-channel');
    if (!validation.success) return validation;
    const validData = validation.data;

    const channelRepo = getChannelRepository();
    const settingsRepo = getSettingsRepository();
    const userRepo = getUserRepository();
    const currentUser = userRepo.getCurrent();

    if (!currentUser) {
      return { success: false, error: 'No current user' };
    }

    const newChannel = channelRepo.create(
      { name: validData.name, type: validData.type ?? 'public', projectId: validData.projectId },
      [{ id: currentUser.id, type: 'human', displayName: currentUser.name, color: currentUser.color, joinedAt: Date.now() }]
    );
    settingsRepo.setCurrentChannel(newChannel.id);
    return { success: true, channel: newChannel };
  }));

  ipcMain.handle('switch-channel', ipcResult('switch-channel', async (_event, channelId: string) => {
    const validation = validateIPC(EntityIdSchema, channelId, 'switch-channel');
    if (!validation.success) return validation;

    const channelRepo = getChannelRepository();
    const settingsRepo = getSettingsRepository();

    // getById hydrates messages (last 100) — the renderer needs them here:
    // neither get-channels nor get-memory carries history for a channel that
    // isn't the persisted current one, so a switch is the only chance to load it.
    const channel = channelRepo.getById(validation.data);
    if (!channel) return { success: false };
    settingsRepo.setCurrentChannel(validation.data);
    return { success: true, channel };
  }));

  // Track active stream AbortControllers keyed by channel/agent combination.
  // Shared by the server-side selected-agent path and 'stop-stream'.
  const activeStreamControllers = new Map<string, AbortController>();

  ipcMain.handle('send-message', ipcResult('send-message', async (_event, params: { channelId: string; content: string; agentId?: string; attachments?: string[] }) => {
    const validation = validateIPC(SendMessageSchema, params, 'send-message');
    if (!validation.success) return validation;
    const validData = validation.data;

    const channelRepo = getChannelRepository();
    const channel = channelRepo.getById(validData.channelId);
    const userRepo = getUserRepository();
    const currentUser = userRepo.getCurrent();

    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    if (!currentUser) {
      return { success: false, error: 'No current user' };
    }

    // Selected-agent sends fail closed before persisting: the addressed
    // agent's single turn is the whole point of the send, so a bad agent id
    // must not leave a persisted message with no agent turn behind it.
    if (validData.agentId && !getAgentRepository().getById(validData.agentId)) {
      return { success: false, error: 'Agent not found' };
    }

    // Attachments: validate + copy into the store before persisting anything,
    // fail-closed on the whole batch (same semantics as the chat send path) so
    // a rejected send leaves neither orphan files nor a message referencing
    // them. Blocks land on the human message as image/file content blocks
    // alongside the text.
    let contentBlocks: any[] | undefined;
    let failedAttachments = 0;
    if (validData.attachments && validData.attachments.length > 0) {
      const ingest = ingestAttachments(validData.attachments);
      if (!ingest.ok) {
        return { success: false, error: ingest.error };
      }
      failedAttachments = ingest.failedAttachments;
      contentBlocks = [
        { type: 'text', content: validData.content },
        ...ingest.blocks,
      ];
    }

    const userMessage = channelRepo.createMessage({
      channelId: validData.channelId,
      senderId: currentUser.id,
      senderType: 'human',
      senderDisplayName: currentUser.name,
      senderColor: currentUser.color,
      // addressedAgentId is written for observability only — dispatch
      // suppression is a property of the intent below, not of stored data
      // (ADR-001 Decision 5).
      metadata: validData.agentId
        ? { participantType: 'human', addressedAgentId: validData.agentId }
        : { participantType: 'human' },
      content: validData.content,
      contentBlocks,
      timestamp: Date.now(),
    });

    // Attachment DB records need the message id (FK), so they bind after the
    // insert; the rewrite swaps block URLs to stable attachment ids and the
    // event-silent re-save keeps the persisted blocks in sync. The returned
    // userMessage shares the mutated array, so callers see the final URLs.
    if (contentBlocks && bindAttachmentRecords(userMessage.id, contentBlocks)) {
      channelRepo.updateMessage(userMessage.id, { contentBlocks });
    }
    if (validData.attachments?.length) {
      logger.info(`[IPC] send-message attachments processed`, {
        channelId: validData.channelId,
        count: validData.attachments.length,
        failed: failedAttachments,
      });
    }

    // Explicit dispatch intent (ADR-001 Decision 2): mention / respondTo:'all'
    // resolution runs off this direct call — persisting a message never
    // implies dispatch. A selected send produces a single-target shape:
    // addressedAgentId suppresses broadcast and excludes the addressed agent,
    // whose turn runs via dispatchSelectedAgent below.
    void getChannelDispatcher(getMainWindow)
      .requestDispatch({
        channelId: validData.channelId,
        triggerMessageId: userMessage.id,
        triggerContent: validData.content,
        senderId: currentUser.id,
        senderType: 'human',
        chainDepth: 0,
        addressedAgentId: validData.agentId,
      })
      .catch((error) => {
        logger.error('[send-message] Dispatch failed', {
          channelId: validData.channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    if (validData.agentId) {
      const agentId = validData.agentId;
      const streamKey = `${validData.channelId}:${agentId}`;
      // Registered in the same map 'stop-stream' reads, so the user can abort
      // this turn; a fresh send to the same channel/agent preempts whatever is
      // still in flight rather than racing it.
      activeStreamControllers.get(streamKey)?.abort();
      const controller = new AbortController();
      activeStreamControllers.set(streamKey, controller);
      // Fire-and-forget: the reply reaches the renderer via
      // 'channel-message-added' (draft) → 'chat-stream' → 'message-updated'
      // (finalize); failures persist an in-channel dispatch-error notice.
      void getChannelDispatcher(getMainWindow)
        .dispatchSelectedAgent(validData.channelId, agentId, userMessage.id, controller.signal)
        .catch((error) => {
          logger.error('[send-message] Selected-agent turn failed', {
            channelId: validData.channelId, agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (activeStreamControllers.get(streamKey) === controller) {
            activeStreamControllers.delete(streamKey);
          }
        });
    }

    return { success: true, message: userMessage, ...(failedAttachments > 0 && { failedAttachments }) };
  }));

  // Test/QA seam, not a product path: writes an agent-authored row directly
  // (auto-joining the agent as a participant) with no model turn and no dispatch
  // intent — exactly what the harness needs to seed drafts and canned transcripts
  // without an API key. Real agent turns are persisted server-side by
  // ChannelDispatcher; nothing in the renderer app calls this, and the warning
  // below is the tripwire for the day something does.
  ipcMain.handle('add-agent-message', ipcResult('add-agent-message', async (_event, { channelId, agentId, content, toolCalls, contentBlocks, metrics, isDraft, responseMessages }: { channelId: string; agentId: string; content: string; toolCalls?: any[]; contentBlocks?: any[]; metrics?: any; isDraft?: boolean; responseMessages?: unknown[] }) => {
    logger.warn('[IPC] add-agent-message is deprecated; agent turns are persisted server-side', { channelId, agentId });
    const chIdValidation = validateIPC(EntityIdSchema, channelId, 'add-agent-message channelId');
    if (!chIdValidation.success) return chIdValidation;
    const agIdValidation = validateIPC(EntityIdSchema, agentId, 'add-agent-message agentId');
    if (!agIdValidation.success) return agIdValidation;

    const channelRepo = getChannelRepository();
    const channel = channelRepo.getById(chIdValidation.data);
    const agentRepo = getAgentRepository();
    const agent = agentRepo.getById(agIdValidation.data);

    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    if (!channel.participants.some(p => p.id === agentId)) {
      channelRepo.addParticipant(channelId, {
        id: agentId,
        type: 'agent',
        displayName: agent.name,
        color: agent.color,
        joinedAt: Date.now(),
      });
    }

    const agentMessage = channelRepo.createMessage({
      channelId,
      senderId: agentId,
      senderType: 'agent',
      senderDisplayName: agent.name,
      senderColor: agent.color,
      metadata: { participantType: 'agent' },
      content,
      timestamp: Date.now(),
      toolCalls,
      contentBlocks,
      responseMessages,
      metrics,
      isDraft,
    });

    return { success: true, message: agentMessage };
  }));

  ipcMain.handle('add-channel-participant', ipcResult('add-channel-participant', async (_event, { channelId, participantId }: { channelId: string; participantId: string }) => {
    const chValidation = validateIPC(EntityIdSchema, channelId, 'add-channel-participant channelId');
    if (!chValidation.success) return chValidation;
    const pValidation = validateIPC(EntityIdSchema, participantId, 'add-channel-participant participantId');
    if (!pValidation.success) return pValidation;

    const channelRepo = getChannelRepository();
    const channel = channelRepo.getById(chValidation.data);

    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    const agentRepo = getAgentRepository();
    const agent = agentRepo.getById(participantId);
    if (agent) {
      channelRepo.addParticipant(channelId, {
        id: agent.id,
        type: 'agent',
        displayName: agent.name,
        color: agent.color,
        joinedAt: Date.now(),
      });
    } else {
      // Assume it's a user ID
      const userRepo = getUserRepository();
      const user = userRepo.getById(participantId);
      if (user) {
        channelRepo.addParticipant(channelId, {
          id: user.id,
          type: 'human',
          displayName: user.name,
          color: user.color,
          joinedAt: Date.now(),
        });
      } else {
        return { success: false, error: 'Participant not found' };
      }
    }
    return { success: true };
  }));

  ipcMain.handle('update-channel', ipcResult('update-channel', async (_event, { channelId, updates }: { channelId: string; updates: UpdateChannelRequest }) => {
    const idValidation = validateIPC(EntityIdSchema, channelId, 'update-channel');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateChannelSchema, updates, 'update-channel');
    if (!updatesValidation.success) return updatesValidation;

    const channelRepo = getChannelRepository();
    const updatedChannel = channelRepo.update(idValidation.data, updatesValidation.data);
    return updatedChannel;
  }));

  // --- Tags / archive surface. First-class on every channel, direct or not:
  // the chat handlers (get-chats / archive-chat / search-chats / get-chats-by-tags)
  // read the same rows through the direct-channel projection, so these keep
  // identical request/response shapes and delegate straight to the repository.
  // All of these are storage-event silent (reads + updates, no emissions).

  ipcMain.handle('get-channels', ipcResult('get-channels', async (_event, options?: { includeArchived?: boolean }) => {
    const validation = validateIPC(ListChannelsSchema, options, 'get-channels');
    if (!validation.success) return validation;

    const channels = getChannelRepository().getAll({ includeArchived: validation.data?.includeArchived });
    return { success: true, channels };
  }));

  ipcMain.handle('archive-channel', ipcResult('archive-channel', async (_event, channelId: string) => {
    const validation = validateIPC(EntityIdSchema, channelId, 'archive-channel');
    if (!validation.success) return validation;

    const channel = getChannelRepository().archive(validation.data);
    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    logger.info(`[IPC] Archived channel: ${channelId}`);
    return { success: true, channel };
  }));

  ipcMain.handle('unarchive-channel', ipcResult('unarchive-channel', async (_event, channelId: string) => {
    const validation = validateIPC(EntityIdSchema, channelId, 'unarchive-channel');
    if (!validation.success) return validation;

    const channel = getChannelRepository().unarchive(validation.data);
    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    logger.info(`[IPC] Unarchived channel: ${channelId}`);
    return { success: true, channel };
  }));

  ipcMain.handle('search-channels', ipcResult('search-channels', async (_event, { query, includeArchived }: SearchChannelsRequest) => {
    const validation = validateIPC(SearchChannelsSchema, { query, includeArchived }, 'search-channels');
    if (!validation.success) return validation;

    const channels = getChannelRepository().search(validation.data.query, { includeArchived: validation.data.includeArchived });
    return { success: true, channels };
  }));

  ipcMain.handle('get-channels-by-tags', ipcResult('get-channels-by-tags', async (_event, { tags, includeArchived }: GetChannelsByTagsRequest) => {
    const validation = validateIPC(GetChannelsByTagsSchema, { tags, includeArchived }, 'get-channels-by-tags');
    if (!validation.success) return validation;

    const channels = getChannelRepository().getByTags(validation.data.tags, { includeArchived: validation.data.includeArchived });
    return { success: true, channels };
  }));

  ipcMain.handle('delete-channel', ipcResult('delete-channel', async (_event, channelId: string) => {
    const validation = validateIPC(EntityIdSchema, channelId, 'delete-channel');
    if (!validation.success) return validation;

    const channelRepo = getChannelRepository();
    channelRepo.delete(validation.data);
    // Mirror ChatService.clearChatState for chats — drop the dispatcher's
    // in-memory session state and clear the persisted tool_session_states
    // row. Without this the map/rows grow without bound and a future channel
    // reusing this id (backup/restore) would inherit a stale enabled set.
    clearChannelDispatcherState(validation.data);
    getToolStateRepository().delete(validation.data);
    eventBus.emitEvent('channel:deleted', { id: validation.data });
    return { success: true };
  }));

  // User edit — also rewrites the text content block (the renderer displays
  // content_blocks when present) and broadcasts so open views update live.
  ipcMain.handle('update-message', ipcResult('update-message', async (_event, { messageId, content }: { messageId: string; content: string }) => {
    const validation = validateIPC(EditMessageSchema, { messageId, content }, 'update-message');
    if (!validation.success) return validation;

    const channelRepo = getChannelRepository();
    const result = channelRepo.updateMessageText(validation.data.messageId, validation.data.content);
    if (!result) {
      return { success: false, error: 'Message not found' };
    }

    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('message-updated', {
        messageId: validation.data.messageId,
        contentBlocks: result.contentBlocks ?? undefined,
        content: validation.data.content,
      });
    }
    return { success: true, contentBlocks: result.contentBlocks };
  }));

  ipcMain.handle('delete-message', ipcResult('delete-message', async (_event, messageId: string) => {
    const validation = validateIPC(EntityIdSchema, messageId, 'delete-message');
    if (!validation.success) return validation;

    const channelRepo = getChannelRepository();
    channelRepo.deleteMessage(validation.data);
    eventBus.emitEvent('message:deleted', { id: validation.data });
    return { success: true };
  }));

  ipcMain.handle('stop-stream', ipcResult('stop-stream', async (_event, { channelId, agentId }: { channelId?: string; agentId?: string }) => {
    const settingsRepo = getSettingsRepository();
    const currentState = settingsRepo.getCurrentState();

    const effectiveChannelId = channelId || currentState.channelId || 'global';
    const effectiveAgentId = agentId || currentState.agentId;

    if (!effectiveAgentId) {
      return { success: false, error: 'No active agent' };
    }

    const streamKey = `${effectiveChannelId}:${effectiveAgentId}`;
    const controller = activeStreamControllers.get(streamKey);

    if (controller) {
      logger.info('User requested stream stop', { streamKey });
      controller.abort();
      activeStreamControllers.delete(streamKey);
      return { success: true };
    }

    return { success: false, error: 'No active stream found' };
  }));

}
