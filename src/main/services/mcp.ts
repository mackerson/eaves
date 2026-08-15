import { tool, jsonSchema, type ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { MCPServer } from '../types';
import { logger } from './logger';
import * as path from 'path';
import { app } from 'electron';

/**
 * The AI SDK has no MCP client of its own, so we own the connection: talk to
 * MCP servers directly via @modelcontextprotocol/sdk and wrap each discovered
 * tool in an AI SDK `tool()` that proxies execute() → client.callTool().
 */

type MCPClientInstance = Client;

export interface ProjectDirectory {
  name: string;
  path: string;
  /** See projectRoots.ts. Absent for callers that don't distinguish. */
  kind?: 'attached' | 'workspace';
}

/**
 * MCP content parts as defined by the @modelcontextprotocol/sdk Tool result.
 * We mirror the shape we care about; unknown variants pass through to the
 * pre-flight stringifier so the model still sees something useful.
 */
type McpTextPart = { type: 'text'; text: string };
type McpImagePart = { type: 'image'; data: string; mimeType: string };
type McpResourcePart = {
  type: 'resource';
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
};
type McpContentPart = McpTextPart | McpImagePart | McpResourcePart | { type: string; [k: string]: unknown };

interface McpToolResult {
  content?: McpContentPart[];
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * Flattened text summary of MCP content — what the renderer displays, and the
 * fallback when no model-consumable part survives the mapping below.
 */
function summarizeMcpContent(content: McpContentPart[] | undefined): string {
  if (!Array.isArray(content)) return '';
  const lines: string[] = [];
  for (const c of content) {
    if (c.type === 'text' && typeof (c as McpTextPart).text === 'string') {
      lines.push((c as McpTextPart).text);
    } else if (c.type === 'image') {
      const m = (c as McpImagePart).mimeType || 'image/*';
      lines.push(`[image: ${m}]`);
    } else if (c.type === 'resource') {
      const r = (c as McpResourcePart).resource;
      if (r?.text) {
        lines.push(`[resource ${r.uri}]\n${r.text}`);
      } else {
        lines.push(`[resource ${r?.uri ?? 'unknown'}: ${r?.mimeType ?? 'binary'}]`);
      }
    } else {
      lines.push(`[${c.type}]`);
    }
  }
  return lines.join('\n');
}

/**
 * Map MCP content parts to AI SDK ToolResultOutput parts.
 * Preserves text + image + resource parts so the model actually sees
 * screenshots and binary resources from MCP tools — a text-only filter here
 * would silently drop every non-`text` part.
 */
function mcpContentToModelOutput(content: McpContentPart[] | undefined) {
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image-data'; data: string; mediaType: string }
    | { type: 'file-data'; data: string; mediaType: string }
  > = [];

  if (!Array.isArray(content)) return parts;

  for (const c of content) {
    if (c.type === 'text' && typeof (c as McpTextPart).text === 'string') {
      parts.push({ type: 'text', text: (c as McpTextPart).text });
    } else if (c.type === 'image' && typeof (c as McpImagePart).data === 'string') {
      const img = c as McpImagePart;
      parts.push({ type: 'image-data', data: img.data, mediaType: img.mimeType || 'image/png' });
    } else if (c.type === 'resource') {
      const r = (c as McpResourcePart).resource;
      if (r?.text) {
        // Embed text resources directly so the model can read them
        parts.push({ type: 'text', text: `[resource ${r.uri}]\n${r.text}` });
      } else if (r?.blob && r?.mimeType) {
        parts.push({ type: 'file-data', data: r.blob, mediaType: r.mimeType });
      } else {
        parts.push({ type: 'text', text: `[resource ${r?.uri ?? 'unknown'}]` });
      }
    } else {
      // Unknown part type — degrade to a labeled text marker
      parts.push({ type: 'text', text: `[${c.type}]` });
    }
  }
  return parts;
}

/** Prefix of the filesystem servers this app injects on the user's behalf. */
const BUILTIN_FILESYSTEM_PREFIX = '__builtin_filesystem__:';

/**
 * Tools on the auto-injected filesystem server that mutate the project, and so
 * get the same human gate as the built-in edit_file / write_file.
 *
 * The distinction being drawn is consent, not capability. A third-party MCP
 * server is something the user configured and enabled — an install-time trust
 * decision, the same posture plugins get. This server is one *we* attach to
 * every project directory without asking. Shipping it with an ungated
 * delete_file would be us granting a capability the user never chose, while the
 * far more careful edit_file next to it stops to ask.
 *
 * Third-party servers exposing equivalent tools remain ungated, which is a real
 * gap — it is just not one this list can honestly close by name-matching.
 */
const GATED_BUILTIN_FILESYSTEM_TOOLS = new Set([
  'write_file', 'create_directory', 'delete_file',
]);

/** Whether an MCP tool gets the human approval gate. */
export function shouldGateMcpTool(serverId: string, toolName: string): boolean {
  return serverId.startsWith(BUILTIN_FILESYSTEM_PREFIX)
    && GATED_BUILTIN_FILESYSTEM_TOOLS.has(toolName);
}

/**
 * Long-lived filesystem servers, keyed by project directory path.
 *
 * The auto-injected filesystem server is identical for a given directory no
 * matter which agent or turn asks for it, so there is nothing to gain from a
 * process per turn — and plenty to lose. Every turn used to spawn one node
 * process per project directory; chat turns closed theirs in a finally, channel
 * turns never did, so they accumulated at ~75MB each for the life of the app,
 * and every turn paid a cold process boot before its first tool call.
 *
 * Entries hold the connect promise, not the resolved client, so concurrent
 * turns racing for the same directory share one spawn instead of both starting
 * a server. A server that closes or errors evicts itself, so the next turn
 * respawns it rather than handing out a dead client.
 */
interface PooledServer {
  client: MCPClientInstance;
  /** Cached from the one listTools call at spawn — a static server's tool list
   *  does not change, and re-listing every turn is a round trip per directory. */
  tools: McpToolDescriptor[];
}
const filesystemPool = new Map<string, Promise<PooledServer>>();

function filesystemServerFor(dir: ProjectDirectory): MCPServer {
  return {
    id: `${BUILTIN_FILESYSTEM_PREFIX}${dir.name}`,
    name: `Filesystem: ${dir.name}`,
    transport: 'stdio',
    enabled: true,
    config: {
      command: 'node',
      args: [path.join(app.getAppPath(), 'dist/main/mcp-servers/filesystem.js')],
      env: { ...process.env, PROJECT_DIR: dir.path },
    },
  };
}

/** Get (or spawn) the pooled filesystem server for a project directory. */
function acquireFilesystemServer(dir: ProjectDirectory): Promise<PooledServer> {
  const existing = filesystemPool.get(dir.path);
  if (existing) return existing;

  const spawning = (async (): Promise<PooledServer> => {
    const server = filesystemServerFor(dir);
    const transport = new StdioClientTransport({
      command: server.config.command!,
      args: server.config.args || [],
      env: server.config.env,
    });
    const client = new Client({ name: 'eaves', version: '0.0.0' }, { capabilities: {} });

    // Evict before the caller can be handed a dead client on a later turn.
    const evict = () => {
      if (filesystemPool.get(dir.path) === spawning) filesystemPool.delete(dir.path);
    };
    client.onclose = evict;
    client.onerror = (error) => {
      logger.error('Pooled filesystem MCP server errored', { path: dir.path, error: error.message });
      evict();
    };

    await client.connect(transport);
    const listing = await client.listTools();
    logger.info('Spawned pooled filesystem MCP server', { name: dir.name, path: dir.path });
    return { client, tools: listing.tools as McpToolDescriptor[] };
  })();

  // A failed spawn must not poison the pool for every later turn.
  spawning.catch(() => {
    if (filesystemPool.get(dir.path) === spawning) filesystemPool.delete(dir.path);
  });

  filesystemPool.set(dir.path, spawning);
  return spawning;
}

/** Close every pooled filesystem server. Called on app shutdown. */
export async function shutdownMCPPool(): Promise<void> {
  const entries = [...filesystemPool.values()];
  filesystemPool.clear();
  for (const entry of entries) {
    try {
      const { client } = await entry;
      client.onclose = undefined;
      client.close();
    } catch {
      /* never spawned successfully, or already gone */
    }
  }
}

export async function connectMCPServers(
  servers: MCPServer[],
  projectDirectories?: ProjectDirectory[]
): Promise<{ clients: MCPClientInstance[]; tools: ToolSet }> {
  // Only per-turn servers land here. Pooled filesystem clients are deliberately
  // excluded: callers disconnect everything in `clients` when the turn ends, and
  // closing a pooled server would defeat the pool and kill it for other turns.
  const mcpClients: MCPClientInstance[] = [];
  const allTools: ToolSet = {};
  const toolOrigins = new Map<string, string>();

  const serversToConnect = [...servers].filter(s => s.enabled);

  // Project filesystem tools are registered first so they win name conflicts,
  // matching the previous unshift-onto-the-front ordering.
  for (const dir of projectDirectories || []) {
    try {
      const pooled = await acquireFilesystemServer(dir);
      registerServerTools(pooled.client, filesystemServerFor(dir), pooled.tools, allTools, toolOrigins);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to connect filesystem MCP server for ${dir.name}:`, message);
    }
  }

  for (const server of serversToConnect) {
    try {
      let transport: StdioClientTransport | SSEClientTransport;

      if (server.transport === 'stdio') {
        if (!server.config.command) {
          logger.warn(`MCP server ${server.name} missing command config, skipping`);
          continue;
        }
        transport = new StdioClientTransport({
          command: server.config.command,
          args: server.config.args || [],
          env: server.config.env,
        });
      } else if (server.transport === 'sse') {
        if (!server.config.url) {
          logger.warn(`MCP server ${server.name} missing URL config, skipping`);
          continue;
        }
        transport = new SSEClientTransport(new URL(server.config.url));
      } else {
        logger.warn(`MCP server ${server.name} has unsupported transport: ${server.transport}`);
        continue;
      }

      const client = new Client(
        { name: 'eaves', version: '0.0.0' },
        { capabilities: {} },
      );
      await client.connect(transport);
      mcpClients.push(client);

      const listing = await client.listTools();
      registerServerTools(client, server, listing.tools as McpToolDescriptor[], allTools, toolOrigins);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to connect to MCP server ${server.name}:`, message);
    }
  }

  return { clients: mcpClients, tools: allTools };
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/**
 * Wrap a server's advertised tools into the toolset. Shared by pooled and
 * per-turn servers so both get identical conflict handling, approval gating,
 * and result translation. First registration wins a name conflict.
 */
function registerServerTools(
  client: MCPClientInstance,
  server: MCPServer,
  descriptors: McpToolDescriptor[],
  allTools: ToolSet,
  toolOrigins: Map<string, string>,
): void {
  for (const t of descriptors) {
    if (allTools[t.name]) {
      logger.warn('MCP tool conflict detected; keeping first definition', {
        toolName: t.name,
        existingServer: toolOrigins.get(t.name),
        conflictingServer: server.name,
      });
      continue;
    }

    const needsApproval = shouldGateMcpTool(server.id, t.name);

    allTools[t.name] = tool({
      description: t.description,
      ...(needsApproval ? { needsApproval: true as const } : {}),
      inputSchema: jsonSchema(t.inputSchema as Record<string, unknown>),
      execute: async (args: unknown) => {
        const result = (await client.callTool({
          name: t.name,
          arguments: args as Record<string, unknown>,
        })) as McpToolResult;
        // Return both shapes:
        //   text   — flat string for the renderer's pre/JSON display
        //   parts  — raw MCP content for toModelOutput to translate
        // toModelOutput is what actually reaches the model, so the model
        // gets full media fidelity even though the renderer keeps a tidy
        // text summary.
        return {
          text: summarizeMcpContent(result?.content),
          parts: result?.content ?? [],
          isError: !!result?.isError,
        };
      },
      toModelOutput: ({ output }) => {
        const o = output as { text?: string; parts?: McpContentPart[]; isError?: boolean } | null;
        const parts = mcpContentToModelOutput(o?.parts);
        // No usable parts (rare) → fall back to text or a placeholder so
        // the model still sees *something* and can continue.
        if (parts.length === 0) {
          return { type: 'text', value: o?.text || '(empty tool result)' };
        }
        return { type: 'content', value: parts };
      },
    });
    toolOrigins.set(t.name, server.name);
  }
}

/** Test surface only — keep helpers internal but reachable from unit tests. */
export const __testing__ = { summarizeMcpContent, mcpContentToModelOutput };

export function disconnectMCPClients(clients: MCPClientInstance[]): void {
  for (const client of clients) {
    try {
      client.close();
    } catch (error) {
      logger.error('Error disconnecting MCP client:', error);
    }
  }
}
