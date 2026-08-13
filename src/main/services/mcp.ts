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

export async function connectMCPServers(
  servers: MCPServer[],
  projectDirectories?: ProjectDirectory[]
): Promise<{ clients: MCPClientInstance[]; tools: ToolSet }> {
  const mcpClients: MCPClientInstance[] = [];
  const allTools: ToolSet = {};
  const toolOrigins = new Map<string, string>();

  let serversToConnect = [...servers].filter(s => s.enabled);

  // Auto-inject filesystem MCP servers for each project directory
  if (projectDirectories && projectDirectories.length > 0) {
    for (const dir of projectDirectories) {
      const filesystemServer: MCPServer = {
        id: `__builtin_filesystem__:${dir.name}`,
        name: `Filesystem: ${dir.name}`,
        transport: 'stdio',
        enabled: true,
        config: {
          command: 'node',
          args: [
            path.join(app.getAppPath(), 'dist/main/mcp-servers/filesystem.js')
          ],
          env: {
            ...process.env,
            PROJECT_DIR: dir.path,
          },
        },
      };

      // Add at the beginning so project filesystem tools have priority
      serversToConnect.unshift(filesystemServer);
      logger.info('Auto-configured filesystem MCP server', { name: dir.name, path: dir.path });
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
        { name: 'enclave', version: '0.0.0' },
        { capabilities: {} },
      );
      await client.connect(transport);
      mcpClients.push(client);

      const listing = await client.listTools();
      for (const t of listing.tools) {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to connect to MCP server ${server.name}:`, message);
    }
  }

  return { clients: mcpClients, tools: allTools };
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
