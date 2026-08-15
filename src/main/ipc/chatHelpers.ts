import { BrowserWindow } from 'electron';
import { getSettingsRepository, getToolStateRepository, getChannelRepository, getToolApprovalGrantRepository } from '../repositories';
import { connectMCPServers, ProjectDirectory } from '../services/mcp';
import { getProjectRoots } from '../services/projectRoots';
import { bindProjectScope } from '../services/projectScope';
import { builtinTools } from '../services/builtinTools';
import { createChannelTools } from '../services/channelTools';
import { createTranscriptTools } from '../services/transcriptTools';
import { createAgentSelfTools } from '../services/agentSelfTools';
import { createWorkSessionTools } from '../services/workSessionTools';
import { createCoreMemoryTools } from '../services/coreMemoryTools';
import { buildMemoryContext } from '../services/memoryContext';
import { createDiscoveryTools, ToolSessionState } from '../services/discoveryTools';
import { isDeferredTool } from '../services/toolDeferral';
import { getSandboxedPluginManager } from '../services/sandbox';
import { logger } from '../services/logger';
import { MessageFormatter } from '../services/MessageFormatter';
import { streamAIResponse, type AIMessage } from '../services/ai';
import { ContentBlocksBuilder } from '../services/ContentBlocksBuilder';
import type { Tool } from 'ai';
import { routeStreamEvent, emitStreamStart, emitStreamComplete, emitAgentSpend, createStreamMetrics, type StreamMetrics, type StreamEnvelope } from '../services/streamEventRouter';
import type { Agent, Project, Settings, CurrentState, ContentBlock, RequestInfo } from '../types';
import { calculateCost } from '../../shared/pricing';
import { getProvider } from '../../shared/providers';
import { estimateTokens, type ModelSizeClass, type ContextBudget } from '../services/contextBudget';
import { substituteMustacheVars } from '../utils/substituteMustacheVars';
import { renderPromptTemplate } from '../../shared/promptTemplate';

// ─── Tool Assembly ───────────────────────────────────────────────

export interface ToolsetResult {
  /**
   * The full tool set registered with the SDK. Registering everything (rather
   * than just the enabled subset) lets the model enable a tool and call it in
   * the same turn — `getActiveToolNames` then controls which schemas are
   * actually exposed/billed per step via prepareStep.
   */
  enabledTools: Record<string, unknown>;
  /** Resolved tool-send mode for this agent (see resolveToolSendMode). */
  toolSendMode: 'all' | 'enabled';
  /**
   * Live snapshot of the tool names that should be *active* (exposed to the
   * model) at this point in the turn: the session-enabled set plus the
   * always-on discovery tools. Recomputed on each call so prepareStep picks up
   * a mid-turn enable_tool.
   */
  getActiveToolNames: (modeOverride?: 'all' | 'enabled') => string[];
  allAvailableTools: Record<string, unknown>;
  mcpClients: unknown[];
  projectDirectories: ProjectDirectory[];
  builtinToolCount: number;
  mcpToolCount: number;
  totalToolCount: number;
}

/**
 * Assemble the full toolset for a chat request:
 * builtin → plugin → MCP → discovery → session filtering.
 */
/**
 * Honour "stop asking me about this tool here" waivers.
 *
 * Clears `needsApproval` for granted tools so the turn never suspends on them
 * — which also means no resume round trip, not merely one less click.
 *
 * Two properties this relies on, both worth stating because breaking either
 * turns a convenience into a hole:
 *  - It copies each tool rather than mutating the shared `builtinTools`
 *    object, which is module-level and would otherwise leak a waiver into
 *    every agent and conversation in the process.
 *  - It only runs here, and `buildToolset` is only called by interactive turn
 *    paths. Routines and workflow nodes assemble no tools at all, so a waiver
 *    can never make something runnable while nobody is watching.
 */
function applyApprovalGrants(
  tools: Record<string, unknown>,
  containerId: string,
  agentId: string,
): Record<string, unknown> {
  const granted = getToolApprovalGrantRepository().listToolNames(containerId, agentId);
  if (granted.size === 0) return tools;

  const out: Record<string, unknown> = { ...tools };
  for (const name of granted) {
    const tool = out[name] as { needsApproval?: unknown } | undefined;
    if (!tool || !tool.needsApproval) continue;
    out[name] = { ...tool, needsApproval: false };
  }
  return out;
}

export async function buildToolset(
  agent: Agent,
  currentProject: Project,
  channelId: string,
  channelToolStates: Map<string, ToolSessionState>,
  options?: { getMainWindow?: () => BrowserWindow | null },
): Promise<ToolsetResult> {
  // One source of truth for where this project's tools may reach — the same
  // list the built-in file tools resolve against, so the auto-injected MCP
  // filesystem servers cover exactly the same ground (including the project
  // workspace, which they previously could not see).
  const projectRoots = getProjectRoots(currentProject.id);
  const projectDirectories: ProjectDirectory[] = projectRoots.map(r => ({
    name: r.name, path: r.path, kind: r.kind,
  }));

  const { clients: mcpClients, tools: mcpTools } = await connectMCPServers(
    agent.mcpServers,
    projectDirectories
  );

  // Plugin tools
  const pluginManager = getSandboxedPluginManager();
  const pluginTools = pluginManager.getRegisteredTools();

  // Agent-scoped tools (channel management + self-configuration + core memory)
  const channelTools = createChannelTools(agent.id, channelId);
  const transcriptTools = createTranscriptTools(agent.id);
  const selfTools = createAgentSelfTools(agent.id);
  const coreMemoryTools = createCoreMemoryTools(agent.id);
  // Only inside a work session — elsewhere it is a tool that can only fail.
  const workSessionTools = getChannelRepository().isWorkSession(channelId)
    ? createWorkSessionTools(channelId, options?.getMainWindow ?? (() => null))
    : {};

  // Merge in priority order: builtin → agent-scoped → plugin → MCP
  const toolMetadata = new Map<string, { category: string; origin: string }>();
  // Bind the turn's project onto every built-in and agent-scoped tool. Without
  // this they read the UI's selected project at execute time, which is only the
  // turn's project by coincidence outside of chats (see projectScope.ts). MCP
  // tools need no binding — their server was already started against this
  // project's roots.
  const allAvailableTools: Record<string, unknown> = applyApprovalGrants(
    bindProjectScope(
      { ...builtinTools, ...channelTools, ...transcriptTools, ...selfTools, ...coreMemoryTools, ...workSessionTools },
      currentProject.id,
    ),
    channelId,
    agent.id,
  );

  for (const toolName of Object.keys(builtinTools)) {
    toolMetadata.set(toolName, { category: 'builtin', origin: 'eaves-core' });
  }
  for (const toolName of Object.keys(channelTools)) {
    toolMetadata.set(toolName, { category: 'builtin', origin: 'eaves-core' });
  }
  for (const toolName of Object.keys(transcriptTools)) {
    toolMetadata.set(toolName, { category: 'builtin', origin: 'eaves-core' });
  }
  for (const toolName of Object.keys(selfTools)) {
    toolMetadata.set(toolName, { category: 'builtin', origin: 'eaves-core' });
  }
  for (const toolName of Object.keys(coreMemoryTools)) {
    toolMetadata.set(toolName, { category: 'builtin', origin: 'eaves-core' });
  }
  for (const toolName of Object.keys(workSessionTools)) {
    toolMetadata.set(toolName, { category: 'builtin', origin: 'eaves-core' });
  }

  for (const [toolName, toolDef] of Object.entries(pluginTools)) {
    if (allAvailableTools[toolName]) {
      logger.warn('Plugin tool conflicts with built-in tool; keeping built-in', { toolName });
      continue;
    }
    allAvailableTools[toolName] = toolDef;
    toolMetadata.set(toolName, { category: 'plugin', origin: 'plugin' });
  }

  const builtinToolNames = Object.keys(builtinTools);
  for (const [toolName, toolDef] of Object.entries(mcpTools)) {
    if (allAvailableTools[toolName] && builtinToolNames.includes(toolName)) {
      logger.warn('MCP tool conflicts with built-in tool; keeping built-in', { toolName });
      continue;
    }
    // MCP tools intentionally override plugin tools of the same name
    allAvailableTools[toolName] = toolDef;
    toolMetadata.set(toolName, { category: 'mcp', origin: 'mcp-server' });
  }

  // Roleplay archetype: short-circuit the discovery flow entirely. The SDK
  // tool set is *only* the agent author's explicit `defaultTools` allowlist
  // (typically empty). No discovery, no list_tools — the model can't escape
  // out of empty-tool jail. Keeps the system prompt clean and prevents
  // meta-talk about tool availability.
  if (agent.archetype?.type === 'roleplay') {
    const allowlist = new Set<string>(agent.defaultTools ?? []);
    const sessionState = loadSessionState(channelId, channelToolStates, allowlist);

    // Hard-intersect with the agent's current defaultTools — persisted state
    // from a prior productivity archetype (or a prior defaultTools list that
    // included tools later removed) must NOT leak into the in-character allow-
    // list. Without this, a chat that enabled `web_search` while productivity
    // would keep `web_search` accessible after switching to roleplay.
    const allowlistedTools: Record<string, unknown> = {};
    for (const name of sessionState.enabledTools) {
      if (allowlist.has(name) && allAvailableTools[name]) {
        allowlistedTools[name] = allAvailableTools[name];
      }
    }

    return {
      enabledTools: allowlistedTools,
      // Honor the agent's resolved send mode even for roleplay so the editor
      // dropdown isn't a silent no-op. getActiveToolNames returns the same
      // allowlist regardless, so 'all' and 'enabled' produce the same schemas
      // here — but downstream telemetry/logging stays truthful.
      toolSendMode: resolveToolSendMode(agent),
      getActiveToolNames: () => Object.keys(allowlistedTools),
      allAvailableTools,
      mcpClients,
      projectDirectories,
      builtinToolCount: builtinToolNames.length,
      mcpToolCount: Object.keys(mcpTools).length,
      totalToolCount: Object.keys(allAvailableTools).length,
    };
  }

  // Session tool state (productivity path). The discovery tools are always
  // enabled; agent.defaultTools seed the rest on a brand-new context.
  const sessionState = loadSessionState(channelId, channelToolStates, seedEnabledTools(agent));

  // Build the merged set first so the discovery tools' closures (list_tools,
  // get_tool_info) see *themselves* when they iterate it later — passing the
  // pre-merge object would leave list_tools blind to the discovery category.
  // Register the full set with the SDK regardless of send mode, so a tool the
  // model enables mid-turn is callable without AI_NoSuchToolError. What's
  // actually exposed/billed each step is governed by getActiveToolNames +
  // prepareStep (see ai.ts) — that's how 'enabled' mode stays cheap while still
  // allowing same-turn enable→use.
  const allToolsForSDK: Record<string, unknown> = { ...allAvailableTools };
  const discoveryTools = createDiscoveryTools(allToolsForSDK, sessionState, toolMetadata);
  for (const [toolName, toolDef] of Object.entries(discoveryTools)) {
    toolMetadata.set(toolName, { category: 'discovery', origin: 'eaves-core' });
    allToolsForSDK[toolName] = toolDef;
  }

  const sendMode = resolveToolSendMode(agent);

  return {
    enabledTools: allToolsForSDK,
    toolSendMode: sendMode,
    // Live read — re-evaluated per step, so enable→use lands on the next step.
    getActiveToolNames: (modeOverride) =>
      computeActiveToolNames(allToolsForSDK, sessionState.enabledTools, modeOverride ?? sendMode),
    allAvailableTools,
    mcpClients,
    projectDirectories,
    builtinToolCount: builtinToolNames.length,
    mcpToolCount: Object.keys(mcpTools).length,
    totalToolCount: Object.keys(allAvailableTools).length,
  };
}

const DISCOVERY_TOOL_NAMES = ['list_tools', 'get_tool_info', 'enable_tool', 'disable_tool'] as const;

/**
 * Always in front of the model, in either send mode.
 *
 * The discovery tools are the control plane. `eaves_guide` is here for a
 * different reason: no model knows what Eaves is, so without it an agent
 * asked how the app works answers from nothing and the user has no way to
 * tell. Reaching it via list_tools → enable_tool would work, but only if the
 * model already suspected it needed to look — which is exactly what a
 * confidently wrong answer means it didn't. One short description is a cheap
 * price for never inventing the product's behaviour.
 *
 * Roleplay agents are unaffected: that path short-circuits above and honours
 * only the author's explicit allowlist.
 */
const ALWAYS_ACTIVE_TOOL_NAMES = [...DISCOVERY_TOOL_NAMES, 'eaves_guide'] as const;

/**
 * The tool names actually put in front of the model on a given step.
 *
 * Always: ALWAYS_ACTIVE_TOOL_NAMES — see above.
 *
 * In `'all'` mode, everything else rides along except tools marked deferred
 * (see toolDeferral.ts): large-schema, rarely-called tools that would otherwise
 * be billed on every request of every turn.
 *
 * In `'enabled'` mode, nothing rides along — only what is explicitly enabled.
 *
 * The enabled set is applied last and is purely additive. That is deliberate:
 * a context that already has a persisted enabled-set from the Tool Panel can
 * only ever gain tools here, never lose them, so arming the gate on contexts
 * that were never gated before cannot silently strip an agent of a tool it has
 * always had.
 */
export function computeActiveToolNames(
  allTools: Record<string, unknown>,
  enabled: ReadonlySet<string>,
  sendMode: 'all' | 'enabled',
): string[] {
  // Presence-checked like the enabled set below: a name with no tool behind it
  // would be sent to the model as a schema-less phantom it could never call.
  const names = new Set<string>(
    ALWAYS_ACTIVE_TOOL_NAMES.filter(name => allTools[name]),
  );

  if (sendMode === 'all') {
    for (const [name, def] of Object.entries(allTools)) {
      if (!isDeferredTool(def)) names.add(name);
    }
  }

  for (const name of enabled) {
    if (allTools[name]) names.add(name);
  }

  return [...names];
}

/**
 * Get-or-create the in-memory session state for a context, rehydrating the
 * enabled-tool set from the DB on first touch (so selections survive restarts)
 * and wiring `onChanged` to persist future enable/disable calls. `seed` is the
 * initial enabled set used only when nothing is persisted yet.
 *
 * Shared by buildToolset and ChatService's Tool-Panel handlers so they observe
 * one consistent, persisted session state per context.
 */
export function loadSessionState(
  contextId: string,
  cache: Map<string, ToolSessionState>,
  seed: Set<string>,
): ToolSessionState {
  const existing = cache.get(contextId);
  if (existing) return existing;

  const repo = getToolStateRepository();
  // `null` = no row OR corrupt JSON (treated as missing). An explicit empty
  // array IS a legitimate persisted state — the user disabled everything —
  // so distinguish via `!== null`, not truthiness (`[]` is truthy).
  const persisted = repo.get(contextId);
  const enabledTools = persisted !== null ? new Set<string>(persisted) : seed;
  const state: ToolSessionState = {
    enabledTools,
    onChanged: () => {
      // Guard against the orphan re-INSERT race: if clearChatState evicted
      // us from the cache (chat/channel deleted) while an in-flight stream's
      // enable_tool still holds this closure, refuse to resurrect the row.
      if (cache.get(contextId) !== state) return;
      repo.set(contextId, [...enabledTools]);
    },
  };
  cache.set(contextId, state);
  return state;
}

/** Default enabled set for a productivity (non-roleplay) agent on a new context. */
export function seedEnabledTools(agent: Agent): Set<string> {
  return new Set<string>([...ALWAYS_ACTIVE_TOOL_NAMES, ...(agent.defaultTools ?? [])]);
}

/**
 * The buildSystemPrompt fields that are pure mechanical wiring from the
 * toolset and the budget — identical at every turn site, and exactly the kind
 * of plumbing that drifts one copy at a time.
 *
 * What legitimately differs between sites (participants, and the channel's
 * participantNote vs the chat's roleplayNote) stays with the caller; this only
 * absorbs what has no reason to vary.
 */
export function systemPromptPlumbing(
  toolset: Pick<ToolsetResult, 'projectDirectories' | 'builtinToolCount' | 'mcpToolCount' | 'totalToolCount'>,
  budget: Pick<ContextBudget, 'systemPromptBudget' | 'sizeClass'>,
) {
  return {
    projectDirectories: toolset.projectDirectories,
    builtinToolCount: toolset.builtinToolCount,
    mcpToolCount: toolset.mcpToolCount,
    totalToolCount: toolset.totalToolCount,
    tokenBudget: budget.systemPromptBudget,
    sizeClass: budget.sizeClass,
  };
}

/**
 * Assemble the per-request context telemetry shown in the UI.
 *
 * Both turn paths (channel and chat) report the same nine fields and have to
 * agree on them — `toolCount` in particular is now the *gated* count, not the
 * registered one, and a copy that drifts back to counting registered tools
 * would quietly overreport what every request costs.
 */
export function buildRequestInfo(params: {
  budget: Pick<ContextBudget, 'contextWindow' | 'sizeClass' | 'messageBudget'>;
  systemPrompt: string;
  messagesTotal: number;
  messagesSent: number;
  activeToolNames: string[];
  /** Include the full prompt text — only when the agent opted into debug logging. */
  includeSystemPrompt?: boolean;
}): RequestInfo {
  const { budget, systemPrompt, messagesTotal, messagesSent, activeToolNames } = params;
  return {
    contextWindow: budget.contextWindow,
    sizeClass: budget.sizeClass,
    systemPromptTokens: estimateTokens(systemPrompt),
    messageBudget: budget.messageBudget,
    messagesTotal,
    messagesSent,
    toolsIncluded: activeToolNames.length > 0,
    toolCount: activeToolNames.length,
    ...(params.includeSystemPrompt ? { systemPrompt } : {}),
  };
}

/**
 * Resolve an agent's effective tool-send mode. Explicit setting wins; otherwise
 * default by provider — local endpoints get 'enabled' (tight context budgets),
 * cloud providers get 'all' (room to spare, and same-turn discovery is handy).
 */
export function resolveToolSendMode(agent: Agent): 'all' | 'enabled' {
  if (agent.toolSendMode) return agent.toolSendMode;
  return getProvider(agent.provider)?.isLocalEndpoint ? 'enabled' : 'all';
}

/**
 * Decide the activeTools provider for a request. Returns a callback that
 * prepareStep evaluates each step.
 *
 * The gate is now unconditional. It used to arm only for 'enabled' mode or a
 * 'tiny' window, on the theory that cloud models have context to spare — true,
 * but the bill is per-token, not per-window, and that exemption is how tool
 * schemas grew to ~88% of a small turn's input. What each mode means now lives
 * in getActiveToolNames: 'enabled' exposes discovery + the enabled set, 'all'
 * exposes everything except deferred tools. Both still stay registered with the
 * SDK, so enable→use works within one turn.
 *
 * `sizeClass` still decides one thing: a 'tiny' window is forced to 'enabled'
 * semantics whatever the provider says. Local endpoints already default to
 * 'enabled', but the window is a user-settable override honoured for *any*
 * provider — a cloud agent pinned to 4k would otherwise get the full 'all' set
 * and overflow its window before the first message.
 */
export function activeToolsFor(
  toolset: Pick<ToolsetResult, 'toolSendMode' | 'getActiveToolNames'>,
  sizeClass?: ModelSizeClass,
): () => string[] {
  const modeOverride = sizeClass === 'tiny' ? ('enabled' as const) : undefined;
  return () => toolset.getActiveToolNames(modeOverride);
}

// ─── System Prompt ───────────────────────────────────────────────

export interface SystemPromptParams {
  agent: Agent;
  project: Project;
  settings: Settings;
  participants?: Array<{ id: string; type: string; displayName: string }>;
  participantNote?: string;
  projectDirectories?: ProjectDirectory[];
  builtinToolCount: number;
  mcpToolCount: number;
  totalToolCount: number;
  /** Token budget for the system prompt. When set, lower-priority tiers are trimmed to fit. */
  tokenBudget?: number;
  /** Model size class — controls which tiers are included. */
  sizeClass?: ModelSizeClass;
  /**
   * Optional roleplay scaffolding from buildRoleplayNote. When set, it's
   * injected in Tier 1 alongside the agent's identity so the model never
   * sees the prompt without it. Productivity flow leaves this undefined.
   */
  roleplayNote?: string;
}


/**
 * Build the system prompt in priority tiers.
 *
 * Tier 1 (Core) — always included:
 *   Agent persona/instructions, identity (your name, user name)
 *
 * Tier 2 (Context) — included if budget allows:
 *   Project name, participants, participant note
 *
 * Tier 3 (Enrichment) — included if budget allows:
 *   Tool inventory, project folders, active task/note counts, memories
 *
 * For large-context models (or when no budget is set), all tiers are included.
 */
export async function buildSystemPrompt(params: SystemPromptParams): Promise<string> {
  const {
    agent, project, settings, participants, participantNote,
    projectDirectories, builtinToolCount, mcpToolCount, totalToolCount,
    tokenBudget, sizeClass, roleplayNote,
  } = params;

  const hasBudget = tokenBudget != null && tokenBudget > 0;
  const isConstrained = hasBudget && (sizeClass === 'tiny' || sizeClass === 'small');
  const isRoleplay = agent.archetype?.type === 'roleplay';

  // ─── Tier 1: Core (always included) ────────────────────────────
  // Substitute {{user}} / {{agent}} / {{char}} (and any agent.contextVariables)
  // so character-card prompts don't reach the model with raw placeholders.
  // Same helper the create-chat greeting uses, so behavior matches.
  const basePrompt = substituteMustacheVars(agent.systemPrompt || agent.description, agent, settings.userName);

  // ─── Template path ─────────────────────────────────────────────
  // When the agent author supplies a promptTemplate, the tiered assembly below
  // is bypassed entirely and the template — with {{systemPrompt}}/{{project}}/
  // etc. filled in — *is* the prompt. The author gets full control over what context the
  // model sees, which is what makes the tiny-model "skip project + participants"
  // case author-able. Budget truncation still applies as a last-resort safety.
  if (agent.promptTemplate && agent.promptTemplate.trim()) {
    const rendered = await buildTemplatePrompt({
      template: agent.promptTemplate,
      basePrompt,
      agent, project, settings,
      participants, participantNote, roleplayNote,
      projectDirectories, builtinToolCount, mcpToolCount, totalToolCount,
    });
    // Final mustache pass picks up agent.contextVariables and any remaining
    // {{user}}/{{char}}/{{agent}} the template renderer left intact.
    const final = substituteMustacheVars(rendered, agent, settings.userName);
    if (hasBudget && estimateTokens(final) > tokenBudget!) {
      const maxChars = Math.floor(tokenBudget! * 3.5);
      logger.warn('[buildSystemPrompt] Template prompt exceeds budget, truncating', {
        tokens: estimateTokens(final), budget: tokenBudget,
      });
      return final.slice(0, maxChars);
    }
    return final;
  }

  let tier1 = `${basePrompt}

You are ${agent.name}. The user's name is ${settings.userName}.`;

  // For constrained models, participant note is critical for channel behavior
  if (participantNote) {
    tier1 += `\n\n${participantNote}`;
  }

  if (roleplayNote) {
    tier1 += `\n\n${roleplayNote}`;
  }

  // If heavily constrained, check if tier 1 alone exceeds budget
  if (hasBudget && estimateTokens(tier1) >= tokenBudget!) {
    logger.warn('[buildSystemPrompt] Tier 1 alone exceeds budget, truncating', {
      tier1Tokens: estimateTokens(tier1),
      budget: tokenBudget,
    });
    // Truncate to fit — keep the start of the prompt which has the persona
    const maxChars = Math.floor(tokenBudget! * 3.5);
    return tier1.slice(0, maxChars);
  }

  // ─── Tier 2: Context ───────────────────────────────────────────
  let tier2 = '';

  tier2 += `\n\nProject: ${project.name}`;

  if (participants && participants.length > 0 && !participantNote) {
    // Only add full participant list if we didn't already include a participantNote
    const humans = participants.filter(p => p.type === 'human');
    const agents = participants.filter(p => p.type === 'agent');

    tier2 += '\n\nConversation Participants:';
    if (humans.length > 0) {
      tier2 += `\n- Humans: ${humans.map(p => p.displayName).join(', ')}`;
    }
    if (agents.length > 0) {
      tier2 += `\n- Agents: ${agents.map(p => {
        const isYou = p.id === agent.id;
        return isYou ? `${p.displayName} (you)` : p.displayName;
      }).join(', ')}`;
    }
  } else if (participants && participants.length > 0 && participantNote) {
    // Compact participant list alongside the note
    const names = participants
      .filter(p => p.id !== agent.id)
      .map(p => p.displayName);
    if (names.length > 0) {
      tier2 += `\nOther participants: ${names.join(', ')}`;
    }
  }

  // Check if tier 1 + tier 2 fits
  if (isConstrained && estimateTokens(tier1 + tier2) > tokenBudget!) {
    logger.info('[buildSystemPrompt] Budget exhausted at Tier 2, skipping Tier 3', {
      tokens: estimateTokens(tier1 + tier2),
      budget: tokenBudget,
    });
    return tier1 + tier2;
  }

  // ─── Tier 3: Enrichment ────────────────────────────────────────
  // Roleplay archetype suppresses the productivity-flavored sections
  // (task counts, tool inventory, project folders) — they're noise for
  // an in-character agent and tempt meta-commentary. Memories are kept
  // because a roleplay agent can legitimately benefit from "the user
  // prefers grimdark fantasy"-style facts.
  let tier3 = '';

  // Task/note counts
  const activeTasks = project.tasks.filter(t => !t.completed).length;
  if ((activeTasks > 0 || project.notes.length > 0) && !isRoleplay) {
    tier3 += `\n\nActive Tasks: ${activeTasks} | Notes: ${project.notes.length}`;
  }

  // Tool inventory
  if (!isConstrained && !isRoleplay) {
    tier3 += `\n\nAvailable Tools:
- Built-in Tools: ${builtinToolCount}
- MCP Tools: ${mcpToolCount}
- Total: ${totalToolCount}`;
  }

  // Project folders. The workspace is listed apart from the attached folders
  // because the difference matters to the model: attached folders hold somebody's
  // real work, the workspace is the place it may freely put its own output.
  const attachedDirs = projectDirectories?.filter(d => d.kind !== 'workspace') ?? [];
  const workspaceDir = projectDirectories?.find(d => d.kind === 'workspace');
  if (!isConstrained && !isRoleplay) {
    if (attachedDirs.length > 0) {
      tier3 += '\n\nProject Folders (attached by user — you can browse and read these with your file tools):';
      for (const dir of attachedDirs) {
        tier3 += `\n- ${dir.name}: ${dir.path}`;
      }
    }
    if (workspaceDir) {
      tier3 += `\n\nWorkspace (yours — put scratch files, generated output and script results here): ${workspaceDir.path}`;
    }
  }

  // Check budget before adding memories (most expensive enrichment)
  if (isConstrained && estimateTokens(tier1 + tier2 + tier3) > tokenBudget!) {
    logger.info('[buildSystemPrompt] Budget exhausted before memories', {
      tokens: estimateTokens(tier1 + tier2 + tier3),
      budget: tokenBudget,
    });
    return tier1 + tier2;
  }

  // Memory context: core-memory blocks + archival manifest
  const memoriesBlock = await buildMemoryContext(agent.id);
  if (memoriesBlock) {
    if (isConstrained && estimateTokens(tier1 + tier2 + tier3 + memoriesBlock) > tokenBudget!) {
      logger.info('[buildSystemPrompt] Skipping memory context to stay within budget');
    } else {
      tier3 += memoriesBlock;
    }
  }

  const fullPrompt = tier1 + tier2 + tier3;

  logger.debug('[buildSystemPrompt] Built tiered prompt', {
    sizeClass: sizeClass || 'large',
    tier1Tokens: estimateTokens(tier1),
    tier2Tokens: estimateTokens(tier2),
    tier3Tokens: estimateTokens(tier3),
    totalTokens: estimateTokens(fullPrompt),
    budget: tokenBudget || 'unlimited',
  });

  return fullPrompt;
}

interface TemplatePromptParams {
  template: string;
  basePrompt: string;
  agent: Agent;
  project: Project;
  settings: Settings;
  participants?: Array<{ id: string; type: string; displayName: string }>;
  participantNote?: string;
  roleplayNote?: string;
  projectDirectories?: ProjectDirectory[];
  builtinToolCount: number;
  mcpToolCount: number;
  totalToolCount: number;
}

/**
 * Resolve the prompt-template variables for one request and substitute them
 * into the agent's template. Each variable expands to a "bare" value (no
 * leading header, no surrounding newlines) so the template author controls
 * layout — empty values collapse cleanly via renderPromptTemplate's
 * blank-line squashing.
 */
async function buildTemplatePrompt(params: TemplatePromptParams): Promise<string> {
  const {
    template, basePrompt, agent, project, settings, participants,
    participantNote, roleplayNote, projectDirectories,
    builtinToolCount, mcpToolCount, totalToolCount,
  } = params;

  // Participants block — same shape as the Tier 2 list, minus the header (the
  // template author owns layout, so the variable expands to a bare value).
  let participantsValue = '';
  if (participants && participants.length > 0) {
    const humans = participants.filter(p => p.type === 'human');
    const agents = participants.filter(p => p.type === 'agent');
    const lines: string[] = [];
    if (humans.length > 0) {
      lines.push(`- Humans: ${humans.map(p => p.displayName).join(', ')}`);
    }
    if (agents.length > 0) {
      lines.push(`- Agents: ${agents.map(p => p.id === agent.id ? `${p.displayName} (you)` : p.displayName).join(', ')}`);
    }
    participantsValue = lines.join('\n');
  }

  // Compact tool inventory — the verbose tier-3 block is overkill for a
  // template variable; authors who want more detail can write it themselves.
  // Total also counts discovery/plugin/channel tools, so surface the remainder
  // explicitly rather than printing "Built-in: 26, MCP: 0, Total: 38" where the
  // arithmetic silently doesn't close.
  const otherToolCount = Math.max(0, totalToolCount - builtinToolCount - mcpToolCount);
  const toolsValue = totalToolCount > 0
    ? otherToolCount > 0
      ? `Built-in: ${builtinToolCount}, MCP: ${mcpToolCount}, Other (discovery/plugin): ${otherToolCount}, Total: ${totalToolCount}`
      : `Built-in: ${builtinToolCount}, MCP: ${mcpToolCount}, Total: ${totalToolCount}`
    : '';

  const foldersValue = (projectDirectories ?? [])
    .map(d => d.kind === 'workspace'
      ? `- workspace (scratch space, yours to write in): ${d.path}`
      : `- ${d.name}: ${d.path}`)
    .join('\n');

  const activeTasks = project.tasks.filter(t => !t.completed).length;
  const tasksValue = (activeTasks > 0 || project.notes.length > 0)
    ? `Active Tasks: ${activeTasks} | Notes: ${project.notes.length}`
    : '';

  // Skip the memory lookup unless the template actually uses it — the DB hit
  // is cheap but pointless when the author opted memories out of their prompt.
  let memoriesValue = '';
  if (/\{\{\s*memories\s*\}\}/.test(template)) {
    memoriesValue = (await buildMemoryContext(agent.id)).trim();
  }

  return renderPromptTemplate(template, {
    systemPrompt: basePrompt,
    agent: agent.name,
    char: agent.name,
    user: settings.userName,
    project: project.name,
    participants: participantsValue,
    tools: toolsValue,
    folders: foldersValue,
    tasks: tasksValue,
    memories: memoriesValue,
    participantNote: participantNote ?? '',
    roleplayNote: roleplayNote ?? '',
  });
}

// ─── Stream Processing ──────────────────────────────────────────

export interface PendingApprovalInfo {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface StreamResult {
  response: string;
  metrics: StreamMetrics;
  contentBlocks: ContentBlock[];
  /** AI SDK ResponseMessage[] for next-turn replay. Undefined when the stream
   *  never emitted its terminal 'response-messages' event — a path that doesn't
   *  report them, or a provider error before the response settled. Callers must
   *  treat replay history as optional rather than assume this is populated. */
  responseMessages?: unknown[];
  /** Approvals raised this turn. Caller registers them against the resulting
   *  message so the resume IPC handler can dispatch on user decision. */
  pendingApprovals?: PendingApprovalInfo[];
  /** Terminal in-band stream failure (connection refused, overloaded…).
   *  Already recorded as a system block in contentBlocks; exposed so callers
   *  can toast/log it. */
  streamError?: string;
}

/**
 * Run the AI stream, forwarding events to the renderer and EventBus.
 */
export interface RunStreamOptions {
  agent: Agent;
  formattedResult: {
    messages: unknown[];
    systemPrompt?: string;
    useRawPrompt?: boolean;
    rawPrompt?: string;
    stoppingStrings?: string[];
  };
  enabledTools: Record<string, unknown>;
  /** Per-step active-tool gate (see ToolsetResult.getActiveToolNames). */
  activeTools?: () => string[];
  abortSignal: AbortSignal;
  mainWindow: BrowserWindow | null;
  messageCount: number;
  /** Context budget details to attach to metrics for UI transparency */
  requestInfo?: RequestInfo;
  /**
   * OpenRouter sticky-provider pin — the backend that served the previous turn
   * of this conversation. Threaded to streamAIResponse so OpenRouter prefers it
   * for prompt-cache continuity. Ignored for non-OpenRouter agents.
   */
  preferredProvider?: string;
  /** Additive turn envelope stamped on every routed chat-stream event (ADR-001). */
  envelope?: StreamEnvelope;
}

export async function runStream(options: RunStreamOptions): Promise<StreamResult> {
  const { agent, formattedResult, enabledTools, activeTools, abortSignal, mainWindow, messageCount } = options;
  // Single accumulator for events → contentBlocks — same one ChatService and
  // approvalResume use, so all stream consumers agree on block semantics.
  const builder = new ContentBlocksBuilder();
  let streamError: string | undefined;
  const startTime = Date.now();
  const streamMetrics = createStreamMetrics();

  const memory = {
    settings: getSettingsRepository().get(),
    users: [],
    agents: [],
    projects: [],
    channels: [],
    currentProjectId: null,
    currentAgentId: null,
    currentChannelId: null,
    currentUserId: null,
  };

  logger.info('Starting AI stream', { provider: agent.provider, model: agent.model });
  emitStreamStart(agent.id, agent, messageCount);

  // Captured from the terminal 'response-messages' event so the caller can
  // persist SDK-shape history alongside contentBlocks. Same pattern ChatService
  // uses — keeps channel and chat replay behavior consistent.
  let capturedResponseMessages: unknown[] | undefined;
  // OpenRouter's real reported cost for this turn (usage accounting), preferred
  // over the token-count × pricing estimate when present.
  let orReportedCost: number | undefined;
  // Approvals raised this turn — caller binds them to the resulting message id.
  const pendingApprovals: PendingApprovalInfo[] = [];

  for await (const event of streamAIResponse(
    agent,
    memory,
    formattedResult.useRawPrompt ? [] : formattedResult.messages as AIMessage[],
    formattedResult.systemPrompt,
    Object.keys(enabledTools).length > 0 ? enabledTools as Record<string, Tool> : undefined,
    abortSignal,
    formattedResult.useRawPrompt ? formattedResult.rawPrompt : undefined,
    formattedResult.stoppingStrings,
    { activeTools, preferredProvider: options.preferredProvider }
  )) {
    if (typeof event === 'object' && 'type' in event) {
      if (event.type === 'response-messages') {
        capturedResponseMessages = (event as { messages: unknown[] }).messages;
        continue; // backend-only signal
      } else if (event.type === 'provider-metadata') {
        const e = event as { servedProvider?: string; cost?: number; cachedTokens?: number; cacheWriteTokens?: number };
        if (e.servedProvider) streamMetrics.servedProvider = e.servedProvider;
        if (typeof e.cachedTokens === 'number') streamMetrics.cachedTokens = e.cachedTokens;
        if (typeof e.cacheWriteTokens === 'number') streamMetrics.cacheWriteTokens = e.cacheWriteTokens;
        if (typeof e.cost === 'number') orReportedCost = e.cost;
        continue; // backend-only signal
      } else if (event.type === 'tool-approval-request') {
        // The builder renders the block; we additionally collect the approval
        // so the caller can bind it to the persisted message id.
        pendingApprovals.push({
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        });
      } else if (event.type === 'error') {
        // Terminal in-band stream failure (connection refused, overloaded…).
        // The builder records it as a system block; flag it so callers can
        // surface it. The error stays out of the response text: persisted
        // text is replayed to the model next turn as if the agent had
        // spoken it.
        streamError = typeof event.error === 'string' ? event.error : event.error.message;
      }
    }
    builder.handleEvent(event);
    routeStreamEvent(event, agent.id, mainWindow, streamMetrics, 'text', options.envelope);
  }

  const contentBlocks = builder.getContentBlocks();

  streamMetrics.timeToComplete = Date.now() - startTime;
  streamMetrics.model = agent.model;

  // Attach context budget info for UI transparency
  if (options.requestInfo) {
    streamMetrics.requestInfo = options.requestInfo;
  }

  // Prefer OpenRouter's real reported cost (usage accounting) over the estimate
  // from token counts × agent pricing; fall back to the estimate otherwise.
  if (typeof orReportedCost === 'number') {
    streamMetrics.cost = orReportedCost;
  } else {
    const cost = calculateCost(
      agent.provider, agent.model, streamMetrics.inputTokens, streamMetrics.outputTokens,
      { promptCostPer1M: agent.promptCostPer1M, completionCostPer1M: agent.completionCostPer1M },
    );
    if (cost !== null) {
      streamMetrics.cost = cost;
    }
  }

  const responseText = builder.getFullText();
  logger.info('AI stream complete', { responseLength: responseText.length, metrics: streamMetrics });
  emitStreamComplete(agent.id, responseText.length, messageCount, streamMetrics, options.envelope);
  emitAgentSpend(agent, streamMetrics, {
    kind: options.envelope?.context ?? 'chat',
    containerId: options.envelope?.containerId,
  });

  return {
    response: responseText,
    metrics: streamMetrics,
    contentBlocks,
    responseMessages: capturedResponseMessages,
    pendingApprovals: pendingApprovals.length > 0 ? pendingApprovals : undefined,
    streamError,
  };
}
