import { AgentRepository } from './AgentRepository';
import { ProjectRepository } from './ProjectRepository';
import { ChannelRepository } from './ChannelRepository';
import { ConversationFolderRepository } from './ConversationFolderRepository';
import { SettingsRepository } from './SettingsRepository';
import { PluginStorageRepository } from './PluginStorageRepository';
import { PluginStateRepository } from './PluginStateRepository';
import { PluginGrantsRepository } from './PluginGrantsRepository';
import { UserRepository } from './UserRepository';
import { ToolApprovalGrantRepository } from './ToolApprovalGrantRepository';
import { EventRepository } from './EventRepository';
import { MilestoneRepository } from './MilestoneRepository';
import { DeadlineRepository } from './DeadlineRepository';
import { WorkflowRepository } from './WorkflowRepository';
import { RoutineRepository } from './RoutineRepository';
import { MessageAttachmentRepository } from './MessageAttachmentRepository';
import { ActivityRepository } from './ActivityRepository';
import { FileRepository } from './FileRepository';
import { AgentMemoryRepository } from './AgentMemoryRepository';
import { MemoryEntryRepository } from './MemoryEntryRepository';
import { MemoryBlockRepository } from './MemoryBlockRepository';
import { ToolStateRepository } from './ToolStateRepository';
import { TranscriptSearchRepository } from './TranscriptSearchRepository';
import { UsageEventRepository } from './UsageEventRepository';

export { AgentRepository, ProjectRepository, ChannelRepository, SettingsRepository, PluginStorageRepository, PluginStateRepository, PluginGrantsRepository, UserRepository, EventRepository, MilestoneRepository, DeadlineRepository, WorkflowRepository, RoutineRepository, MessageAttachmentRepository, ActivityRepository, FileRepository, AgentMemoryRepository, MemoryEntryRepository, MemoryBlockRepository, ToolStateRepository };

/**
 * Lazy singleton factory — creates instance on first access
 */
function createSingleton<T>(factory: () => T): () => T {
  let instance: T | null = null;
  return () => {
    if (!instance) instance = factory();
    return instance;
  };
}

export const getAgentRepository = createSingleton(() => new AgentRepository());
export const getProjectRepository = createSingleton(() => new ProjectRepository());
// ChannelRepository owns the whole conversation substrate: channels and the
// direct-channel (chat) projection. One repository, because a chat IS a
// `channels` row with type='direct' — splitting them would duplicate every
// message/participant query (see the "Direct-channel (chat) projection"
// section in ChannelRepository.ts).
export const getChannelRepository = createSingleton(() => new ChannelRepository());
export const getConversationFolderRepository = createSingleton(() => new ConversationFolderRepository());
export const getSettingsRepository = createSingleton(() => new SettingsRepository());
export const getPluginStorageRepository = createSingleton(() => new PluginStorageRepository());
export const getPluginStateRepository = createSingleton(() => new PluginStateRepository());
export const getPluginGrantsRepository = createSingleton(() => new PluginGrantsRepository());
export const getUserRepository = createSingleton(() => new UserRepository());
export const getToolApprovalGrantRepository = createSingleton(() => new ToolApprovalGrantRepository());
export const getEventRepository = createSingleton(() => new EventRepository());
export const getMilestoneRepository = createSingleton(() => new MilestoneRepository());
export const getDeadlineRepository = createSingleton(() => new DeadlineRepository());
export const getWorkflowRepository = createSingleton(() => new WorkflowRepository());
export const getRoutineRepository = createSingleton(() => new RoutineRepository());
export const getMessageAttachmentRepository = createSingleton(() => new MessageAttachmentRepository());
export const getActivityRepository = createSingleton(() => new ActivityRepository());
// The durable cost/energy ledger. Separate from ActivityRepository on
// purpose — see the v78 migration and UsageLedgerService.
export const getUsageEventRepository = createSingleton(() => new UsageEventRepository());
export const getFileRepository = createSingleton(() => new FileRepository());
export const getAgentMemoryRepository = createSingleton(() => new AgentMemoryRepository());
export const getMemoryEntryRepository = createSingleton(() => new MemoryEntryRepository());
export const getMemoryBlockRepository = createSingleton(() => new MemoryBlockRepository());
export const getToolStateRepository = createSingleton(() => new ToolStateRepository());
export const getTranscriptSearchRepository = createSingleton(() => new TranscriptSearchRepository());
