import { ipcMain } from 'electron';
import { getAgentRepository, getChannelRepository, getSettingsRepository } from '../repositories';
import { logger } from '../services/logger';
import {
  FetchModelsSchema,
  CreateAgentIPCSchema,
  UpdateAgentIPCSchema,
  AddMCPServerSchema,
  UpdateMCPServerSchema,
  EntityIdSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { fetchModelsForProvider } from '../utils/fetchModels';
import { resolveProviderCredential } from '../utils/providerCredential';
import { eventBus } from '../services/EventBus';

export function registerAgentHandlers() {
  // Expose the registry-shaped provider list for any UI that wants to render
  // a provider picker. Hosts the plugin UIs too — character-card-import etc.
  // No credentials are returned; metadata only.
  ipcMain.handle('list-providers', ipcResult('list-providers', async () => {
    const { PROVIDERS } = await import('../../shared/providers');
    return {
      success: true,
      providers: PROVIDERS.map(p => ({
        id: p.id,
        label: p.label,
        icon: p.icon,
        description: p.description,
        needsKey: p.needsKey,
        isLocalEndpoint: !!p.isLocalEndpoint,
        docsUrl: p.docsUrl,
      })),
    };
  }));

  ipcMain.handle('fetch-models', ipcResult('fetch-models', async (_event, { provider, baseURL }: { provider: string; baseURL?: string }) => {
    const validation = validateIPC(FetchModelsSchema, { provider, baseURL }, 'fetch-models');
    if (!validation.success) return validation;
    const { provider: validProvider, baseURL: validBaseURL } = validation.data;

    // Pull credentials/URLs from settings using the provider registry — the
    // `isLocalEndpoint` flag on ProviderMeta routes the same `apiKeys[id]`
    // string to either `apiKey` (cloud providers) or `baseURL` (local).
    const { apiKey, baseURL: resolvedBaseURL } = resolveProviderCredential(validProvider, validBaseURL);

    return fetchModelsForProvider(validProvider, { apiKey, baseURL: resolvedBaseURL });
  }));

  // Read IPC for the full agent list — lets plugins/automation (and any surface
  // that isn't the boot-time getMemory hydration) see out-of-band agent
  // creations without a reload.
  ipcMain.handle('list-agents', ipcResult('list-agents', async () => {
    return { success: true, agents: getAgentRepository().getAll() };
  }));

  ipcMain.handle('create-agent', ipcResult('create-agent', async (_event, agentData) => {
    const validation = validateIPC(CreateAgentIPCSchema, agentData, 'create-agent');
    if (!validation.success) return validation;
    const validData = validation.data;

    const agentRepo = getAgentRepository();
    const channelRepo = getChannelRepository();

    // Zod .default() guarantees color/temperature are present after validation,
    // but z.infer shows them as optional. Provide fallbacks to satisfy the type.
    // Cast: validation schemas accept null for the clearable fields
    // (contextWindow / toolSendMode / promptTemplate) so the editor can wipe
    // a saved value, but the Agent type stays strict — buildUpdateFields /
    // buildInsertFields treat null as "write NULL". TS just needs the cast.
    const newAgent = agentRepo.create({
      ...validData,
      description: validData.description ?? '',
      color: validData.color ?? '#667eea',
      temperature: validData.temperature ?? 0.7,
    } as Parameters<typeof agentRepo.create>[0]);

    // Add first agent to #general channel automatically
    const channels = channelRepo.getAll({ includeMessages: false });
    const generalChannel = channels.find(c => c.name === 'general' && c.type === 'public');
    if (generalChannel && !generalChannel.participants.some(p => p.id === newAgent.id)) {
      channelRepo.addParticipant(generalChannel.id, {
        id: newAgent.id,
        type: 'agent',
        displayName: newAgent.name,
        color: newAgent.color,
        joinedAt: Date.now(),
      });
    }

    // Notify listeners (ShadowService activation, activity pipeline, renderer
    // refresh) — the standard IPC path is otherwise silent, so shadows created
    // here never activate until restart.
    eventBus.emitEvent('agent:created', { id: newAgent.id, name: newAgent.name });

    return newAgent;
  }));

  ipcMain.handle('update-agent', ipcResult('update-agent', async (_event, { agentId, updates }: { agentId: string; updates: any }) => {
    const idValidation = validateIPC(EntityIdSchema, agentId, 'update-agent');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateAgentIPCSchema, updates, 'update-agent');
    if (!updatesValidation.success) return updatesValidation;

    const agentRepo = getAgentRepository();
    // Cast: see note in create-agent above re: null for clearable columns.
    const updatedAgent = agentRepo.update(
      idValidation.data,
      updatesValidation.data as Parameters<typeof agentRepo.update>[1],
    );
    if (updatedAgent) {
      eventBus.emitEvent('agent:updated', { id: updatedAgent.id, name: updatedAgent.name });
    }
    return updatedAgent;
  }));

  ipcMain.handle('delete-agent', ipcResult('delete-agent', async (_event, agentId: string) => {
    const validation = validateIPC(EntityIdSchema, agentId, 'delete-agent');
    if (!validation.success) return validation;

    const agentRepo = getAgentRepository();
    agentRepo.delete(validation.data);
    // Let ShadowService tear down a runtime-deleted shadow's instance.
    eventBus.emitEvent('agent:deleted', { id: validation.data });
    return { success: true };
  }));

  ipcMain.handle('switch-agent', ipcResult('switch-agent', async (_event, agentId: string) => {
    const validation = validateIPC(EntityIdSchema, agentId, 'switch-agent');
    if (!validation.success) return validation;

    const settingsRepo = getSettingsRepository();
    settingsRepo.setCurrentAgent(validation.data);
    return { success: true };
  }));

  ipcMain.handle('add-mcp-server', ipcResult('add-mcp-server', async (_event, { agentId, serverData }: { agentId: string; serverData: any }) => {
    const idValidation = validateIPC(EntityIdSchema, agentId, 'add-mcp-server');
    if (!idValidation.success) return idValidation;
    const serverValidation = validateIPC(AddMCPServerSchema, serverData, 'add-mcp-server');
    if (!serverValidation.success) return serverValidation;
    const validServer = serverValidation.data;

    const agentRepo = getAgentRepository();
    const newServer = agentRepo.addMCPServer(idValidation.data, {
      name: validServer.name,
      transport: validServer.transport,
      enabled: validServer.enabled ?? true,
      config: validServer.config,
    });
    return newServer;
  }));

  ipcMain.handle('update-mcp-server', ipcResult('update-mcp-server', async (_event, { agentId, serverId, updates }: { agentId: string; serverId: string; updates: any }) => {
    const agentIdValidation = validateIPC(EntityIdSchema, agentId, 'update-mcp-server');
    if (!agentIdValidation.success) return agentIdValidation;
    const serverIdValidation = validateIPC(EntityIdSchema, serverId, 'update-mcp-server');
    if (!serverIdValidation.success) return serverIdValidation;
    const updatesValidation = validateIPC(UpdateMCPServerSchema, updates, 'update-mcp-server');
    if (!updatesValidation.success) return updatesValidation;

    const agentRepo = getAgentRepository();
    agentRepo.updateMCPServer(agentIdValidation.data, serverIdValidation.data, updatesValidation.data);
    return { success: true };
  }));

  ipcMain.handle('delete-mcp-server', ipcResult('delete-mcp-server', async (_event, { agentId, serverId }: { agentId: string; serverId: string }) => {
    const agentIdValidation = validateIPC(EntityIdSchema, agentId, 'delete-mcp-server');
    if (!agentIdValidation.success) return agentIdValidation;
    const serverIdValidation = validateIPC(EntityIdSchema, serverId, 'delete-mcp-server');
    if (!serverIdValidation.success) return serverIdValidation;

    const agentRepo = getAgentRepository();
    agentRepo.deleteMCPServer(agentIdValidation.data, serverIdValidation.data);
    return { success: true };
  }));
}
