import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerAgentHandlers } from './agents';
import { logger } from '../services/logger';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock the logger
vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock repositories
vi.mock('../repositories', () => ({
  getAgentRepository: vi.fn(),
  getChannelRepository: vi.fn(),
  getSettingsRepository: vi.fn(),
}));

// Import mocked repositories
import { getAgentRepository, getChannelRepository, getSettingsRepository } from '../repositories';

describe('Agent IPC Handlers', () => {
  let mockAgentRepo: {
    create: Mock;
    update: Mock;
    delete: Mock;
    addMCPServer: Mock;
    updateMCPServer: Mock;
    deleteMCPServer: Mock;
  };
  let mockChannelRepo: {
    getAll: Mock;
    addParticipant: Mock;
  };
  let mockSettingsRepo: {
    get: Mock;
    setCurrentAgent: Mock;
  };
  let handlers: Map<string, Function>;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create mock repository instances
    mockAgentRepo = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      addMCPServer: vi.fn(),
      updateMCPServer: vi.fn(),
      deleteMCPServer: vi.fn(),
    };

    mockChannelRepo = {
      getAll: vi.fn(),
      addParticipant: vi.fn(),
    };

    mockSettingsRepo = {
      get: vi.fn(),
      setCurrentAgent: vi.fn(),
    };

    // Setup repository getters
    (getAgentRepository as Mock).mockReturnValue(mockAgentRepo);
    (getChannelRepository as Mock).mockReturnValue(mockChannelRepo);
    (getSettingsRepository as Mock).mockReturnValue(mockSettingsRepo);

    // Capture handlers registered via ipcMain.handle
    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    // Register handlers
    registerAgentHandlers();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('fetch-models', () => {
    it('should fetch models from OpenAI with valid API key', async () => {
      const handler = handlers.get('fetch-models')!;
      expect(handler).toBeDefined();

      mockSettingsRepo.get.mockReturnValue({
        apiKeys: { openai: 'sk-test-key' },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }] }),
      });

      const result = await handler({}, { provider: 'openai' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['gpt-4', 'gpt-3.5-turbo']);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key',
          }),
        })
      );
    });

    it('should fetch models from LM Studio', async () => {
      const handler = handlers.get('fetch-models')!;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'local-model-1' }, { id: 'local-model-2' }] }),
      });

      const result = await handler({}, { provider: 'lmstudio', baseURL: 'http://localhost:1234/v1' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['local-model-1', 'local-model-2']);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/models',
        expect.any(Object)
      );
    });

    it('should fetch models from Ollama', async () => {
      const handler = handlers.get('fetch-models')!;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'llama2' }, { name: 'mistral' }] }),
      });

      const result = await handler({}, { provider: 'ollama', baseURL: 'http://localhost:11434' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['llama2', 'mistral']);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
      );
    });

    it('should return error when OpenAI API key is missing', async () => {
      const handler = handlers.get('fetch-models')!;

      mockSettingsRepo.get.mockReturnValue({
        apiKeys: { openai: '' },
      });

      const result = await handler({}, { provider: 'openai' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('OpenAI API key not configured');
    });

    it('should handle HTTP errors from model endpoint', async () => {
      const handler = handlers.get('fetch-models')!;

      mockSettingsRepo.get.mockReturnValue({
        apiKeys: { openai: 'sk-test-key' },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const result = await handler({}, { provider: 'openai' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 401');
    });

    it('should handle network errors', async () => {
      const handler = handlers.get('fetch-models')!;

      mockSettingsRepo.get.mockReturnValue({
        apiKeys: { openai: 'sk-test-key' },
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await handler({}, { provider: 'openai' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should reject invalid provider', async () => {
      const handler = handlers.get('fetch-models')!;

      const result = await handler({}, { provider: 'invalid-provider' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject missing provider', async () => {
      const handler = handlers.get('fetch-models')!;

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle invalid baseURL', async () => {
      const handler = handlers.get('fetch-models')!;

      const result = await handler({}, { provider: 'lmstudio', baseURL: 'not-a-valid-url' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should normalize LM Studio URL without trailing /v1', async () => {
      const handler = handlers.get('fetch-models')!;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await handler({}, { provider: 'lmstudio', baseURL: 'http://localhost:1234' });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/models',
        expect.any(Object)
      );
    });

    it('should fetch models from Anthropic with valid API key', async () => {
      const handler = handlers.get('fetch-models')!;

      mockSettingsRepo.get.mockReturnValue({
        apiKeys: { anthropic: 'sk-ant-test' },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'claude-opus-4-5' }, { id: 'claude-sonnet-4-5' }],
        }),
      });

      const result = await handler({}, { provider: 'anthropic' });

      expect(result.success).toBe(true);
      expect(result.models).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models?limit=100',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-test',
            'anthropic-version': '2023-06-01',
          }),
        })
      );
    });

    it('should return error when Anthropic API key is missing', async () => {
      const handler = handlers.get('fetch-models')!;

      mockSettingsRepo.get.mockReturnValue({
        apiKeys: { anthropic: '' },
      });

      const result = await handler({}, { provider: 'anthropic' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Anthropic API key not configured');
    });
  });

  describe('create-agent', () => {
    it('should create agent with valid data', async () => {
      const handler = handlers.get('create-agent')!;
      expect(handler).toBeDefined();

      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        description: 'A test agent',
        systemPrompt: 'You are a helpful assistant',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.create.mockReturnValue(mockAgent);
      mockChannelRepo.getAll.mockReturnValue([]);

      const result = await handler({}, {
        name: 'Test Agent',
        description: 'A test agent',
        systemPrompt: 'You are a helpful assistant',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
      });

      expect(result).toEqual(mockAgent);
      expect(mockAgentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Agent',
          description: 'A test agent',
          provider: 'anthropic',
        })
      );
    });

    it('should add first agent to #general channel', async () => {
      const handler = handlers.get('create-agent')!;

      const mockAgent = {
        id: 'agent-1',
        name: 'First Agent',
        description: 'First agent',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.create.mockReturnValue(mockAgent);
      mockChannelRepo.getAll.mockReturnValue([
        {
          id: 'general',
          name: 'general',
          type: 'public',
          participants: [],
          messages: [],
          createdAt: Date.now(),
        },
      ]);

      await handler({}, {
        name: 'First Agent',
        description: 'First agent',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(mockChannelRepo.addParticipant).toHaveBeenCalledWith(
        'general',
        expect.objectContaining({
          id: 'agent-1',
          type: 'agent',
          displayName: 'First Agent',
        })
      );
    });

    it('should not add agent to #general if already present', async () => {
      const handler = handlers.get('create-agent')!;

      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        description: 'Test',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.create.mockReturnValue(mockAgent);
      mockChannelRepo.getAll.mockReturnValue([
        {
          id: 'general',
          name: 'general',
          type: 'public',
          participants: [{ id: 'agent-1', type: 'agent', displayName: 'Test Agent', joinedAt: Date.now() }],
          messages: [],
          createdAt: Date.now(),
        },
      ]);

      await handler({}, {
        name: 'Test Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(mockChannelRepo.addParticipant).not.toHaveBeenCalled();
    });

    it('should reject invalid agent name (empty)', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: '',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.create).not.toHaveBeenCalled();
    });

    it('should reject invalid agent name (too long)', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'A'.repeat(101),
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should accept empty description (defaults to "")', async () => {
      const handler = handlers.get('create-agent')!;

      mockAgentRepo.create.mockReturnValue({
        id: 'agent-empty-desc',
        name: 'Test Agent',
        description: '',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        createdAt: Date.now(),
        mcpServers: [],
      });
      mockChannelRepo.getAll.mockReturnValue([]);

      const result = await handler({}, {
        name: 'Test Agent',
        description: '',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(result.success).not.toBe(false);
      expect(mockAgentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: '' })
      );
    });

    it('should reject invalid description (too long)', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'Test Agent',
        description: 'A'.repeat(501),
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid provider', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'Test Agent',
        description: 'Test',
        provider: 'invalid-provider',
        model: 'some-model',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid temperature (too low)', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'Test Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: -0.1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid temperature (too high)', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'Test Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 2.1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid color format', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'Test Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        color: 'not-a-hex-color',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid maxSteps (exceeds limit)', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'Test Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        maxSteps: 51,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should apply default values for optional fields', async () => {
      const handler = handlers.get('create-agent')!;

      const mockAgent = {
        id: 'agent-1',
        name: 'Minimal Agent',
        description: 'Minimal',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.create.mockReturnValue(mockAgent);
      mockChannelRepo.getAll.mockReturnValue([]);

      await handler({}, {
        name: 'Minimal Agent',
        description: 'Minimal',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(mockAgentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7,
          color: '#667eea',
        })
      );
    });

    it('should handle missing required fields', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: 'Test Agent',
        // Missing description
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('update-agent', () => {
    it('should update agent with valid data', async () => {
      const handler = handlers.get('update-agent')!;
      expect(handler).toBeDefined();

      const mockUpdatedAgent = {
        id: 'agent-1',
        name: 'Updated Agent',
        description: 'Updated description',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.8,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.update.mockReturnValue(mockUpdatedAgent);

      const result = await handler({}, { agentId: 'agent-1', updates: {
        name: 'Updated Agent',
        description: 'Updated description',
        temperature: 0.8,
      }});

      expect(result).toEqual(mockUpdatedAgent);
      expect(mockAgentRepo.update).toHaveBeenCalledWith('agent-1', {
        name: 'Updated Agent',
        description: 'Updated description',
        temperature: 0.8,
      });
    });

    it('should reject invalid agentId', async () => {
      const handler = handlers.get('update-agent')!;

      const result = await handler({}, { agentId: '', updates: { name: 'Updated' } });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.update).not.toHaveBeenCalled();
    });

    it('should reject invalid update fields', async () => {
      const handler = handlers.get('update-agent')!;

      const result = await handler({}, { agentId: 'agent-1', updates: {
        name: '', // Invalid empty name
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid temperature in updates', async () => {
      const handler = handlers.get('update-agent')!;

      const result = await handler({}, { agentId: 'agent-1', updates: {
        temperature: 3.0,
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should accept archetype: null to clear it (regression)', async () => {
      const handler = handlers.get('update-agent')!;

      const mockUpdatedAgent = {
        id: 'agent-1',
        name: 'Agent',
        description: '',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };
      mockAgentRepo.update.mockReturnValue(mockUpdatedAgent);

      // Before the fix this failed Zod with "Expected object, received null".
      const result = await handler({}, { agentId: 'agent-1', updates: { archetype: null } });

      expect(result.success).not.toBe(false);
      expect(mockAgentRepo.update).toHaveBeenCalledWith('agent-1', { archetype: null });
    });

    it('should allow partial updates', async () => {
      const handler = handlers.get('update-agent')!;

      const mockUpdatedAgent = {
        id: 'agent-1',
        name: 'Agent',
        description: 'Updated description only',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.update.mockReturnValue(mockUpdatedAgent);

      await handler({}, { agentId: 'agent-1', updates: {
        description: 'Updated description only',
      }});

      expect(mockAgentRepo.update).toHaveBeenCalledWith('agent-1', {
        description: 'Updated description only',
      });
    });

    it('should handle repository returning null (agent not found)', async () => {
      const handler = handlers.get('update-agent')!;

      mockAgentRepo.update.mockReturnValue(null);

      const result = await handler({}, { agentId: 'non-existent', updates: { name: 'Updated' } });

      expect(result).toBeNull();
    });

    it('should reject invalid color in updates', async () => {
      const handler = handlers.get('update-agent')!;

      const result = await handler({}, { agentId: 'agent-1', updates: {
        color: 'invalid-color',
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle very long agentId', async () => {
      const handler = handlers.get('update-agent')!;

      const longId = 'A'.repeat(101);
      const result = await handler({}, { agentId: longId, updates: { name: 'Updated' } });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('delete-agent', () => {
    it('should delete agent with valid ID', async () => {
      const handler = handlers.get('delete-agent')!;
      expect(handler).toBeDefined();

      mockAgentRepo.delete.mockReturnValue(true);

      const result = await handler({}, 'agent-1');

      expect(result).toEqual({ success: true });
      expect(mockAgentRepo.delete).toHaveBeenCalledWith('agent-1');
    });

    it('should reject invalid agentId (empty)', async () => {
      const handler = handlers.get('delete-agent')!;

      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.delete).not.toHaveBeenCalled();
    });

    it('should reject invalid agentId (too long)', async () => {
      const handler = handlers.get('delete-agent')!;

      const result = await handler({}, 'A'.repeat(101));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle repository returning false (agent not found)', async () => {
      const handler = handlers.get('delete-agent')!;

      mockAgentRepo.delete.mockReturnValue(false);

      const result = await handler({}, 'non-existent');

      expect(result).toEqual({ success: true }); // Handler still returns success
      expect(mockAgentRepo.delete).toHaveBeenCalledWith('non-existent');
    });
  });

  describe('switch-agent', () => {
    it('should switch to agent with valid ID', async () => {
      const handler = handlers.get('switch-agent')!;
      expect(handler).toBeDefined();

      mockSettingsRepo.setCurrentAgent.mockReturnValue(undefined);

      const result = await handler({}, 'agent-1');

      expect(result).toEqual({ success: true });
      expect(mockSettingsRepo.setCurrentAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should reject invalid agentId (empty)', async () => {
      const handler = handlers.get('switch-agent')!;

      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockSettingsRepo.setCurrentAgent).not.toHaveBeenCalled();
    });

    it('should reject invalid agentId (too long)', async () => {
      const handler = handlers.get('switch-agent')!;

      const result = await handler({}, 'A'.repeat(101));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('add-mcp-server', () => {
    it('should add MCP server with valid data (stdio)', async () => {
      const handler = handlers.get('add-mcp-server')!;
      expect(handler).toBeDefined();

      const mockServer = {
        id: 'server-1',
        name: 'Test Server',
        transport: 'stdio' as const,
        enabled: true,
        config: {
          command: 'node',
          args: ['server.js'],
        },
      };

      mockAgentRepo.addMCPServer.mockReturnValue(mockServer);

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Test Server',
        transport: 'stdio',
        enabled: true,
        config: {
          command: 'node',
          args: ['server.js'],
        },
      }});

      expect(result).toEqual(mockServer);
      expect(mockAgentRepo.addMCPServer).toHaveBeenCalledWith('agent-1', {
        name: 'Test Server',
        transport: 'stdio',
        enabled: true,
        config: {
          command: 'node',
          args: ['server.js'],
        },
      });
    });

    it('should add MCP server with valid data (http)', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const mockServer = {
        id: 'server-2',
        name: 'HTTP Server',
        transport: 'http' as const,
        enabled: true,
        config: {
          url: 'http://localhost:3000',
        },
      };

      mockAgentRepo.addMCPServer.mockReturnValue(mockServer);

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'HTTP Server',
        transport: 'http',
        config: {
          url: 'http://localhost:3000',
        },
      }});

      expect(result).toEqual(mockServer);
    });

    it('should reject invalid agentId', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: '', serverData: {
        name: 'Test Server',
        transport: 'stdio',
        config: { command: 'node' },
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.addMCPServer).not.toHaveBeenCalled();
    });

    it('should reject invalid server name (empty)', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: '',
        transport: 'stdio',
        config: { command: 'node' },
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid server name (too long)', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'A'.repeat(101),
        transport: 'stdio',
        config: { command: 'node' },
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid transport type', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Test Server',
        transport: 'invalid-transport',
        config: {},
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject stdio transport without command', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Test Server',
        transport: 'stdio',
        config: {},
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject http transport without URL', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Test Server',
        transport: 'http',
        config: {},
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject sse transport without URL', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Test Server',
        transport: 'sse',
        config: {},
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid URL format', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Test Server',
        transport: 'http',
        config: {
          url: 'not-a-valid-url',
        },
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should apply default enabled value', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const mockServer = {
        id: 'server-1',
        name: 'Test Server',
        transport: 'stdio' as const,
        enabled: true,
        config: { command: 'node' },
      };

      mockAgentRepo.addMCPServer.mockReturnValue(mockServer);

      await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Test Server',
        transport: 'stdio',
        config: { command: 'node' },
      }});

      expect(mockAgentRepo.addMCPServer).toHaveBeenCalledWith('agent-1', {
        name: 'Test Server',
        transport: 'stdio',
        enabled: true,
        config: { command: 'node' },
      });
    });
  });

  describe('update-mcp-server', () => {
    it('should update MCP server with valid data', async () => {
      const handler = handlers.get('update-mcp-server')!;
      expect(handler).toBeDefined();

      mockAgentRepo.updateMCPServer.mockReturnValue(undefined);

      const result = await handler({}, { agentId: 'agent-1', serverId: 'server-1', updates: {
        name: 'Updated Server',
        enabled: false,
      }});

      expect(result).toEqual({ success: true });
      expect(mockAgentRepo.updateMCPServer).toHaveBeenCalledWith('agent-1', 'server-1', {
        name: 'Updated Server',
        enabled: false,
      });
    });

    it('should reject invalid agentId', async () => {
      const handler = handlers.get('update-mcp-server')!;

      const result = await handler({}, { agentId: '', serverId: 'server-1', updates: { name: 'Updated' } });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.updateMCPServer).not.toHaveBeenCalled();
    });

    it('should reject invalid serverId', async () => {
      const handler = handlers.get('update-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverId: '', updates: { name: 'Updated' } });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.updateMCPServer).not.toHaveBeenCalled();
    });

    it('should reject invalid server name', async () => {
      const handler = handlers.get('update-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverId: 'server-1', updates: {
        name: '',
      }});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should allow partial config updates', async () => {
      const handler = handlers.get('update-mcp-server')!;

      mockAgentRepo.updateMCPServer.mockReturnValue(undefined);

      await handler({}, { agentId: 'agent-1', serverId: 'server-1', updates: {
        config: { command: 'updated-command' },
      }});

      expect(mockAgentRepo.updateMCPServer).toHaveBeenCalledWith('agent-1', 'server-1', {
        config: { command: 'updated-command' },
      });
    });

    it('should handle empty updates', async () => {
      const handler = handlers.get('update-mcp-server')!;

      mockAgentRepo.updateMCPServer.mockReturnValue(undefined);

      const result = await handler({}, { agentId: 'agent-1', serverId: 'server-1', updates: {} });

      expect(result).toEqual({ success: true });
    });
  });

  describe('delete-mcp-server', () => {
    it('should delete MCP server with valid IDs', async () => {
      const handler = handlers.get('delete-mcp-server')!;
      expect(handler).toBeDefined();

      mockAgentRepo.deleteMCPServer.mockReturnValue(true);

      const result = await handler({}, { agentId: 'agent-1', serverId: 'server-1' });

      expect(result).toEqual({ success: true });
      expect(mockAgentRepo.deleteMCPServer).toHaveBeenCalledWith('agent-1', 'server-1');
    });

    it('should reject invalid agentId', async () => {
      const handler = handlers.get('delete-mcp-server')!;

      const result = await handler({}, { agentId: '', serverId: 'server-1' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.deleteMCPServer).not.toHaveBeenCalled();
    });

    it('should reject invalid serverId', async () => {
      const handler = handlers.get('delete-mcp-server')!;

      const result = await handler({}, { agentId: 'agent-1', serverId: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockAgentRepo.deleteMCPServer).not.toHaveBeenCalled();
    });

    it('should handle repository returning false (server not found)', async () => {
      const handler = handlers.get('delete-mcp-server')!;

      mockAgentRepo.deleteMCPServer.mockReturnValue(false);

      const result = await handler({}, { agentId: 'agent-1', serverId: 'non-existent' });

      expect(result).toEqual({ success: true }); // Handler still returns success
    });
  });

  describe('Edge cases and error handling', () => {
    it('should log validation failures', async () => {
      const handler = handlers.get('create-agent')!;

      await handler({}, { name: '', description: 'Test' });

      expect(logger.warn).toHaveBeenCalledWith(
        '[IPC] create-agent validation failed:',
        expect.any(String)
      );
    });

    it('should handle special characters in agent names', async () => {
      const handler = handlers.get('create-agent')!;

      const mockAgent = {
        id: 'agent-1',
        name: "Agent's \"Special\" Name",
        description: 'Test',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.create.mockReturnValue(mockAgent);
      mockChannelRepo.getAll.mockReturnValue([]);

      await handler({}, {
        name: "Agent's \"Special\" Name",
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(mockAgentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Agent's \"Special\" Name",
        })
      );
    });

    it('should handle Unicode characters in agent names', async () => {
      const handler = handlers.get('create-agent')!;

      const mockAgent = {
        id: 'agent-1',
        name: 'Agent 🤖 with emoji',
        description: 'Test',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.create.mockReturnValue(mockAgent);
      mockChannelRepo.getAll.mockReturnValue([]);

      await handler({}, {
        name: 'Agent 🤖 with emoji',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(mockAgentRepo.create).toHaveBeenCalled();
    });

    it('should handle whitespace in agent names', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: '   ',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should trim whitespace from agent names', async () => {
      const handler = handlers.get('create-agent')!;

      const mockAgent = {
        id: 'agent-1',
        name: 'Trimmed Agent',
        description: 'Test',
        provider: 'anthropic' as const,
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
        mcpServers: [],
        createdAt: Date.now(),
      };

      mockAgentRepo.create.mockReturnValue(mockAgent);
      mockChannelRepo.getAll.mockReturnValue([]);

      await handler({}, {
        name: '  Trimmed Agent  ',
        description: '  Test  ',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(mockAgentRepo.create).toHaveBeenCalled();
    });

    it('should handle null and undefined values gracefully', async () => {
      const handler = handlers.get('create-agent')!;

      const result = await handler({}, {
        name: null,
        description: undefined,
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle MCP server with env variables', async () => {
      const handler = handlers.get('add-mcp-server')!;

      const mockServer = {
        id: 'server-1',
        name: 'Server with Env',
        transport: 'stdio' as const,
        enabled: true,
        config: {
          command: 'node',
          env: { VAR1: 'value1', VAR2: 'value2' },
        },
      };

      mockAgentRepo.addMCPServer.mockReturnValue(mockServer);

      await handler({}, { agentId: 'agent-1', serverData: {
        name: 'Server with Env',
        transport: 'stdio',
        config: {
          command: 'node',
          env: { VAR1: 'value1', VAR2: 'value2' },
        },
      }});

      expect(mockAgentRepo.addMCPServer).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          config: expect.objectContaining({
            env: { VAR1: 'value1', VAR2: 'value2' },
          }),
        })
      );
    });
  });
});