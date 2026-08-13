import { tool } from 'ai';
import { z } from 'zod/v3';
import { fullToolDescription } from './toolDocs';

/**
 * Tool Discovery and Management System
 *
 * These tools allow agents to discover available tools and manage which ones are enabled
 * for the current session. This dramatically reduces context usage by only including
 * tools that are actually needed.
 */

/**
 * Trim a tool description to a one-line summary for compact `list_tools` output.
 * Prefers the first sentence when it's short; otherwise hard-truncates at ~100
 * chars with an ellipsis. Heavy descriptions (e.g. create_workflow's full DAG
 * vocabulary) collapse from thousands of tokens to a brief teaser the model
 * can drill into via get_tool_info.
 */
/**
 * Pull the field map out of a tool's input schema. Tools declare it under
 * either `inputSchema` or `parameters` depending on how they were authored,
 * so check both. Returns null when the schema isn't a Zod object (e.g. JSON
 * Schema), in which case callers fall back to omitting field names.
 */
function extractSchemaShape(toolDef: any): Record<string, any> | null {
  const schema = toolDef?.inputSchema ?? toolDef?.parameters;
  return schema?.shape ?? null;
}

function compactDescription(text: string, maxLen = 100): string {
  // Newline often marks the end of the headline summary.
  const headline = text.split('\n', 1)[0];
  // Prefer the first sentence if it's already concise.
  const sentenceEnd = headline.search(/\.\s|$/);
  const firstSentence = sentenceEnd > 0 ? headline.slice(0, sentenceEnd + 1) : headline;
  if (firstSentence.length <= maxLen) return firstSentence;
  return headline.slice(0, maxLen).trimEnd() + '…';
}

export interface ToolInfo {
  name: string;
  description: string;
  category: 'discovery' | 'builtin' | 'plugin' | 'mcp';
  enabled: boolean;
  // The tool's declared schema, whichever key it came from (see
  // extractSchemaShape).
  inputSchema?: unknown;
}

export interface ToolSessionState {
  enabledTools: Set<string>;
  onChanged?: () => void;
}

/**
 * Create discovery API tools with access to session state
 * These tools are ALWAYS available and cannot be disabled
 */
export function createDiscoveryTools(
  allTools: Record<string, any>,
  sessionState: ToolSessionState,
  toolMetadata: Map<string, { category: string; origin: string }>
) {
  return {
    list_tools: tool({
      description: 'List available tools with their current enabled status. Returns a compact summary by default; pass verbose: true for full descriptions and input schemas, or call get_tool_info for a single tool.',
      inputSchema: z.object({
        category: z.enum(['all', 'builtin', 'plugin', 'mcp', 'discovery']).optional().describe('Filter by tool category. Default: all'),
        enabledOnly: z.boolean().optional().describe('Show only enabled tools. Default: false'),
        verbose: z.boolean().optional().describe('Include full descriptions and input schemas. Default: false (compact — names + one-line descriptions, no schemas). Use get_tool_info instead for one tool.'),
      }),
      execute: async ({ category = 'all', enabledOnly = false, verbose = false }) => {
        // Two output shapes:
        // - Compact (default): a flat tools[] list with one-line descriptions
        //   and per-category counts. Built for tiny-model context budgets — a
        //   single list_tools call can otherwise return thousands of tokens
        //   once verbose descriptions (e.g. create_workflow's DAG vocabulary)
        //   are included, easily overflowing a 4k-loaded local model.
        // - Verbose: the previous nested-categories shape with full
        //   descriptions and input-schema field names. Same structure callers
        //   relied on before; opt-in now via verbose: true.
        const toolList: ToolInfo[] = [];

        for (const [toolName, toolDef] of Object.entries(allTools)) {
          const metadata = toolMetadata.get(toolName);
          const toolCategory = metadata?.category || 'builtin';
          const isEnabled = sessionState.enabledTools.has(toolName);

          // Apply filters
          if (category !== 'all' && toolCategory !== category) continue;
          if (enabledOnly && !isEnabled) continue;

          const fullDescription = fullToolDescription(toolName, toolDef.description || 'No description available');
          toolList.push({
            name: toolName,
            description: verbose ? fullDescription : compactDescription(fullDescription),
            category: toolCategory as any,
            enabled: isEnabled,
            ...(verbose
              ? (() => {
                  const shape = extractSchemaShape(toolDef);
                  return shape ? { inputSchema: Object.keys(shape) } : {};
                })()
              : {}),
          });
        }

        const enabledCount = toolList.filter(t => t.enabled).length;

        if (!verbose) {
          const counts: Record<string, number> = { discovery: 0, builtin: 0, plugin: 0, mcp: 0 };
          for (const t of toolList) counts[t.category] = (counts[t.category] ?? 0) + 1;
          return {
            totalTools: toolList.length,
            enabledCount,
            counts,
            tools: toolList,
            hint: 'Pass verbose: true for full descriptions and input schemas, or call get_tool_info({toolName}) for one tool.',
          };
        }

        // Verbose: preserve the nested-categories shape for callers that want it.
        const grouped = {
          discovery: toolList.filter(t => t.category === 'discovery'),
          builtin: toolList.filter(t => t.category === 'builtin'),
          plugin: toolList.filter(t => t.category === 'plugin'),
          mcp: toolList.filter(t => t.category === 'mcp'),
        };

        return {
          totalTools: toolList.length,
          enabledCount,
          categories: {
            discovery: { count: grouped.discovery.length, tools: grouped.discovery },
            builtin: { count: grouped.builtin.length, tools: grouped.builtin },
            plugin: { count: grouped.plugin.length, tools: grouped.plugin },
            mcp: { count: grouped.mcp.length, tools: grouped.mcp },
          },
        };
      },
    }),

    get_tool_info: tool({
      description: 'Get detailed information about a specific tool including its parameters, description, and usage.',
      inputSchema: z.object({
        toolName: z.string().describe('The exact name of the tool to get information about'),
      }),
      execute: async ({ toolName }) => {
        const toolDef = allTools[toolName];
        if (!toolDef) {
          const availableTools = Object.keys(allTools).slice(0, 20).join(', ');
          throw new Error(`Tool "${toolName}" not found. Available tools: ${availableTools}... (use list_tools for complete list)`);
        }

        const metadata = toolMetadata.get(toolName);
        const parameters = extractSchemaShape(toolDef);

        return {
          name: toolName,
          // The extended docs the description no longer carries on the wire —
          // this call is the reason they can be left off it. See toolDocs.ts.
          description: fullToolDescription(toolName, toolDef.description || 'No description available'),
          category: metadata?.category || 'builtin',
          origin: metadata?.origin || 'unknown',
          enabled: sessionState.enabledTools.has(toolName),
          inputSchema: parameters ? Object.entries(parameters).map(([name, schema]: [string, any]) => ({
            name,
            type: schema._def?.typeName || 'unknown',
            description: schema._def?.description || 'No description',
            optional: schema.isOptional(),
          })) : [],
        };
      },
    }),

    enable_tool: tool({
      description: 'Enable one or more tools for use in this session. Tools must be enabled before you can use them (except discovery tools which are always enabled).',
      inputSchema: z.object({
        toolNames: z.array(z.string()).describe('Array of tool names to enable'),
      }),
      execute: async ({ toolNames }) => {
        const enabled: string[] = [];
        const alreadyEnabled: string[] = [];
        const notFound: string[] = [];

        for (const toolName of toolNames) {
          // Discovery tools are always enabled
          if (['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool'].includes(toolName)) {
            alreadyEnabled.push(toolName);
            continue;
          }

          if (!allTools[toolName]) {
            notFound.push(toolName);
            continue;
          }

          if (sessionState.enabledTools.has(toolName)) {
            alreadyEnabled.push(toolName);
          } else {
            sessionState.enabledTools.add(toolName);
            enabled.push(toolName);
          }
        }

        // Notify of state change
        if (enabled.length > 0 && sessionState.onChanged) {
          sessionState.onChanged();
        }

        return {
          success: true,
          enabled,
          alreadyEnabled,
          notFound,
          totalEnabledTools: sessionState.enabledTools.size,
        };
      },
    }),

    disable_tool: tool({
      description: 'Disable one or more tools for this session. Disabled tools cannot be used. Note: Discovery tools (list_tools, enable_tool, etc.) cannot be disabled.',
      inputSchema: z.object({
        toolNames: z.array(z.string()).describe('Array of tool names to disable'),
      }),
      execute: async ({ toolNames }) => {
        const disabled: string[] = [];
        const alreadyDisabled: string[] = [];
        const cannotDisable: string[] = [];

        for (const toolName of toolNames) {
          // Cannot disable discovery tools
          if (['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool'].includes(toolName)) {
            cannotDisable.push(toolName);
            continue;
          }

          if (sessionState.enabledTools.has(toolName)) {
            sessionState.enabledTools.delete(toolName);
            disabled.push(toolName);
          } else {
            alreadyDisabled.push(toolName);
          }
        }

        // Notify of state change
        if (disabled.length > 0 && sessionState.onChanged) {
          sessionState.onChanged();
        }

        return {
          success: true,
          disabled,
          alreadyDisabled,
          cannotDisable,
          totalEnabledTools: sessionState.enabledTools.size,
        };
      },
    }),
  };
}
