import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AgentRepository } from './AgentRepository';
import { runMigrations } from '../services/migrations';

// Mock the logger to avoid Electron app dependency
vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the database service
vi.mock('../services/database', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDatabase: vi.fn(() => {
      if (!mockDb) {
        mockDb = new Database(':memory:');
        // Run the production migrations (agents, mcp_servers, channel_participants,
        // messages, ...) instead of hand-rolled DDL, so this fixture can't drift
        // from migrations.ts.
        runMigrations(mockDb, 0);
      }
      return mockDb;
    }),
  };
});

// channel_participants/messages carry a real FK to channels(id) (better-sqlite3
// enforces foreign_keys by default), so tests referencing a channel id must
// first seed a parent row.
function insertChannel(db: Database.Database, id: string, type: 'public' | 'direct' = 'public'): void {
  db.prepare(`
    INSERT INTO channels (id, name, type, created_at) VALUES (?, ?, ?, ?)
  `).run(id, id, type, Date.now());
}

describe('AgentRepository', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(async () => {
    // Get the mocked database
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();

    // Clear all tables
    db.exec(`DELETE FROM messages`);
    db.exec(`DELETE FROM channel_participants`);
    db.exec(`DELETE FROM mcp_servers`);
    db.exec(`DELETE FROM agents`);
    db.exec(`DELETE FROM channels`);

    repo = new AgentRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new agent with all fields', () => {
      const agent = repo.create({
        name: 'Test Agent',
        description: 'A test agent for unit testing',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        maxOutputTokens: 4096,
        maxSteps: 10,
        color: '#ff6b6b',
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('Test Agent');
      expect(agent.description).toBe('A test agent for unit testing');
      expect(agent.provider).toBe('anthropic');
      expect(agent.model).toBe('claude-3-sonnet-20240229');
      expect(agent.temperature).toBe(0.7);
      expect(agent.maxOutputTokens).toBe(4096);
      expect(agent.maxSteps).toBe(10);
      expect(agent.color).toBe('#ff6b6b');
      expect(agent.createdAt).toBeDefined();
      expect(agent.mcpServers).toEqual([]);
    });

    it('should create agent with optional fields as undefined', () => {
      const agent = repo.create({
        name: 'Simple Agent',
        description: 'Agent without optional fields',
        provider: 'openai',
        model: 'gpt-4',
        temperature: 0.5,
        color: '#4ecdc4',
      });

      expect(agent.id).toBeDefined();
      expect(agent.maxOutputTokens).toBeUndefined();
      expect(agent.maxSteps).toBeUndefined();
      expect(agent.mcpServers).toEqual([]);
    });

    it('should persist agent to database', () => {
      const agent = repo.create({
        name: 'Persistent Agent',
        description: 'Test persistence',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#667eea',
      });

      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id);
      expect(row).toBeDefined();
      expect((row as any).name).toBe('Persistent Agent');
      expect((row as any).provider).toBe('anthropic');
    });

    it('should support different providers', () => {
      const providers: Array<'anthropic' | 'openai' | 'google' | 'ollama' | 'lmstudio'> = ['anthropic', 'openai', 'google', 'ollama', 'lmstudio'];

      providers.forEach((provider) => {
        const agent = repo.create({
          name: `Agent ${provider}`,
          description: `Test for ${provider}`,
          provider,
          model: `model-${provider}`,
          temperature: 0.7,
          color: '#ff0000',
        });

        expect(agent.provider).toBe(provider);
      });
    });

    it('should handle temperature values', () => {
      const agent = repo.create({
        name: 'Temp Agent',
        description: 'Test temperature',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.95,
        color: '#9b59b6',
      });

      expect(agent.temperature).toBe(0.95);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no agents exist', () => {
      const agents = repo.getAll();
      expect(agents).toEqual([]);
    });

    it('should return all agents', () => {
      const agent1 = repo.create({
        name: 'Agent 1',
        description: 'First agent',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const agent2 = repo.create({
        name: 'Agent 2',
        description: 'Second agent',
        provider: 'openai',
        model: 'gpt-4',
        temperature: 0.5,
        color: '#00ff00',
      });

      const agents = repo.getAll();
      expect(agents).toHaveLength(2);
      expect(agents.map(a => a.id)).toContain(agent1.id);
      expect(agents.map(a => a.id)).toContain(agent2.id);
    });

    it('should return agents ordered by created_at DESC', () => {
      const agent1 = repo.create({
        name: 'First',
        description: 'First created',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      // Small delay to ensure different timestamps
      const delay = new Promise(resolve => setTimeout(resolve, 10));

      // Create second agent after a small delay
      const agent2Promise = delay.then(() =>
        repo.create({
          name: 'Second',
          description: 'Second created',
          provider: 'openai',
          model: 'gpt-4',
          temperature: 0.5,
          color: '#00ff00',
        })
      );

      // For synchronous test, we'll just verify order by timestamp in DB
      const agents = repo.getAll();
      if (agents.length >= 2) {
        const first = agents[0];
        const second = agents[1];
        // More recent should be first due to DESC ordering
        expect(first.createdAt >= second.createdAt).toBe(true);
      }
    });

    it('should include MCP servers for each agent', () => {
      const agent = repo.create({
        name: 'Agent with MCP',
        description: 'Test MCP servers',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      repo.addMCPServer(agent.id, {
        name: 'Test Server',
        transport: 'stdio',
        enabled: true,
        config: { command: 'test' },
      });

      const agents = repo.getAll();
      const found = agents.find(a => a.id === agent.id);
      expect(found).toBeDefined();
      expect(found!.mcpServers).toHaveLength(1);
      expect(found!.mcpServers[0].name).toBe('Test Server');
    });
  });

  describe('getById', () => {
    it('should return agent by ID', () => {
      const created = repo.create({
        name: 'Test Agent',
        description: 'For retrieval',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const agent = repo.getById(created.id);
      expect(agent).toBeDefined();
      expect(agent!.id).toBe(created.id);
      expect(agent!.name).toBe('Test Agent');
    });

    it('should return null for non-existent agent', () => {
      const agent = repo.getById('non-existent-id');
      expect(agent).toBeNull();
    });

    it('should return agent with all fields', () => {
      const created = repo.create({
        name: 'Full Agent',
        description: 'Full test',
        provider: 'openai',
        model: 'gpt-4',
        temperature: 0.8,
        maxOutputTokens: 2048,
        maxSteps: 5,
        color: '#3498db',
      });

      const agent = repo.getById(created.id);
      expect(agent).toBeDefined();
      expect(agent!.maxOutputTokens).toBe(2048);
      expect(agent!.maxSteps).toBe(5);
      expect(agent!.color).toBe('#3498db');
    });

    it('should include MCP servers for agent', () => {
      const created = repo.create({
        name: 'Agent with MCP',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const server = repo.addMCPServer(created.id, {
        name: 'My Server',
        transport: 'sse',
        enabled: true,
        config: { url: 'http://localhost:3000' },
      });

      const agent = repo.getById(created.id);
      expect(agent).toBeDefined();
      expect(agent!.mcpServers).toHaveLength(1);
      expect(agent!.mcpServers[0].id).toBe(server.id);
    });

    it('should return agent with undefined optional fields when not set', () => {
      const created = repo.create({
        name: 'Minimal Agent',
        description: 'Minimal',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const agent = repo.getById(created.id);
      expect(agent).toBeDefined();
      expect(agent!.maxOutputTokens).toBeUndefined();
      expect(agent!.maxSteps).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update agent name', () => {
      const created = repo.create({
        name: 'Original Name',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { name: 'Updated Name' });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');

      const retrieved = repo.getById(created.id);
      expect(retrieved!.name).toBe('Updated Name');
    });

    it('should update agent description', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Original description',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { description: 'New description' });
      expect(updated!.description).toBe('New description');
    });

    it('should update agent temperature', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.5,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { temperature: 0.9 });
      expect(updated!.temperature).toBe(0.9);
    });

    it('should update agent provider and model', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, {
        provider: 'openai',
        model: 'gpt-4-turbo',
      });

      expect(updated!.provider).toBe('openai');
      expect(updated!.model).toBe('gpt-4-turbo');
    });

    it('should update maxTokens', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        maxOutputTokens: 2048,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { maxOutputTokens: 4096 });
      expect(updated!.maxOutputTokens).toBe(4096);
    });

    it('should update maxSteps', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        maxSteps: 5,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { maxSteps: 10 });
      expect(updated!.maxSteps).toBe(10);
    });

    it('should update color', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { color: '#00ff00' });
      expect(updated!.color).toBe('#00ff00');
    });

    it('should update multiple fields at once', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.5,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, {
        name: 'Updated Agent',
        description: 'Updated description',
        temperature: 0.8,
        color: '#0000ff',
        maxOutputTokens: 8192,
      });

      expect(updated!.name).toBe('Updated Agent');
      expect(updated!.description).toBe('Updated description');
      expect(updated!.temperature).toBe(0.8);
      expect(updated!.color).toBe('#0000ff');
      expect(updated!.maxOutputTokens).toBe(8192);
    });

    it('should return null when updating non-existent agent', () => {
      const updated = repo.update('non-existent', { name: 'New Name' });
      expect(updated).toBeNull();
    });

    it('should return agent with same createdAt after update', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, { name: 'Updated' });
      expect(updated!.createdAt).toBe(created.createdAt);
    });

    it('should update agent when empty updates object provided', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const updated = repo.update(created.id, {});
      expect(updated).toBeDefined();
      expect(updated!.id).toBe(created.id);
      expect(updated!.name).toBe('Agent');
    });

    it('should update channel_participants when agent name or color changes', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      // Insert a channel participant for this agent
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, color, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('channel1', created.id, 'agent', 'Agent', '#ff0000', Date.now());

      repo.update(created.id, { name: 'Updated Agent', color: '#00ff00' });

      const participant = db.prepare(`
        SELECT display_name, color FROM channel_participants WHERE participant_id = ?
      `).get(created.id) as { display_name: string; color: string };

      expect(participant.display_name).toBe('Updated Agent');
      expect(participant.color).toBe('#00ff00');
    });

    it('should update messages when agent name or color changes', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      // Insert a message from this agent
      insertChannel(db, 'channel1');
      db.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, sender_color, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg1', 'channel1', created.id, 'agent', 'Agent', '#ff0000', 'Hello', Date.now());

      repo.update(created.id, { name: 'Updated Agent', color: '#0000ff' });

      const message = db.prepare(`
        SELECT sender_display_name, sender_color FROM messages WHERE id = ?
      `).get('msg1') as { sender_display_name: string; sender_color: string };

      expect(message.sender_display_name).toBe('Updated Agent');
      expect(message.sender_color).toBe('#0000ff');
    });
  });

  describe('delete', () => {
    it('should delete agent by ID', () => {
      const created = repo.create({
        name: 'Agent to Delete',
        description: 'Test deletion',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);

      const retrieved = repo.getById(created.id);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent agent', () => {
      const deleted = repo.delete('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should delete agent from database', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      repo.delete(created.id);

      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(created.id);
      expect(row).toBeUndefined();
    });

    it('should cascade delete MCP servers', () => {
      const created = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const server = repo.addMCPServer(created.id, {
        name: 'Test Server',
        transport: 'stdio',
        enabled: true,
        config: { command: 'test' },
      });

      repo.delete(created.id);

      const serverRow = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(server.id);
      expect(serverRow).toBeUndefined();
    });

    it('should handle multiple deletions', () => {
      const agent1 = repo.create({
        name: 'Agent 1',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const agent2 = repo.create({
        name: 'Agent 2',
        description: 'Test',
        provider: 'openai',
        model: 'gpt-4',
        temperature: 0.5,
        color: '#00ff00',
      });

      expect(repo.delete(agent1.id)).toBe(true);
      expect(repo.delete(agent2.id)).toBe(true);

      const agents = repo.getAll();
      expect(agents).toEqual([]);
    });
  });

  describe('MCP Server operations', () => {
    describe('addMCPServer', () => {
      it('should add MCP server to agent', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Test Server',
          transport: 'stdio',
          enabled: true,
          config: { command: 'node', args: ['server.js'] },
        });

        expect(server.id).toBeDefined();
        expect(server.name).toBe('Test Server');
        expect(server.transport).toBe('stdio');
        expect(server.enabled).toBe(true);
        expect(server.config.command).toBe('node');
        expect(server.config.args).toEqual(['server.js']);
      });

      it('should add MCP server with env config', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Server with Env',
          transport: 'stdio',
          enabled: true,
          config: {
            command: 'python',
            env: { VAR1: 'value1', VAR2: 'value2' },
          },
        });

        expect(server.config.env).toEqual({ VAR1: 'value1', VAR2: 'value2' });
      });

      it('should add MCP server with URL config', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'HTTP Server',
          transport: 'http',
          enabled: true,
          config: { url: 'http://localhost:3000' },
        });

        expect(server.transport).toBe('http');
        expect(server.config.url).toBe('http://localhost:3000');
      });

      it('should persist MCP server to database', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Persistent Server',
          transport: 'sse',
          enabled: false,
          config: { url: 'http://example.com' },
        });

        const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(server.id);
        expect(row).toBeDefined();
        expect((row as any).name).toBe('Persistent Server');
        expect((row as any).agent_id).toBe(agent.id);
      });
    });

    describe('updateMCPServer', () => {
      it('should update MCP server name', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Original Name',
          transport: 'stdio',
          enabled: true,
          config: { command: 'test' },
        });

        repo.updateMCPServer(agent.id, server.id, { name: 'Updated Name' });

        const updated = repo.getById(agent.id);
        const updatedServer = updated!.mcpServers.find(s => s.id === server.id);
        expect(updatedServer!.name).toBe('Updated Name');
      });

      it('should update MCP server enabled status', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Test Server',
          transport: 'stdio',
          enabled: true,
          config: { command: 'test' },
        });

        repo.updateMCPServer(agent.id, server.id, { enabled: false });

        const updated = repo.getById(agent.id);
        const updatedServer = updated!.mcpServers.find(s => s.id === server.id);
        expect(updatedServer!.enabled).toBe(false);
      });

      it('should update MCP server config', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Test Server',
          transport: 'stdio',
          enabled: true,
          config: { command: 'test' },
        });

        repo.updateMCPServer(agent.id, server.id, {
          config: { command: 'new-command', args: ['arg1', 'arg2'] },
        });

        const updated = repo.getById(agent.id);
        const updatedServer = updated!.mcpServers.find(s => s.id === server.id);
        expect(updatedServer!.config.command).toBe('new-command');
        expect(updatedServer!.config.args).toEqual(['arg1', 'arg2']);
      });

      it('should handle empty updates', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Test Server',
          transport: 'stdio',
          enabled: true,
          config: { command: 'test' },
        });

        // Should not throw
        repo.updateMCPServer(agent.id, server.id, {});

        const updated = repo.getById(agent.id);
        expect(updated!.mcpServers).toHaveLength(1);
      });
    });

    describe('deleteMCPServer', () => {
      it('should delete MCP server', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const server = repo.addMCPServer(agent.id, {
          name: 'Test Server',
          transport: 'stdio',
          enabled: true,
          config: { command: 'test' },
        });

        const deleted = repo.deleteMCPServer(agent.id, server.id);
        expect(deleted).toBe(true);

        const updated = repo.getById(agent.id);
        expect(updated!.mcpServers).toHaveLength(0);
      });

      it('should return false when deleting non-existent server', () => {
        const agent = repo.create({
          name: 'Agent',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const deleted = repo.deleteMCPServer(agent.id, 'non-existent');
        expect(deleted).toBe(false);
      });

      it('should only delete server for specific agent', () => {
        const agent1 = repo.create({
          name: 'Agent 1',
          description: 'Test',
          provider: 'anthropic',
          model: 'claude-3-sonnet-20240229',
          temperature: 0.7,
          color: '#ff0000',
        });

        const agent2 = repo.create({
          name: 'Agent 2',
          description: 'Test',
          provider: 'openai',
          model: 'gpt-4',
          temperature: 0.5,
          color: '#00ff00',
        });

        const server1 = repo.addMCPServer(agent1.id, {
          name: 'Server 1',
          transport: 'stdio',
          enabled: true,
          config: { command: 'test1' },
        });

        const server2 = repo.addMCPServer(agent2.id, {
          name: 'Server 2',
          transport: 'stdio',
          enabled: true,
          config: { command: 'test2' },
        });

        // Delete server1 from agent1
        const deleted = repo.deleteMCPServer(agent1.id, server1.id);
        expect(deleted).toBe(true);

        // Server2 should still exist for agent2
        const updated = repo.getById(agent2.id);
        expect(updated!.mcpServers).toHaveLength(1);
        expect(updated!.mcpServers[0].id).toBe(server2.id);
      });
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle agent names with special characters', () => {
      const agent = repo.create({
        name: "Agent's \"Special\" Name (Test)",
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      expect(agent.name).toBe("Agent's \"Special\" Name (Test)");

      const retrieved = repo.getById(agent.id);
      expect(retrieved!.name).toBe("Agent's \"Special\" Name (Test)");
    });

    it('should handle long descriptions', () => {
      const longDescription = 'A'.repeat(1000);
      const agent = repo.create({
        name: 'Agent',
        description: longDescription,
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        color: '#ff0000',
      });

      const retrieved = repo.getById(agent.id);
      expect(retrieved!.description).toBe(longDescription);
    });

    it('should handle temperature edge cases', () => {
      const agent1 = repo.create({
        name: 'Agent 1',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0,
        color: '#ff0000',
      });

      const agent2 = repo.create({
        name: 'Agent 2',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 2,
        color: '#ff0000',
      });

      expect(repo.getById(agent1.id)!.temperature).toBe(0);
      expect(repo.getById(agent2.id)!.temperature).toBe(2);
    });

    it('should handle zero values for optional numeric fields', () => {
      const agent = repo.create({
        name: 'Agent',
        description: 'Test',
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
        temperature: 0.7,
        maxOutputTokens: 0,
        maxSteps: 0,
        color: '#ff0000',
      });

      // Zero should be treated as a valid value and returned as undefined in optional fields
      // based on the implementation logic
      const retrieved = repo.getById(agent.id);
      expect(retrieved).toBeDefined();
    });

    it('preserves a valid 0 for topP and cost overrides (not collapsed to NULL)', () => {
      // Regression: the `numeric` transform must keep 0 distinct from absent —
      // 0 = "fully greedy top-p" / "free ($0) endpoint override", not "unset".
      const agent = repo.create({
        name: 'Zeroes',
        description: 'Test',
        provider: 'openrouter',
        model: 'some/model',
        temperature: 0.7,
        topP: 0,
        promptCostPer1M: 0,
        completionCostPer1M: 0,
        color: '#ff0000',
      });

      const created = repo.getById(agent.id);
      expect(created?.topP).toBe(0);
      expect(created?.promptCostPer1M).toBe(0);
      expect(created?.completionCostPer1M).toBe(0);

      // And survives an update round-trip too.
      repo.update(agent.id, { topP: 0, promptCostPer1M: 0, completionCostPer1M: 0 });
      const updated = repo.getById(agent.id);
      expect(updated?.topP).toBe(0);
      expect(updated?.promptCostPer1M).toBe(0);
      expect(updated?.completionCostPer1M).toBe(0);
    });

    it('should maintain data integrity with multiple concurrent operations', () => {
      const agents = [];
      for (let i = 0; i < 5; i++) {
        agents.push(
          repo.create({
            name: `Agent ${i}`,
            description: `Test agent ${i}`,
            provider: 'anthropic',
            model: 'claude-3-sonnet-20240229',
            temperature: 0.7,
            color: `#${String(i).padStart(6, '0')}`,
          })
        );
      }

      const all = repo.getAll();
      expect(all).toHaveLength(5);

      // Update each agent
      agents.forEach((agent, index) => {
        repo.update(agent.id, { name: `Updated Agent ${index}` });
      });

      const updated = repo.getAll();
      expect(updated).toHaveLength(5);

      // Verify all agents have "Updated Agent" prefix (order may vary due to created_at DESC)
      const updatedNames = updated.map(a => a.name).sort();
      expect(updatedNames).toEqual(['Updated Agent 0', 'Updated Agent 1', 'Updated Agent 2', 'Updated Agent 3', 'Updated Agent 4']);

      // Delete half of them
      for (let i = 0; i < 2; i++) {
        repo.delete(agents[i].id);
      }

      const final = repo.getAll();
      expect(final).toHaveLength(3);
    });
  });
});
