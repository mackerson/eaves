import { AppState } from '../types';
import { getDatabase } from './database';
import {
  getSettingsRepository,
  getAgentRepository,
  getProjectRepository,
  getChannelRepository,
  getUserRepository
} from '../repositories';

// Initialize database
export function initializeAppState(): void {
  // Initialize SQLite database (creates tables if needed)
  getDatabase();

  // Self-heal any pre-fix drift where the current user's name lags the
  // settings name (message attribution showing "User" while the system prompt
  // says the real name). No-op once they agree; skipped for multi-user setups.
  getSettingsRepository().reconcileCurrentUserName();
}

// Load complete app state from SQLite
export function loadAppState(): AppState {
  const settingsRepo = getSettingsRepository();
  const agentRepo = getAgentRepository();
  const projectRepo = getProjectRepository();
  const channelRepo = getChannelRepository();
  const userRepo = getUserRepository();

  const settings = settingsRepo.get();
  const users = userRepo.getAll();
  const agents = agentRepo.getAll();
  const projects = projectRepo.getAll();
  const channels = channelRepo.getAll(); // Now defaults to includeMessages: false for performance
  const currentState = settingsRepo.getCurrentState();

  // Load messages only for the current channel with a reasonable limit
  if (currentState.channelId) {
    const currentChannel = channels.find(c => c.id === currentState.channelId);
    if (currentChannel) {
      // Load last 100 messages for the current channel
      currentChannel.messages = channelRepo.getMessagesByChannelId(currentState.channelId, 100);
    }
  }

  // Get current user
  const currentUser = userRepo.getCurrent();

  return {
    settings,
    users,
    agents,
    projects,
    channels,
    currentProjectId: currentState.projectId,
    currentAgentId: currentState.agentId,
    currentChannelId: currentState.channelId,
    currentUserId: currentUser?.id || null,
  };
}
