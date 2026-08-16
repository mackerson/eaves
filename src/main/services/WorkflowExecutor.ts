import {
  Workflow,
  WorkflowSafetyConfig,
  WorkflowNode,
  WorkflowEdge,
  HttpNodeData,
  CodeNodeData,
  ConditionalNodeData,
  DelayNodeData,
  LoopNodeData,
  BreakNodeData,
  WebScraperNodeData,
  AgentNodeData,
  Agent,
} from '../types';
import { textFromResult } from '../utils/resultText';
import { logger } from './logger';
import { eventBus } from './EventBus';
import { getCodeExecutor } from './CodeExecutor';
import { ExecutionLanguage } from '../types/code-execution';
import { streamAIResponse } from './ai';
import { emitAgentSpend, trackUsage, createStreamMetrics } from './streamEventRouter';
import { getAgentRepository, getSettingsRepository, getProjectRepository } from '../repositories';
import { resolveSystemAgent } from './systemAgent';

/** Dynamic key-value context passed between workflow nodes */
type WorkflowContext = Record<string, unknown>;

/**
 * Workflow execution context and result types
 */
export interface WorkflowExecutionContext {
  workflowId: string;
  workflowName: string;
  startTime: number;
  variables: WorkflowContext;
}

export interface WorkflowExecutionResult {
  success: boolean;
  executionId: string;
  workflowId: string;
  startTime: number;
  endTime: number;
  duration: number;
  outputs: WorkflowContext;
  /**
   * What each node did. Accumulated during execution and previously dropped
   * on the floor, which left every caller — the routine scheduler, the IPC
   * layer, agents — able to say only "it worked" or "it didn't". Present on
   * failures too, where it is the most useful: it shows how far the run got
   * and which node stopped it.
   */
  nodeResults: Record<string, NodeExecutionResult>;
  error?: string;
}

export interface NodeExecutionResult {
  nodeId: string;
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
  breakLoop?: boolean;  // Signal to break out of current loop
}

/**
 * Execution state tracking for workflow execution
 * Tracks node visits, loop iterations, and safety limits
 */
interface ExecutionState {
  visitCounts: Map<string, number>;      // Track how many times each node has been executed
  loopStack: string[];                   // Stack of currently active loop node IDs
  totalNodesExecuted: number;            // Total number of node executions
  breakFlags: Map<string, boolean>;      // Break flags for each loop (keyed by loop node ID)
  startTime: number;                     // Workflow start time for timeout tracking
  safetyConfig: Required<WorkflowSafetyConfig>;  // Safety configuration with defaults
  workflow: Workflow;                    // The run's own workflow — per-run, never read off `this`
}

/**
 * Subgraph definition (nodes within a loop body or condition branch)
 */
interface Subgraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  entryNodeIds: string[];  // Nodes that are entry points to the subgraph
  exitNodeIds: string[];   // Nodes that connect back to parent graph
}

// HTTP methods the executor's http node is allowed to issue. Moved here from
// ipc/workflows.ts's `workflow:http-request` handler, which validated a URL
// nothing ever called — the reachable path was this file's bare `fetch`.
const WORKFLOW_HTTP_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// Check if a hostname is a private/internal address, to block SSRF via a
// workflow http node (including one whose URL was `${...}`-interpolated
// from a prior node's fetched content).
function isPrivateWorkflowHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return true; // 10.x.x.x
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.x.x - 172.31.x.x
    if (a === 192 && b === 168) return true; // 192.168.x.x
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local (e.g. cloud metadata)
    if (a === 0) return true;
  }

  return false;
}

// Validate a resolved workflow http-node URL. Protocol allow-list + private/
// internal address block, applied to the URL after variable interpolation.
function validateWorkflowUrl(urlString: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(urlString);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, error: `Invalid protocol: ${url.protocol}. Only http and https are allowed.` };
    }

    if (isPrivateWorkflowHost(url.hostname)) {
      return { valid: false, error: `Requests to private/internal addresses are not allowed: ${url.hostname}` };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * WorkflowExecutor Service
 *
 * Executes workflows by processing their DAG definition.
 * Handles node execution, data flow between nodes, and error handling.
 */
export class WorkflowExecutor {
  /**
   * Execute a workflow
   */
  async executeWorkflow(
    workflow: Workflow,
    initialVariables: WorkflowContext = {}
  ): Promise<WorkflowExecutionResult> {
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    // Review gate: fail closed. Only explicitly-approved workflows execute.
    // Any other value (pending, null, undefined, malformed) blocks.
    if (workflow.reviewStatus !== 'approved') {
      const errorMessage = `Workflow "${workflow.name}" is pending human review and cannot execute. Approve it in the Workflows tab.`;
      logger.warn('[WorkflowExecutor] Blocked pending-review workflow', {
        workflowId: workflow.id,
        workflowName: workflow.name,
      });
      eventBus.emitEvent('workflow:blocked:pending-review', {
        workflowId: workflow.id,
        workflowName: workflow.name,
        projectId: workflow.projectId,
      });
      return {
        success: false,
        executionId,
        workflowId: workflow.id,
        startTime,
        endTime: Date.now(),
        duration: 0,
        outputs: {},
        nodeResults: {},
        error: errorMessage,
      };
    }

    logger.info('[WorkflowExecutor] Starting workflow execution', {
      executionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
    });

    // Emit workflow started event
    eventBus.emitEvent('workflow:execution:started', {
      executionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      startTime,
    });

    // Declared outside try so partial results are available in catch
    let context: WorkflowContext = {};
    const nodeResults: Record<string, NodeExecutionResult> = {};

    try {
      // Extract nodes and edges from DAG definition
      const { nodes, edges } = workflow.dagDefinition;

      if (!nodes || nodes.length === 0) {
        throw new Error('Workflow has no nodes to execute');
      }

      // Build execution context
      context = { ...initialVariables };

      // Initialize execution state with safety defaults
      const safetyConfig: Required<WorkflowSafetyConfig> = {
        maxExecutionTime: workflow.safetyConfig?.maxExecutionTime ?? 120000,  // 2 minutes
        maxNodesExecuted: workflow.safetyConfig?.maxNodesExecuted ?? 1000,
        maxLoopIterations: workflow.safetyConfig?.maxLoopIterations ?? 10,
        maxLoopDepth: workflow.safetyConfig?.maxLoopDepth ?? 3,
      };

      const state: ExecutionState = {
        visitCounts: new Map(),
        loopStack: [],
        totalNodesExecuted: 0,
        breakFlags: new Map(),
        startTime,
        safetyConfig,
        // Threaded explicitly rather than read off `this` — the executor is a
        // process-wide singleton, and a mutable `this.currentWorkflow` let
        // concurrent runs read each other's graph (see executeLoopNode).
        workflow,
      };

      // Find start nodes (nodes with no incoming edges)
      const startNodes = this.findStartNodes(nodes, edges);

      if (startNodes.length === 0) {
        throw new Error('Workflow has no start nodes');
      }

      // Execute nodes in topological order
      await this.executeNodes(nodes, edges, startNodes, context, nodeResults, state);

      const endTime = Date.now();
      const result: WorkflowExecutionResult = {
        success: true,
        executionId,
        workflowId: workflow.id,
        startTime,
        endTime,
        duration: endTime - startTime,
        outputs: context,
        nodeResults,
      };

      logger.info('[WorkflowExecutor] Workflow execution completed', {
        executionId,
        duration: result.duration,
      });

      // Emit workflow completed event
      eventBus.emitEvent('workflow:execution:completed', result);

      return result;
    } catch (error) {
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('[WorkflowExecutor] Workflow execution failed', {
        executionId,
        error: errorMessage,
      });

      const result: WorkflowExecutionResult = {
        success: false,
        executionId,
        workflowId: workflow.id,
        nodeResults,
        startTime,
        endTime,
        duration: endTime - startTime,
        outputs: context,
        error: errorMessage,
      };

      // Emit workflow failed event
      eventBus.emitEvent('workflow:execution:failed', result);

      return result;
    }
  }

  /**
   * Find nodes with no incoming edges (start nodes)
   */
  private findStartNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
    const nodesWithIncoming = new Set(edges.map(e => e.target));
    return nodes.filter(node => !nodesWithIncoming.has(node.id));
  }

  /**
   * Execute nodes in the workflow
   */
  private async executeNodes(
    nodes: WorkflowNode[],
    edges: WorkflowEdge[],
    nodesToExecute: WorkflowNode[],
    context: WorkflowContext,
    nodeResults: Record<string, NodeExecutionResult>,
    state: ExecutionState
  ): Promise<void> {
    // Build adjacency map for quick lookups
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const childrenMap = this.buildChildrenMap(edges);

    // Execute nodes using BFS with visit counting. A `null` entry marks the
    // boundary of one full pass over the queue — used below to detect a
    // stalled pass (see PASS_BOUNDARY handling) instead of spinning forever.
    const PASS_BOUNDARY = null;
    const queue: (WorkflowNode | null)[] = [...nodesToExecute, PASS_BOUNDARY];
    const executedOnce = new Set<string>();
    let progressInPass = false;
    // Nodes forced past the parent-completeness gate after a stalled pass.
    // The normal cause is a conditional whose branches rejoin: the untaken
    // branch's parent edge can never be satisfied, since executeNodes only
    // ever queues children of the taken branch. Once a pass produces zero
    // executions, the remaining queued nodes are provably stuck waiting on
    // parents that will never run — so their gate is dropped and they run
    // with whatever context is available.
    const forcedNodeIds = new Set<string>();

    while (queue.length > 0) {
      const item = queue.shift()!;

      if (item === PASS_BOUNDARY) {
        if (queue.length === 0) break;

        if (!progressInPass) {
          const starvedIds = queue
            .filter((n): n is WorkflowNode => n !== PASS_BOUNDARY)
            .map(n => n.id);
          logger.warn(
            '[WorkflowExecutor] Nodes stalled on parents that will never execute (likely an untaken conditional branch); forcing them through',
            { nodeIds: starvedIds }
          );
          for (const id of starvedIds) forcedNodeIds.add(id);
        }

        progressInPass = false;
        queue.push(PASS_BOUNDARY);
        // Yield to the event loop between passes. Without this, a workflow
        // whose nodes can never all satisfy the parent gate spun this loop
        // synchronously for the full maxExecutionTime, freezing the main
        // process (IPC, streaming, the tray) for the entire window.
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }

      const node = item;

      // Safety check: workflow timeout
      if (Date.now() - state.startTime > state.safetyConfig.maxExecutionTime) {
        throw new Error(`Workflow execution timeout (${state.safetyConfig.maxExecutionTime}ms exceeded)`);
      }

      // Safety check: max nodes executed
      if (state.totalNodesExecuted >= state.safetyConfig.maxNodesExecuted) {
        throw new Error(`Max nodes executed limit reached (${state.safetyConfig.maxNodesExecuted})`);
      }

      // Get visit count for this node
      const visitCount = state.visitCounts.get(node.id) || 0;

      // For loop nodes, we allow re-execution up to safety limits
      // For other nodes, only execute once unless inside a loop
      const isLoopNode = node.type === 'loop';
      const insideLoop = state.loopStack.length > 0;
      const maxVisits = isLoopNode ? state.safetyConfig.maxLoopIterations : (insideLoop ? state.safetyConfig.maxLoopIterations : 1);

      if (visitCount >= maxVisits) {
        logger.warn('[WorkflowExecutor] Node exceeded max visits', {
          nodeId: node.id,
          visitCount,
          maxVisits,
        });
        continue;
      }

      // Check if all parent nodes have been executed at least once
      const parentEdges = edges.filter(e => e.target === node.id);
      const allParentsExecutedOnce = parentEdges.every(e => executedOnce.has(e.source));

      if (!allParentsExecutedOnce && !executedOnce.has(node.id) && !forcedNodeIds.has(node.id)) {
        // Re-queue this node for later (only if it hasn't been executed once yet)
        queue.push(node);
        continue;
      }

      // Execute the node
      progressInPass = true;
      forcedNodeIds.delete(node.id);
      const result = await this.executeNode(node, context, state);
      nodeResults[node.id] = result;
      executedOnce.add(node.id);

      // Update visit count and total nodes executed
      state.visitCounts.set(node.id, visitCount + 1);
      state.totalNodesExecuted++;

      // Handle node execution result
      if (!result.success) {
        throw new Error(`Node ${node.id} failed: ${result.error}`);
      }

      // Check for break signal
      if (result.breakLoop && state.loopStack.length > 0) {
        const currentLoop = state.loopStack[state.loopStack.length - 1];
        state.breakFlags.set(currentLoop, true);
        logger.info('[WorkflowExecutor] Break signal received for loop', { loopId: currentLoop });
        // Don't queue children when breaking
        continue;
      }

      // Store node output in context
      if (result.output !== undefined) {
        context[node.id] = result.output;
      }

      // Queue child nodes, filtering by sourceHandle for conditional branching
      const childEdges = childrenMap.get(node.id) || [];

      for (const childEdge of childEdges) {
        // For conditional nodes, only follow the branch matching the condition result
        if (node.type === 'conditional' && childEdge.sourceHandle) {
          const conditionResult = (result.output as { condition?: boolean })?.condition;
          const branchMatch = String(conditionResult) === childEdge.sourceHandle;
          if (!branchMatch) {
            continue;
          }
        }

        const childNode = nodeMap.get(childEdge.target);
        if (childNode) {
          queue.push(childNode);
        }
      }
    }
  }

  /**
   * Build a map of node ID to child edges (preserves sourceHandle for conditional routing)
   */
  private buildChildrenMap(edges: WorkflowEdge[]): Map<string, { target: string; sourceHandle?: string | null }[]> {
    const map = new Map<string, { target: string; sourceHandle?: string | null }[]>();

    for (const edge of edges) {
      const children = map.get(edge.source) || [];
      children.push({ target: edge.target, sourceHandle: edge.sourceHandle });
      map.set(edge.source, children);
    }

    return map;
  }

  /**
   * Execute a single node
   */
  private async executeNode(
    node: WorkflowNode,
    context: WorkflowContext,
    state: ExecutionState
  ): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    logger.info('[WorkflowExecutor] Executing node', {
      nodeId: node.id,
      nodeType: node.type,
    });

    try {
      let output: unknown;
      let breakLoop = false;

      switch (node.type) {
        case 'http':
          output = await this.executeHttpNode(node, context);
          break;

        case 'code':
          output = await this.executeCodeNode(node, context, state);
          break;

        case 'conditional':
          output = await this.executeConditionalNode(node, context);
          break;

        case 'agent':
          output = await this.executeAgentNode(node, context, state);
          break;

        case 'delay':
          output = await this.executeDelayNode(node);
          break;

        case 'loop':
          output = await this.executeLoopNode(node, context, state);
          break;

        case 'break': {
          const result = await this.executeBreakNode(node, context);
          output = result.output;
          breakLoop = result.shouldBreak;
          break;
        }

        case 'webscraper':
          output = await this.executeWebScraperNode(node, context);
          break;

        case 'note':
          output = await this.executeNoteNode(node, context, state);
          break;

        case 'task':
          output = await this.executeTaskNode(node, context, state);
          break;

        case 'start':
        case 'end':
        case 'action':
        // The visual editor's canvas emits 'input'/'output' as its own
        // start/end markers (WorkflowEditor.tsx) — not in the agent-facing
        // WORKFLOW_NODE_TYPES enum, but the same no-op semantics as 'start'/'end'.
        case 'input':
        case 'output':
          output = { passed: true, type: node.type };
          break;

        default:
          // A node type the executor has no handler for must not report
          // success — that previously let e.g. the editor's 'transformNode'
          // (which carries a real script) silently no-op while the workflow
          // came back green.
          throw new Error(`Unknown node type "${node.type}" (node ${node.id}) — the executor has no handler for it and cannot run it.`);
      }

      const duration = Date.now() - startTime;

      return {
        nodeId: node.id,
        success: true,
        output,
        duration,
        breakLoop,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('[WorkflowExecutor] Node execution failed', {
        nodeId: node.id,
        error: errorMessage,
      });

      return {
        nodeId: node.id,
        success: false,
        output: null,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * Execute an HTTP node
   */
  private async executeHttpNode(node: WorkflowNode, context: WorkflowContext): Promise<unknown> {
    const data = node.data as unknown as HttpNodeData;
    const { url, method = 'GET', headers = {}, body } = data;

    if (!url) {
      throw new Error('HTTP node missing URL');
    }

    // Resolve variables in URL, headers, and body
    const resolvedUrl = this.resolveVariables(url, context);
    const resolvedHeaders = this.resolveVariables(headers, context) as Record<string, string>;
    const resolvedBody = body ? this.resolveVariables(body, context) : undefined;

    // SSRF guard, applied to the *resolved* URL — a template can be
    // `${...}`-interpolated from a prior node's fetched content, so a check
    // on the raw template would miss it. This used to live only in
    // ipc/workflows.ts's `workflow:http-request` handler, which nothing
    // called; this fetch is the actual reachable path.
    const urlValidation = validateWorkflowUrl(resolvedUrl);
    if (!urlValidation.valid) {
      throw new Error(urlValidation.error);
    }

    const upperMethod = method.toUpperCase();
    if (!WORKFLOW_HTTP_ALLOWED_METHODS.includes(upperMethod)) {
      throw new Error(`Invalid HTTP method: ${method}. Allowed: ${WORKFLOW_HTTP_ALLOWED_METHODS.join(', ')}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response: Response;
    try {
      response = await fetch(resolvedUrl, {
        method: upperMethod,
        headers: resolvedHeaders,
        body: resolvedBody && upperMethod !== 'GET' ? String(resolvedBody) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const contentType = response.headers.get('content-type');
    let responseData: unknown;

    if (contentType && /application\/json|[+/]json\b/.test(contentType)) {
      responseData = await response.json();
    } else if (contentType?.includes('text')) {
      responseData = await response.text();
    } else {
      const buffer = await response.arrayBuffer();
      responseData = Buffer.from(buffer).toString('base64');
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: responseData,
    };
  }

  /**
   * Execute a code node (runs arbitrary JS/Python/Shell in a subprocess).
   */
  private async executeCodeNode(node: WorkflowNode, context: WorkflowContext, state: ExecutionState): Promise<unknown> {
    const data = node.data as unknown as CodeNodeData;
    const { code, language = 'javascript', timeout } = data;

    if (!code) {
      throw new Error('Code node missing `code` field');
    }

    logger.info('[WorkflowExecutor] Executing code node', {
      nodeId: node.id,
      language,
    });

    // Emit start event
    eventBus.emitEvent('workflow:node:executing', {
      workflowId: state.workflow.id,
      nodeId: node.id,
      nodeType: 'code',
      language,
    });

    try {
      const codeExecutor = getCodeExecutor();

      // Validate language
      const validLanguages: ExecutionLanguage[] = ['javascript', 'python', 'shell'];
      if (!validLanguages.includes(language as ExecutionLanguage)) {
        throw new Error(`Unsupported language: ${language}. Supported: ${validLanguages.join(', ')}`);
      }

      // Execute code with workflow context available
      const result = await codeExecutor.execute({
        language: language as ExecutionLanguage,
        code,
        context, // Inject workflow context (previous node outputs, loop vars, etc.)
        // `timeout` is milliseconds. Floor it: agents that reason in seconds
        // set values like `10`, which would otherwise be a 10ms instant-timeout
        // with a useless "Execution timed out" error.
        timeout: Math.max(timeout ?? 30000, 1000),
        maxMemory: 256, // MB
      });

      if (!result.success) {
        throw new Error(`Code execution failed: ${result.stderr || result.error || 'Unknown error'}`);
      }

      logger.info('[WorkflowExecutor] Code node completed', {
        nodeId: node.id,
        executionTime: result.executionTime,
        hasReturnValue: result.returnValue !== undefined,
        hasArtifacts: !!result.artifacts,
      });

      // Emit success event
      eventBus.emitEvent('workflow:node:completed', {
        workflowId: state.workflow.id,
        nodeId: node.id,
        executionTime: result.executionTime,
      });

      // Return the return value or stdout
      return result.returnValue !== undefined ? result.returnValue : result.stdout;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[WorkflowExecutor] Code node failed', {
        nodeId: node.id,
        error: errorMessage,
      });

      // Emit error event
      eventBus.emitEvent('workflow:node:error', {
        workflowId: state.workflow.id,
        nodeId: node.id,
        error: errorMessage,
      });

      throw error;
    }
  }

  /**
   * Execute a conditional node
   */
  private async executeConditionalNode(node: WorkflowNode, context: WorkflowContext): Promise<unknown> {
    const data = node.data as unknown as ConditionalNodeData;
    const { condition, operator, value } = data;

    if (!condition) {
      throw new Error('Conditional node missing condition field');
    }

    // Resolve the condition value from context
    const actualValue = this.resolveVariables(condition, context);
    const compareValue = this.resolveVariables(value, context);

    let result = false;

    switch (operator) {
      case 'equals':
        result = String(actualValue) === String(compareValue);
        break;
      case 'notEquals':
        result = String(actualValue) !== String(compareValue);
        break;
      case 'contains':
        result = String(actualValue).includes(String(compareValue));
        break;
      case 'greaterThan':
        result = Number(actualValue) > Number(compareValue);
        break;
      case 'lessThan':
        result = Number(actualValue) < Number(compareValue);
        break;
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }

    return { condition: result, actualValue, compareValue };
  }

  /**
   * Execute an agent node — sends a prompt to an agent and returns the response
   */
  private async executeAgentNode(node: WorkflowNode, context: WorkflowContext, state: ExecutionState): Promise<unknown> {
    const data = node.data as unknown as AgentNodeData;
    const { agentId, prompt, systemPromptOverride, temperature } = data;
    // The node's output cap arrives under either spelling: `maxTokens` is what
    // the create_workflow tool documents (and all an agent-authored graph
    // carries), `maxOutputTokens` is what stored graphs may carry. Read both so
    // a cap is never silently dropped.
    const maxOutputTokens = data.maxOutputTokens ?? data.maxTokens;

    if (!prompt) {
      throw new Error('Agent node missing prompt');
    }

    const resolvedPrompt = this.resolveVariables(prompt, context);
    const resolvedSystemPrompt = systemPromptOverride
      ? this.resolveVariables(systemPromptOverride, context)
      : undefined;

    // Load the target agent, or build a default
    let agent: Agent;
    if (agentId) {
      const loaded = getAgentRepository().getById(agentId);
      if (!loaded) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      agent = loaded;
    } else {
      // No explicit agent on the node — fall through to the user's pinned
      // system agent (systemAgentId → defaultAgentId → first available).
      const resolved = resolveSystemAgent();
      if (!resolved) {
        throw new Error('No agents available — create an agent first');
      }
      agent = resolved;
    }

    // Apply overrides
    if (temperature !== undefined) agent = { ...agent, temperature };
    if (maxOutputTokens !== undefined) agent = { ...agent, maxOutputTokens };

    logger.info('[WorkflowExecutor] Executing agent node', {
      nodeId: node.id,
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.provider,
      model: agent.model,
    });

    // Node events were emitted only from the code-node path, so an agent doing
    // real work inside a scheduled workflow produced no agent-attributed
    // activity anywhere: the routine and workflow rows name a schedule and a
    // graph, and neither names an agent. This is the only point in the
    // routine → workflow → node chain where an agent is actually the actor.
    // Audience stays 'system' (as for code nodes) so the default feed's noise
    // level is unchanged; the rows exist to be queried by agent.
    eventBus.emitEvent('workflow:node:executing', {
      workflowId: state.workflow.id,
      nodeId: node.id,
      nodeType: 'agent',
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model,
      provider: agent.provider,
    });

    // Non-interactive path — mirrors the minimal AppState every other
    // scheduled/backgrounded turn builds (chatHelpers.ts, compaction.ts,
    // ShadowService.ts, AgentTurnService.ts), rather than calling
    // loadAppState(), which reports currentProjectId as whatever project the
    // UI last had selected. A workflow's projectId is its own, known value —
    // scope to that instead of the ambient UI selection.
    const memory = {
      settings: getSettingsRepository().get(),
      users: [],
      agents: [],
      projects: [],
      channels: [],
      currentProjectId: state.workflow.projectId,
      currentAgentId: null,
      currentChannelId: null,
      currentUserId: null,
    };
    const systemPrompt = resolvedSystemPrompt || agent.systemPrompt || agent.description || undefined;
    const messages = [{ role: 'user' as const, content: String(resolvedPrompt) }];

    let response = '';
    const nodeMetrics = createStreamMetrics();
    try {
      // Workflow agent nodes run without a human present — flag as
      // non-interactive so toolGating strips any needsApproval tools. With
      // tools=undefined below the flag is a no-op, but it states the policy at
      // the call site: wiring tools in here without it would hang the workflow
      // on an approval prompt nobody can answer.
      for await (const event of streamAIResponse(
        agent, memory, messages, systemPrompt,
        undefined, undefined, undefined, undefined,
        { nonInteractive: true, contextLabel: `workflow:${node.id}` },
      )) {
        if (typeof event === 'string') {
          response += event;
        } else {
          trackUsage(event, nodeMetrics);
        }
      }
    } catch (error) {
      // Report what the failed attempt already cost before rethrowing.
      emitAgentSpend(agent, nodeMetrics, { kind: 'workflow-node', containerId: state.workflow.id });
      eventBus.emitEvent('workflow:node:error', {
        workflowId: state.workflow.id,
        nodeId: node.id,
        nodeType: 'agent',
        agentId: agent.id,
        agentName: agent.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    logger.info('[WorkflowExecutor] Agent node completed', {
      nodeId: node.id,
      responseLength: response.length,
    });

    emitAgentSpend(agent, nodeMetrics, { kind: 'workflow-node', containerId: state.workflow.id });

    eventBus.emitEvent('workflow:node:completed', {
      workflowId: state.workflow.id,
      nodeId: node.id,
      nodeType: 'agent',
      agentId: agent.id,
      agentName: agent.name,
      responseLength: response.length,
      totalTokens: nodeMetrics.totalTokens,
      cost: nodeMetrics.cost,
    });

    return {
      response,
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model,
      provider: agent.provider,
    };
  }

  /**
   * Execute a delay node
   */
  private async executeDelayNode(node: WorkflowNode): Promise<{ delayed: number }> {
    const data = node.data as unknown as DelayNodeData;
    const { duration = 5, unit = 'seconds' } = data;

    let milliseconds: number;

    switch (unit) {
      case 'seconds':
        milliseconds = duration * 1000;
        break;
      case 'minutes':
        milliseconds = duration * 60 * 1000;
        break;
      case 'hours':
        milliseconds = duration * 60 * 60 * 1000;
        break;
      default:
        logger.warn(`[WorkflowExecutor] Unknown delay unit "${unit}", defaulting to seconds`);
        milliseconds = duration * 1000;
    }

    await new Promise(resolve => setTimeout(resolve, milliseconds));

    return { delayed: milliseconds };
  }

  /**
   * Identify the loop body subgraph
   * Finds all nodes between the "body" handle and the "next" handle
   */
  private identifyLoopBody(loopNodeId: string, allNodes: WorkflowNode[], allEdges: WorkflowEdge[]): Subgraph {
    // Find edges from the loop node's "body" handle
    const bodyEdges = allEdges.filter(e =>
      e.source === loopNodeId && e.sourceHandle === 'body'
    );

    if (bodyEdges.length === 0) {
      // No loop body defined
      return {
        nodes: [],
        edges: [],
        entryNodeIds: [],
        exitNodeIds: [],
      };
    }

    // Entry nodes are those connected to the "body" handle
    const entryNodeIds = bodyEdges.map(e => e.target);
    const subgraphNodeIds = new Set<string>(entryNodeIds);

    // Traverse from entry nodes to find all nodes in the loop body
    // Stop when we encounter an edge back to the loop node's input handles
    const queue = [...entryNodeIds];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      // Find outgoing edges from this node
      const outgoingEdges = allEdges.filter(e => e.source === nodeId);

      for (const edge of outgoingEdges) {
        // If edge goes back to the loop node, this is an exit node
        if (edge.target === loopNodeId) {
          // Don't traverse further, but mark as exit node
          continue;
        }

        // Otherwise, add to subgraph and continue traversal
        if (!subgraphNodeIds.has(edge.target)) {
          subgraphNodeIds.add(edge.target);
          queue.push(edge.target);
        }
      }
    }

    // Extract nodes and edges that belong to the subgraph
    const subgraphNodes = allNodes.filter(n => subgraphNodeIds.has(n.id));
    const subgraphEdges = allEdges.filter(e =>
      subgraphNodeIds.has(e.source) && subgraphNodeIds.has(e.target)
    );

    // Find exit nodes (nodes that have edges back to loop node)
    const exitNodeIds = allEdges
      .filter(e => subgraphNodeIds.has(e.source) && e.target === loopNodeId)
      .map(e => e.source);

    logger.debug('[WorkflowExecutor] Identified loop body', {
      loopNodeId,
      nodeCount: subgraphNodes.length,
      edgeCount: subgraphEdges.length,
      entryNodes: entryNodeIds,
      exitNodes: exitNodeIds,
    });

    return {
      nodes: subgraphNodes,
      edges: subgraphEdges,
      entryNodeIds,
      exitNodeIds,
    };
  }

  /**
   * Execute a subgraph with isolated context
   * Used for loop bodies and conditional branches
   */
  private async executeSubgraph(
    subgraph: Subgraph,
    parentContext: WorkflowContext,
    parentState: ExecutionState
  ): Promise<WorkflowContext> {
    if (subgraph.nodes.length === 0) {
      return {};
    }

    // Create scoped context with deep clone to prevent mutations leaking to parent
    // This ensures loop iterations are properly isolated from each other
    const scopedContext: WorkflowContext = JSON.parse(JSON.stringify(parentContext));
    const nodeResults: Record<string, NodeExecutionResult> = {};

    // Create scoped state (shares visit counts and safety config with parent)
    const scopedState: ExecutionState = {
      ...parentState,
      // Note: We share visitCounts and breakFlags with parent for proper loop tracking
    };

    // Find entry nodes in the subgraph
    const entryNodes = subgraph.nodes.filter(n =>
      subgraph.entryNodeIds.includes(n.id)
    );

    if (entryNodes.length === 0) {
      logger.warn('[WorkflowExecutor] Subgraph has no entry nodes');
      return scopedContext;
    }

    // Execute the subgraph nodes
    await this.executeNodes(
      subgraph.nodes,
      subgraph.edges,
      entryNodes,
      scopedContext,
      nodeResults,
      scopedState
    );

    return scopedContext;
  }

  /**
   * Execute a loop node (iterates over collection and executes loop body)
   */
  private async executeLoopNode(
    node: WorkflowNode,
    context: WorkflowContext,
    state: ExecutionState
  ): Promise<unknown> {
    const data = node.data as unknown as LoopNodeData;
    const { collection, variable = 'item', maxIterations, collectResults = true } = data;

    if (!collection) {
      throw new Error('Loop node missing collection');
    }

    // Safety check: loop depth
    if (state.loopStack.length >= state.safetyConfig.maxLoopDepth) {
      throw new Error(`Max loop depth exceeded (${state.safetyConfig.maxLoopDepth})`);
    }

    const items = this.resolveVariables(collection, context);

    if (!Array.isArray(items)) {
      throw new Error('Loop collection must be an array');
    }

    // Get loop iteration limit (node-specific or workflow default)
    const iterationLimit = maxIterations ?? state.safetyConfig.maxLoopIterations;

    logger.info('[WorkflowExecutor] Starting loop execution', {
      nodeId: node.id,
      itemCount: items.length,
      iterationLimit,
      variable,
    });

    // Add this loop to the stack
    state.loopStack.push(node.id);
    state.breakFlags.set(node.id, false);

    // Identify loop body subgraph (nodes between "body" and "next" handles)
    // Read off the run's own workflow (threaded through `state`), not a
    // singleton field — the executor is process-wide, and concurrent runs
    // would otherwise look up the loop body in each other's graph.
    const allNodes = state.workflow.dagDefinition?.nodes || [];
    const allEdges = state.workflow.dagDefinition?.edges || [];
    const loopBody = this.identifyLoopBody(node.id, allNodes, allEdges);

    const results: WorkflowContext[] = [];
    let iterationsRun = 0;

    try {
      // Execute loop body for each item
      for (let i = 0; i < items.length && i < iterationLimit; i++) {
        // Check for break flag
        if (state.breakFlags.get(node.id)) {
          logger.info('[WorkflowExecutor] Loop break triggered', {
            nodeId: node.id,
            iteration: i,
          });
          break;
        }

        // Create loop iteration context
        const loopContext: WorkflowContext = {
          ...context,
          [variable]: items[i],
          [`${variable}_index`]: i,
          [`${variable}_count`]: items.length,
        };

        logger.debug('[WorkflowExecutor] Loop iteration', {
          nodeId: node.id,
          iteration: i,
          item: items[i],
        });

        // Execute the loop body subgraph
        const iterationResult = await this.executeSubgraph(
          loopBody,
          loopContext,
          state
        );

        if (collectResults) {
          results.push(iterationResult);
        }

        iterationsRun++;
      }

      logger.info('[WorkflowExecutor] Loop execution completed', {
        nodeId: node.id,
        iterationsRun,
        totalItems: items.length,
      });

      return {
        items,
        results: collectResults ? results : undefined,
        iterations: iterationsRun,
        completed: iterationsRun === Math.min(items.length, iterationLimit),
        broken: state.breakFlags.get(node.id) || false,
      };

    } finally {
      // Remove loop from stack and clear break flag
      state.loopStack.pop();
      state.breakFlags.delete(node.id);
    }
  }

  /**
   * Break node - signals loop to exit early
   */
  private async executeBreakNode(
    node: WorkflowNode,
    context: WorkflowContext
  ): Promise<{ output: unknown; shouldBreak: boolean }> {
    const data = node.data as unknown as BreakNodeData;
    const { condition } = data;

    if (!condition) {
      throw new Error('Break node missing condition');
    }

    const conditionValue = this.resolveVariables(condition, context);
    const shouldBreak = Boolean(conditionValue);

    logger.info('[WorkflowExecutor] Break node evaluated', {
      nodeId: node.id,
      shouldBreak,
    });

    return {
      output: { shouldBreak, condition, conditionValue },
      shouldBreak,
    };
  }

  /**
   * Web scraper node - fetches and extracts text from a URL
   */
  /**
   * Resolve a sink node's `content`, which is the whole point of the node —
   * an unresolved or empty body means the run delivered nothing, so treat it
   * as a failure rather than posting a blank.
   */
  private resolveSinkContent(node: WorkflowNode, context: WorkflowContext): string {
    const { content } = node.data as unknown as { content?: string };

    if (!content) {
      throw new Error(`${node.type} node missing content`);
    }

    const resolved = this.resolveVariables(content, context).trim();

    if (!resolved) {
      throw new Error(
        `${node.type} node resolved to empty content — check the \${node-id} references in it`
      );
    }

    return resolved;
  }

  private async executeNoteNode(
    node: WorkflowNode,
    context: WorkflowContext,
    state: ExecutionState
  ): Promise<unknown> {
    const content = this.resolveSinkContent(node, context);
    const { title } = node.data as unknown as { title?: string };

    const note = getProjectRepository().createNote(state.workflow.projectId, {
      content,
      title: title ? this.resolveVariables(title, context) : undefined,
    });

    logger.info('[WorkflowExecutor] Note node created note', { noteId: note.id, nodeId: node.id });

    return { noteId: note.id, content };
  }

  private async executeTaskNode(
    node: WorkflowNode,
    context: WorkflowContext,
    state: ExecutionState
  ): Promise<unknown> {
    const content = this.resolveSinkContent(node, context);

    const task = getProjectRepository().createTask(state.workflow.projectId, { content });

    logger.info('[WorkflowExecutor] Task node created task', { taskId: task.id, nodeId: node.id });

    return { taskId: task.id, content };
  }

  private async executeWebScraperNode(node: WorkflowNode, context: WorkflowContext): Promise<unknown> {
    const data = node.data as unknown as WebScraperNodeData;
    const { url, timeout = 10000 } = data;

    if (!url) {
      throw new Error('Web scraper node missing URL');
    }

    const resolvedUrl = this.resolveVariables(url, context);

    logger.info('[WorkflowExecutor] Web scraper starting', {
      nodeId: node.id,
      url: resolvedUrl,
    });

    try {
      const response = await fetch(resolvedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(timeout),
      });

      const html = await response.text();

      if (!html || typeof html !== 'string') {
        throw new Error('Invalid response from URL - no content received');
      }

      // Strip scripts, styles, comments, and tags
      let content = html
        .replace(/<!--[\s\S]*?-->/g, '') // Remove HTML comments first
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, ' ') // More precise tag matching
        .replace(/\s+/g, ' ')
        .trim();

      // Limit length
      if (content.length > 10000) {
        content = content.substring(0, 10000) + '...';
      }

      logger.info('[WorkflowExecutor] Web scraper completed', {
        nodeId: node.id,
        contentLength: content.length,
      });

      return { url: resolvedUrl, content, contentLength: content.length };
    } catch (error) {
      logger.error('[WorkflowExecutor] Web scraper failed', {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Resolve variables in a value (supports dot notation like "response.data")
   * Uses safe string interpolation without code execution
   */
  private resolveVariables(value: string, context: WorkflowContext): string;
  private resolveVariables(value: unknown, context: WorkflowContext): unknown;
  private resolveVariables(value: unknown, context: WorkflowContext): unknown {
    if (typeof value === 'string') {
      // Replace ${variable} or $variable patterns with safe lookups
      return value.replace(/\$\{([^}]+)\}|\$(\w+(?:\.\w+)*)/g, (match, p1, p2) => {
        const path = (p1 || p2).split('.');
        let result: unknown = context;

        for (const key of path) {
          if (result && typeof result === 'object' && result !== null && key in result) {
            result = (result as Record<string, unknown>)[key];
          } else {
            return match; // Return original if path not found
          }
        }

        if (result === undefined || result === null) return '';

        // A bare ${node-id} resolves to that node's whole result, and every
        // node that produces anything interesting produces an object — so
        // String() rendered the placeholder the sink-node UI teaches as
        // "[object Object]". Reach for the text the node actually produced.
        if (typeof result === 'object') return textFromResult(result);

        return String(result);
      });
    } else if (typeof value === 'object' && value !== null) {
      // Recursively resolve objects
      if (Array.isArray(value)) {
        return value.map(item => this.resolveVariables(item, context));
      }
      const resolved: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        resolved[key] = this.resolveVariables(val, context);
      }
      return resolved;
    }

    return value;
  }
}

// Singleton instance
let workflowExecutor: WorkflowExecutor | null = null;

export function getWorkflowExecutor(): WorkflowExecutor {
  if (!workflowExecutor) {
    workflowExecutor = new WorkflowExecutor();
  }
  return workflowExecutor;
}
