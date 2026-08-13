import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Agent, AgentArchetype, ChannelBehavior, InstructTemplate, ContextFormatting, MCPServer } from '../types';
import { getDatabase } from '../services/database';
import { safeJsonParseOptional } from '../utils/safeJson';
import { AgentRow, MCPServerRow } from './row-types';
import { buildUpdateFields, buildInsertFields, type FieldMap } from '../utils/buildUpdateFields';

/** Shared field map: camelCase Agent keys → snake_case DB columns + transforms */
const AGENT_FIELD_MAP: FieldMap<Record<string, unknown>> = {
  name: 'name',
  description: 'description',
  systemPrompt: { column: 'system_prompt', transform: 'nullable' },
  promptTemplate: { column: 'prompt_template', transform: 'nullable' },
  greeting: { column: 'greeting', transform: 'nullable' },
  provider: 'provider',
  model: 'model',
  temperature: 'temperature',
  topP: { column: 'top_p', transform: 'numeric' },
  maxOutputTokens: { column: 'max_tokens', transform: 'nullable' },
  maxSteps: { column: 'max_steps', transform: 'nullable' },
  contextWindow: { column: 'context_window', transform: 'nullable' },
  debugLogging: { column: 'debug_logging', transform: 'boolInt' },
  defaultTools: { column: 'default_tools', transform: 'json' },
  toolSendMode: { column: 'tool_send_mode', transform: 'nullable' },
  compactionMode: { column: 'compaction_mode', transform: 'nullable' },
  instructTemplate: { column: 'instruct_template', transform: 'json' },
  stoppingStrings: { column: 'stopping_strings', transform: 'json' },
  contextVariables: { column: 'context_variables', transform: 'json' },
  contextFormatting: { column: 'context_formatting', transform: 'json' },
  color: 'color',
  avatar: { column: 'avatar', transform: 'nullable' },
  promptCostPer1M: { column: 'prompt_cost_per_1m', transform: 'numeric' },
  completionCostPer1M: { column: 'completion_cost_per_1m', transform: 'numeric' },
  channelBehavior: { column: 'channel_behavior', transform: 'json' },
  archetype: { column: 'archetype', transform: 'json' },
};

export class AgentRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  getAll(): Agent[] {
    const agents = this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as AgentRow[];
    return agents.map(row => this.mapRowToAgent(row));
  }

  getById(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    if (!row) return null;
    return this.mapRowToAgent(row);
  }

  private mapRowToAgent(row: AgentRow): Agent {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      systemPrompt: row.system_prompt || undefined,
      promptTemplate: row.prompt_template || undefined,
      greeting: row.greeting || undefined,
      provider: row.provider as Agent['provider'],
      model: row.model ?? '',
      temperature: row.temperature ?? 0,
      topP: row.top_p ?? undefined,
      maxOutputTokens: row.max_tokens || undefined,
      maxSteps: row.max_steps || undefined,
      contextWindow: row.context_window || undefined,
      debugLogging: row.debug_logging == null ? undefined : row.debug_logging === 1,
      color: row.color ?? '',
      avatar: row.avatar || undefined,
      defaultTools: safeJsonParseOptional<Agent['defaultTools']>(row.default_tools, `agent:${row.id}:defaultTools`),
      toolSendMode: (row.tool_send_mode as Agent['toolSendMode']) || undefined,
      compactionMode: (row.compaction_mode as Agent['compactionMode']) || undefined,
      instructTemplate: safeJsonParseOptional<InstructTemplate>(row.instruct_template, `agent:${row.id}:instructTemplate`),
      stoppingStrings: safeJsonParseOptional<string[]>(row.stopping_strings, `agent:${row.id}:stoppingStrings`),
      contextVariables: safeJsonParseOptional<Record<string, string>>(row.context_variables, `agent:${row.id}:contextVariables`),
      contextFormatting: safeJsonParseOptional<ContextFormatting>(row.context_formatting, `agent:${row.id}:contextFormatting`),
      promptCostPer1M: row.prompt_cost_per_1m ?? undefined,
      completionCostPer1M: row.completion_cost_per_1m ?? undefined,
      channelBehavior: safeJsonParseOptional<ChannelBehavior>(row.channel_behavior, `agent:${row.id}:channelBehavior`),
      archetype: safeJsonParseOptional<AgentArchetype>(row.archetype, `agent:${row.id}:archetype`),
      mcpServers: this.getMCPServersByAgentId(row.id),
      createdAt: row.created_at,
    };
  }

  create(agent: Omit<Agent, 'id' | 'createdAt' | 'mcpServers'>): Agent {
    const id = randomUUID();
    const createdAt = Date.now();

    const { columns, placeholders, params } = buildInsertFields(
      { id, ...agent, createdAt } as Record<string, unknown>,
      { id: 'id', ...AGENT_FIELD_MAP, createdAt: 'created_at' }
    );

    this.db.prepare(
      `INSERT INTO agents (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
    ).run(...params);

    return {
      id,
      ...agent,
      mcpServers: [],
      createdAt,
    };
  }

  update(id: string, updates: Partial<Omit<Agent, 'id' | 'createdAt' | 'mcpServers'>>): Agent | null {
    const { clauses, params } = buildUpdateFields(updates, AGENT_FIELD_MAP);

    if (clauses.length === 0) {
      const existing = this.getById(id);
      if (existing) {
        this.syncAgentContext(existing);
      }
      return existing;
    }

    params.push(id);
    this.db.prepare(`UPDATE agents SET ${clauses.join(', ')} WHERE id = ?`).run(...params);

    const updated = this.getById(id);
    if (updated) {
      this.syncAgentContext(updated);
    }
    return updated;
  }

  /**
   * Delete an agent by ID
   * Returns true if deleted, false if not found
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private syncAgentContext(agent: Agent): void {
    this.db.prepare(`
      UPDATE channel_participants
      SET display_name = ?, color = ?
      WHERE participant_id = ? AND participant_type = 'agent'
    `).run(agent.name, agent.color, agent.id);

    this.db.prepare(`
      UPDATE messages
      SET sender_display_name = ?, sender_color = ?
      WHERE sender_id = ? AND sender_type = 'agent'
    `).run(agent.name, agent.color, agent.id);
  }

  // MCP Server operations for agents

  private getMCPServersByAgentId(agentId: string): MCPServer[] {
    const rows = this.db.prepare('SELECT * FROM mcp_servers WHERE agent_id = ?').all(agentId) as MCPServerRow[];

    return rows.map(row => {
      const config: MCPServer['config'] = {};

      if (row.config_command) config.command = row.config_command;
      if (row.config_args) config.args = safeJsonParseOptional<string[]>(row.config_args, `mcpServer:${row.id}:args`);
      if (row.config_env) config.env = safeJsonParseOptional<Record<string, string>>(row.config_env, `mcpServer:${row.id}:env`);
      if (row.config_url) config.url = row.config_url;

      return {
        id: row.id,
        name: row.name,
        transport: row.transport as MCPServer['transport'],
        enabled: row.enabled === 1,
        config,
      };
    });
  }

  addMCPServer(agentId: string, server: Omit<MCPServer, 'id'>): MCPServer {
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO mcp_servers (id, agent_id, name, transport, enabled, config_command, config_args, config_env, config_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      agentId,
      server.name,
      server.transport,
      server.enabled ? 1 : 0,
      server.config.command || null,
      server.config.args ? JSON.stringify(server.config.args) : null,
      server.config.env ? JSON.stringify(server.config.env) : null,
      server.config.url || null,
      Date.now()
    );

    return { id, ...server };
  }

  updateMCPServer(agentId: string, serverId: string, updates: Partial<MCPServer>): void {
    // Flatten nested config into top-level fields for buildUpdateFields
    const flat: Record<string, unknown> = {};
    if (updates.name !== undefined) flat.name = updates.name;
    if (updates.enabled !== undefined) flat.enabled = updates.enabled;
    if (updates.config) {
      if (updates.config.command !== undefined) flat.configCommand = updates.config.command;
      if (updates.config.args !== undefined) flat.configArgs = updates.config.args;
      if (updates.config.env !== undefined) flat.configEnv = updates.config.env;
      if (updates.config.url !== undefined) flat.configUrl = updates.config.url;
    }

    const { clauses, params } = buildUpdateFields(flat, {
      name: 'name',
      enabled: { column: 'enabled', transform: 'boolInt' },
      configCommand: { column: 'config_command', transform: 'nullable' },
      configArgs: { column: 'config_args', transform: 'json' },
      configEnv: { column: 'config_env', transform: 'json' },
      configUrl: { column: 'config_url', transform: 'nullable' },
    });

    if (clauses.length > 0) {
      params.push(serverId, agentId);
      this.db.prepare(`UPDATE mcp_servers SET ${clauses.join(', ')} WHERE id = ? AND agent_id = ?`)
        .run(...params);
    }
  }

  deleteMCPServer(agentId: string, serverId: string): boolean {
    const result = this.db.prepare('DELETE FROM mcp_servers WHERE id = ? AND agent_id = ?').run(serverId, agentId);
    return result.changes > 0;
  }
}
