import { tool } from 'ai';
import { z } from 'zod/v3';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getProjectRepository, getSettingsRepository, getRoutineRepository, getWorkflowRepository } from '../repositories';
import { getProjectRoots } from './projectRoots';
import { scopedProjectId } from './projectScope';
import { eventBus } from './EventBus';
import { RoutineScheduler } from './RoutineScheduler';
import { getCodeExecutor } from './CodeExecutor';
import { getServiceRegistry } from './ServiceRegistry';
import { Routine, Workflow } from '../../shared/types';
import { WORKFLOW_NODE_TYPES, validateNodeData, type WorkflowNodeType } from '../../shared/workflowNodeTypes';
import { TOOL_DOCS } from './toolDocs';
import { guideTopicIndex, lookupGuideTopic } from './eavesGuide';
import { deferTool } from './toolDeferral';

/**
 * Built-in tools that give agents access to Eaves's task and note management
 */

/**
 * Cap a tool-result stream (stdout/stderr) before it becomes a tool-result
 * message part. That part is persisted and RE-SENT to the model on every
 * subsequent turn, so an unbounded blob (beta runs produced multi-MB stderr
 * from a runaway command) silently inflates context cost turn after turn.
 * Keep the head and the tail — errors usually surface at the end — and mark
 * what was dropped. The executor's own logs retain the full output.
 */
/**
 * Keep a tool result readable. A node's output can be a whole agent turn or an
 * HTTP body, and dumping it verbatim buries the thing the caller asked for.
 */
function truncateForTool(value: unknown, limit = 2000): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return String(value).slice(0, limit);
  }
  if (json === undefined) return undefined;
  if (json.length <= limit) return value;
  return `${json.slice(0, limit)}… [truncated, ${json.length} chars total]`;
}

/**
 * Reject a graph whose nodes are missing the `data` their type needs, before it
 * is stored and queued for review.
 *
 * Without this an agent could store a `code` node with no `code`, get
 * `success: true`, and only discover the graph was never runnable when a
 * scheduled routine fired days later. It also carries the correction: since the
 * node grammar left the tool description (see toolDocs.ts), a rejection is how
 * a caller that guessed learns the real shape.
 */
export function assertValidGraph(
  dagDefinition: { nodes: Array<{ id: string; type: string; data?: Record<string, unknown> }> } | undefined
): void {
  const problems = (dagDefinition?.nodes ?? [])
    .map(node => {
      const message = validateNodeData(node.type as WorkflowNodeType, node.data);
      return message ? `node "${node.id}": ${message}` : null;
    })
    .filter((m): m is string => m !== null);

  if (problems.length > 0) {
    throw new Error(
      `Workflow not saved — ${problems.length} node(s) have invalid data:\n${problems.join('\n')}`
    );
  }
}

export const MAX_TOOL_STREAM_CHARS = 8000;
export function clampToolStream(text: string): string {
  if (text.length <= MAX_TOOL_STREAM_CHARS) return text;
  const head = Math.floor(MAX_TOOL_STREAM_CHARS * 0.7);
  const tail = MAX_TOOL_STREAM_CHARS - head;
  const dropped = text.length - MAX_TOOL_STREAM_CHARS;
  return (
    text.slice(0, head) +
    `\n\n…[truncated ${dropped.toLocaleString()} of ${text.length.toLocaleString()} chars — full output in execution logs]…\n\n` +
    text.slice(text.length - tail)
  );
}

// Cron schedules are evaluated in the server's local timezone (RoutineScheduler
// works in local Date fields), so surface it in the routine tool descriptions —
// "0 9 * * *" is ambiguous without a reference zone.
const SERVER_TIMEZONE: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'the server local timezone';
  } catch {
    return 'the server local timezone';
  }
})();

/**
 * The project this tool call belongs to: the turn's project when one bound the
 * scope, falling back to the UI selection. See projectScope.ts for why the
 * fallback is a floor rather than the primary answer.
 */
function activeProjectId(): string | null {
  return scopedProjectId() ?? getSettingsRepository().getCurrentState().projectId;
}

/**
 * Get all project directories the agent has access to.
 * Returns absolute paths for file operations.
 *
 * Includes the project workspace, so these tools work on a project with no
 * folders attached — see projectRoots.ts for the ordering contract.
 */
function getProjectDirectories(): string[] {
  return getProjectRoots(activeProjectId()).map(r => r.path);
}

/**
 * Resolve and validate a file path against project directories.
 * Prevents path traversal (../) outside allowed directories.
 * Symlinks are allowed — the bash confirmation gate prevents agents
 * from silently creating escape symlinks.
 *
 * Relative paths resolve against the first root: the oldest attached folder,
 * or the project workspace when nothing is attached.
 *
 * Exported as a named security contract for unit tests.
 */
export function resolveProjectPath(filePath: string): string {
  const dirs = getProjectDirectories();
  if (dirs.length === 0) {
    throw new Error('No project directories are available. Open a project first.');
  }

  // Resolve to absolute (handles ../ traversal)
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(dirs[0], filePath);

  // Check the logical path against project directories
  for (const dir of dirs) {
    if (resolved.startsWith(dir + path.sep) || resolved === dir) {
      return resolved;
    }
  }
  throw new Error('Access denied: path is outside project directories');
}

/** Sensitive file patterns that tools should never expose */
const SENSITIVE_FILE_PATTERNS = [
  '**/.env', '**/.env.*', '**/.env.local', '**/.env.production',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks',
  '**/id_rsa', '**/id_ed25519', '**/id_ecdsa', '**/id_dsa',
  '**/.ssh/**', '**/.gnupg/**',
  '**/credentials.json', '**/service-account*.json',
  '**/.npmrc', '**/.pypirc',
];

const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks']);
const SECRET_BASENAMES = new Set([
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  'credentials.json', '.npmrc', '.pypirc',
]);
const SECRET_DIRECTORIES = new Set(['.ssh', '.gnupg']);

/**
 * Whether a path names something that holds credentials.
 *
 * The second encoding of the SENSITIVE_FILE_PATTERNS policy above. Those are
 * globs because `glob` and `grep` pass them to an `ignore` option; this is a
 * predicate because a single-path tool has nothing to filter — it has to decide.
 * The two must agree, which a test pins by running every glob's canonical
 * example through here.
 *
 * Written out rather than delegating to a matcher so it pulls in no dependency
 * — least of all a transitive one — for a check that decides whether an agent
 * gets to read a private key.
 */
export function isSensitiveFile(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/');
  const segments = normalized.split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';

  if (segments.slice(0, -1).some(seg => SECRET_DIRECTORIES.has(seg))) return true;
  if (SECRET_BASENAMES.has(base)) return true;
  if (SECRET_EXTENSIONS.has(path.extname(base).toLowerCase())) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base.startsWith('service-account') && base.endsWith('.json')) return true;

  return false;
}

/**
 * Resolve a path for a tool that touches one specific file, refusing
 * credential files outright.
 *
 * `glob` and `grep` already hide these, so without this a model could not
 * *find* a private key but could still read one by naming it — and the block
 * has to cover writes too, since "overwrite the deploy key" is worse than
 * reading it.
 */
function resolveNonSecretPath(filePath: string): string {
  const resolved = resolveProjectPath(filePath);
  if (isSensitiveFile(resolved)) {
    throw new Error(
      `Access denied: ${filePath} looks like a credential file (key, certificate, .env or similar). `
      + 'These are withheld from tools by policy.',
    );
  }
  return resolved;
}

/** Dotted-quad octets, or null when the host is not a literal IPv4 address. */
function parseIPv4(hostname: string): number[] | null {
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/**
 * Bare IPv6 address, or null when the host is not a literal IPv6 address.
 * `URL.hostname` keeps IPv6 hosts bracketed, so the brackets come off here.
 */
function parseIPv6(hostname: string): string | null {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : null;
}

/** Leading 16-bit group of an IPv6 address, for prefix range tests. */
function ipv6FirstHextet(addr: string): number {
  if (addr.startsWith('::')) return 0;
  const first = addr.split(':')[0];
  return /^[0-9a-f]{1,4}$/.test(first) ? parseInt(first, 16) : -1;
}

/**
 * IPv4 embedded in an IPv4-mapped/compatible IPv6 address, else null.
 * Node normalizes `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`, so both
 * spellings have to decode back to octets.
 */
function ipv4FromMappedIPv6(addr: string): number[] | null {
  const hex = addr.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
  }
  const dotted = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  return dotted ? parseIPv4(dotted[1]) : null;
}

/**
 * Validate a URL for fetch operations.
 * Blocks localhost, private IPs, and non-HTTP protocols to prevent SSRF.
 *
 * Exported as a named security contract for unit tests.
 *
 * Known limit: this validates the URL as written. A public hostname that
 * *resolves* to a private address (DNS rebinding, `localtest.me`-style
 * wildcards) still passes — catching that needs the check reapplied to the
 * resolved peer address at connect time, which fetch does not expose.
 */
export function validateFetchUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Protocol not allowed: ${parsed.protocol}. Only http and https are permitted.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const ipv6 = parseIPv6(hostname);
  // An IPv4-mapped IPv6 host is judged on the IPv4 address it carries.
  const ipv4 = parseIPv4(hostname) ?? (ipv6 ? ipv4FromMappedIPv6(ipv6) : null);

  // Loopback / "this host". WHATWG URL already folds 2130706433, 0177.0.0.1,
  // 0x7f000001 and 127.1 into 127.0.0.1, so the octet test covers those too.
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    ipv4?.[0] === 127 ||
    (ipv4 && ipv4.every((o) => o === 0)) ||
    ipv6 === '::1' ||
    ipv6 === '::'
  ) {
    throw new Error('Localhost URLs are not permitted');
  }

  if (ipv4) {
    const [a, b] = ipv4;
    if (
      a === 0 ||                            // 0.0.0.0/8
      a === 10 ||                           // 10.0.0.0/8
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT)
      (a === 169 && b === 254) ||           // 169.254.0.0/16 (link-local, cloud metadata)
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12
      (a === 192 && b === 168) ||           // 192.168.0.0/16
      a >= 224                              // multicast + reserved
    ) {
      throw new Error('Private/internal IP addresses are not permitted');
    }
  }

  if (ipv6) {
    const hextet = ipv6FirstHextet(ipv6);
    if (
      (hextet & 0xfe00) === 0xfc00 || // fc00::/7 (unique local)
      (hextet & 0xffc0) === 0xfe80    // fe80::/10 (link-local)
    ) {
      throw new Error('Private/internal IP addresses are not permitted');
    }
  }
}

function getCurrentProject() {
  const settingsRepo = getSettingsRepository();
  const projectRepo = getProjectRepository();
  const currentState = settingsRepo.getCurrentState();
  // The turn's project, not the UI's. Tasks, notes, workflows and routines all
  // land here, so a channel agent used to file them against whichever project
  // happened to be on screen.
  const projectId = activeProjectId();
  if (!projectId) {
    throw new Error('No active project');
  }
  const project = projectRepo.getById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }
  return { settingsRepo, projectRepo, currentState: { ...currentState, projectId }, project };
}

export const builtinTools = {
  // Eaves is not in any model's training data, and list_tools/get_tool_info
  // only describe the agent's own capabilities — not the product around them.
  // Without this an agent asked "how do I set up a routine?" invents an answer
  // the user cannot check. Description stays one line on purpose: it rides
  // every turn, the content does not.
  eaves_guide: tool({
    description: 'How Eaves itself works: projects, chats, channels, memory, workflows, routines, plugins, settings. Call it rather than guessing about the app. Omit topic for the index.',
    inputSchema: z.object({
      topic: z.string().optional().describe('Topic id from the index.'),
    }),
    execute: async ({ topic }) => (topic ? lookupGuideTopic(topic) : guideTopicIndex()),
  }),

  list_tasks: tool({
    description: 'List tasks for the current project. Can filter to show only incomplete tasks.',
    inputSchema: z.object({
      includeCompleted: z.boolean().optional().describe('Whether to include completed tasks. Default: true'),
    }),
    execute: async ({ includeCompleted = true }) => {
      const { projectRepo, currentState, project } = getCurrentProject();

      const tasks = includeCompleted
        ? project.tasks
        : project.tasks.filter(t => !t.completed);

      return {
        projectName: project.name,
        taskCount: tasks.length,
        tasks: tasks.map((t, index) => ({
          index: index + 1,  // 1-based index for user-friendly reference
          id: t.id,  // IMPORTANT: Use this exact ID for toggle/delete operations
          content: t.content,
          completed: t.completed,
          createdAt: new Date(t.createdAt).toISOString(),
        })),
      };
    },
  }),

  add_task: tool({
    description: 'Add a new task to the current project',
    inputSchema: z.object({
      content: z.string().describe('The task description or content'),
    }),
    execute: async ({ content }) => {
      const { projectRepo, currentState } = getCurrentProject();

      const task = projectRepo.createTask(currentState.projectId, { content });
      eventBus.emitEvent('task:created', { taskId: task.id, projectId: currentState.projectId });
      return {
        success: true,
        task: {
          id: task.id,
          content: task.content,
          completed: task.completed,
          createdAt: new Date(task.createdAt).toISOString(),
        },
      };
    },
  }),

  toggle_task: tool({
    description: 'Toggle a task between completed and incomplete',
    inputSchema: z.object({
      taskId: z.string().describe('The ID of the task to toggle'),
    }),
    execute: async ({ taskId }) => {
      const projectRepo = getProjectRepository();
      const task = projectRepo.toggleTask(taskId);
      if (!task) {
        throw new Error(`Task with id ${taskId} not found`);
      }
      eventBus.emitEvent('task:toggled', { taskId: task.id });
      return {
        success: true,
        task: {
          id: task.id,
          content: task.content,
          completed: task.completed,
        },
      };
    },
  }),

  delete_task: tool({
    description: 'Delete a task from the current project',
    inputSchema: z.object({
      taskId: z.string().describe('The ID of the task to delete'),
    }),
    execute: async ({ taskId }) => {
      const { projectRepo, currentState, project } = getCurrentProject();

      const result = projectRepo.deleteTask(taskId);
      if (!result) {
        const availableTasks = project.tasks.map(t =>
          `${t.id} - "${t.content.substring(0, 50)}..." [${t.completed ? '✓' : ' '}]`
        ).join('\n  ');
        throw new Error(
          `Task with id ${taskId} not found in project "${project.name}".\n` +
          `Available tasks (${project.tasks.length}):\n  ${availableTasks || 'No tasks in this project'}`
        );
      }
      eventBus.emitEvent('task:deleted', { taskId });
      return { success: true };
    },
  }),

  list_notes: tool({
    description: 'List notes for the current project. Can search notes by content.',
    inputSchema: z.object({
      searchQuery: z.string().optional().describe('Optional search query to filter notes by content'),
    }),
    execute: async ({ searchQuery }) => {
      const { projectRepo, currentState, project } = getCurrentProject();

      let notes = project.notes;

      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        notes = notes.filter(note =>
          note.content.toLowerCase().includes(query)
        );
      }

      return {
        projectName: project.name,
        noteCount: notes.length,
        notes: notes.map((n, index) => ({
          index: index + 1,  // 1-based index for user-friendly reference
          id: n.id,  // IMPORTANT: Use this exact ID for delete/update operations
          content: n.content,
          createdAt: new Date(n.createdAt).toISOString(),
        })),
      };
    },
  }),

  add_note: tool({
    description: 'Add a new note to the current project',
    inputSchema: z.object({
      content: z.string().describe('The note content'),
    }),
    execute: async ({ content }) => {
      const { projectRepo, currentState } = getCurrentProject();

      const note = projectRepo.createNote(currentState.projectId, { content });
      eventBus.emitEvent('note:created', { noteId: note.id, projectId: currentState.projectId });
      return {
        success: true,
        note: {
          id: note.id,
          content: note.content,
          createdAt: new Date(note.createdAt).toISOString(),
        },
      };
    },
  }),

  delete_note: tool({
    description: 'Delete a note from the current project',
    inputSchema: z.object({
      noteId: z.string().describe('The ID of the note to delete'),
    }),
    execute: async ({ noteId }) => {
      const { projectRepo, currentState, project } = getCurrentProject();

      const result = projectRepo.deleteNote(noteId);
      if (!result) {
        const availableNotes = project.notes.map(n => `${n.id} - "${n.content.substring(0, 50)}..."`).join('\n  ');
        throw new Error(
          `Note with id ${noteId} not found in project "${project.name}".\n` +
          `Available notes (${project.notes.length}):\n  ${availableNotes || 'No notes in this project'}`
        );
      }
      eventBus.emitEvent('note:deleted', { noteId });
      return { success: true };
    },
  }),

  web_search: tool({
    description: 'Search the web using DuckDuckGo (no API key required). Returns a list of search results with titles, URLs, and snippets. Use this for research, finding information, or discovering resources.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
      maxResults: z.number().optional().describe('Maximum number of results to return (default: 10, max: 50)'),
    }),
    execute: async ({ query, maxResults = 10 }) => {
      const limit = Math.min(maxResults, 50);

      try {
        // Use DuckDuckGo HTML endpoint (no API key required)
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });

        if (!response.ok) {
          throw new Error(`Search failed with status ${response.status}`);
        }

        const html = await response.text();

        // Parse search results from HTML
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        // Simple regex-based parsing (DuckDuckGo HTML is relatively stable)
        const resultBlocks = html.split('result__body');

        for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
          try {
            const block = resultBlocks[i];

            // Extract title and URL with more robust regex
            const titleMatch = block.match(/result__a[^>]*href=["']([^"']+)["'][^>]*>(.+?)<\/a>/s);
            if (!titleMatch) continue;

            const rawUrl = titleMatch[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&')[0];
            const rawTitle = titleMatch[2].replace(/<[^>]+>/g, '').trim(); // Strip nested tags

            // Extract snippet
            const snippetMatch = block.match(/result__snippet[^>]*>(.+?)<\//s);
            const rawSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

            // Only decode the URL (already escaped), don't decode HTML-extracted text
            let decodedUrl = rawUrl;
            try {
              decodedUrl = decodeURIComponent(rawUrl);
            } catch {
              // Skip malformed URLs
              continue;
            }

            if (decodedUrl && rawTitle) {
              results.push({
                title: rawTitle, // Already extracted from HTML, don't decode
                url: decodedUrl,
                snippet: rawSnippet, // Already extracted from HTML, don't decode
              });
            }
          } catch (error) {
            // Log but don't fail entire search on parse error
            continue;
          }
        }

        return {
          query,
          resultCount: results.length,
          results,
        };
      } catch (error) {
        throw new Error(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  // ============================================
  // WORKFLOW MANAGEMENT TOOLS
  // ============================================

  list_workflows: tool({
    description: 'List all workflows for the current project. Workflows define DAG-based automation pipelines.',
    inputSchema: z.object({}),
    execute: async () => {
      const { currentState } = getCurrentProject();
      const workflowRepo = getWorkflowRepository();

      const workflows = workflowRepo.getByProjectId(currentState.projectId);

      return {
        workflowCount: workflows.length,
        workflows: workflows.map((w, index) => ({
          index: index + 1,
          id: w.id,
          name: w.name,
          description: w.description,
          enabled: w.enabled,
          nodeCount: w.dagDefinition.nodes.length,
          edgeCount: w.dagDefinition.edges.length,
        })),
      };
    },
  }),

  get_workflow: deferTool(tool({
    description: 'Get full details of a workflow including its DAG definition (nodes and edges).',
    inputSchema: z.object({
      workflowId: z.string().describe('The ID of the workflow to retrieve'),
    }),
    execute: async ({ workflowId }) => {
      const workflowRepo = getWorkflowRepository();
      const workflow = workflowRepo.getById(workflowId);

      if (!workflow) {
        throw new Error(`Workflow with id ${workflowId} not found`);
      }

      return {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        enabled: workflow.enabled,
        dagDefinition: workflow.dagDefinition,
        createdAt: new Date(workflow.createdAt).toISOString(),
        updatedAt: new Date(workflow.updatedAt).toISOString(),
      };
    },
  })),

  create_workflow: deferTool(tool({
    // The node-type grammar lives in toolDocs.ts, not here — see that file for
    // why. Anything a caller gets wrong is answered by validateNodeData below.
    description: [
      'Create a new workflow for the current project. A workflow is a DAG of nodes and edges that defines an automation pipeline.',
      'IMPORTANT: Workflows you create are queued for human review and cannot execute until the user approves them. Tell the user to check the Workflows tab.',
      'Every node needs `data.label` plus per-type fields. Before building a graph, call get_tool_info({toolName: "create_workflow"}) for the node-type grammar.',
    ].join('\n'),
    inputSchema: z.object({
      name: z.string().describe('Name of the workflow'),
      description: z.string().optional().describe('Description of what the workflow does'),
      enabled: z.boolean().optional().describe('Whether the workflow is enabled. Default: true'),
      dagDefinition: z.object({
        nodes: z.array(z.object({
          id: z.string(),
          type: z.enum(WORKFLOW_NODE_TYPES).describe('Canonical node type (get_tool_info for per-type data fields).'),
          position: z.object({ x: z.number(), y: z.number() }),
          // `label` is required rather than optional: without it the editor
          // renders an anonymous box and the step's meaning is buried in a
          // multi-kilobyte prompt. Passthrough keeps per-type fields free-form.
          data: z.object({
            label: z.string().min(1).describe(
              'Short human-readable name for this step, shown on the node in the workflow editor. Describe what the step does, e.g. "Fetch overnight reports" — not the node type.'
            ),
          }).passthrough(),
        })),
        edges: z.array(z.object({
          id: z.string(),
          source: z.string(),
          target: z.string(),
          sourceHandle: z.string().nullish(),
          targetHandle: z.string().nullish(),
        })),
      }).optional().describe('The DAG definition. Defaults to empty graph if not provided.'),
    }),
    execute: async ({ name, description, enabled = true, dagDefinition }) => {
      assertValidGraph(dagDefinition);

      const { settingsRepo, currentState } = getCurrentProject();
      const workflowRepo = getWorkflowRepository();

      const reviewRequired = settingsRepo.get().workflowReviewRequired !== false;
      const reviewStatus = reviewRequired ? 'pending' : 'approved';

      const workflow = workflowRepo.create({
        projectId: currentState.projectId,
        name,
        description,
        enabled,
        dagDefinition: dagDefinition || { nodes: [], edges: [] },
        createdBy: 'agent',
        reviewStatus,
      });

      eventBus.emitEvent('workflow:created', {
        workflowId: workflow.id,
        workflowName: workflow.name,
        projectId: workflow.projectId,
        createdBy: 'agent',
        reviewStatus,
      });

      return {
        success: true,
        workflow: {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          enabled: workflow.enabled,
          nodeCount: workflow.dagDefinition.nodes.length,
          reviewStatus,
        },
        // Surface the gate in the tool response so the agent can relay it to the user.
        message: reviewStatus === 'pending'
          ? `Workflow "${name}" created and queued for human review. The user must approve it in the Workflows tab before it will execute.`
          : `Workflow "${name}" created.`,
      };
    },
  })),

  update_workflow: deferTool(tool({
    description: 'Update an existing workflow. Can change name, description, enabled status, or DAG definition. Updating the DAG re-queues the workflow for human review. Call get_tool_info({toolName: "update_workflow"}) for the node-type grammar.',
    inputSchema: z.object({
      workflowId: z.string().describe('The ID of the workflow to update'),
      name: z.string().optional().describe('New name for the workflow'),
      description: z.string().optional().describe('New description'),
      enabled: z.boolean().optional().describe('Enable or disable the workflow'),
      dagDefinition: z.object({
        nodes: z.array(z.object({
          id: z.string(),
          type: z.enum(WORKFLOW_NODE_TYPES).describe('Canonical node type (get_tool_info for per-type data fields).'),
          position: z.object({ x: z.number(), y: z.number() }),
          // `label` is required rather than optional: without it the editor
          // renders an anonymous box and the step's meaning is buried in a
          // multi-kilobyte prompt. Passthrough keeps per-type fields free-form.
          data: z.object({
            label: z.string().min(1).describe(
              'Short human-readable name for this step, shown on the node in the workflow editor. Describe what the step does, e.g. "Fetch overnight reports" — not the node type.'
            ),
          }).passthrough(),
        })),
        edges: z.array(z.object({
          id: z.string(),
          source: z.string(),
          target: z.string(),
          sourceHandle: z.string().nullish(),
          targetHandle: z.string().nullish(),
        })),
      }).optional().describe('New DAG definition'),
    }),
    execute: async ({ workflowId, name, description, enabled, dagDefinition }) => {
      assertValidGraph(dagDefinition);

      const { settingsRepo } = getCurrentProject();
      const workflowRepo = getWorkflowRepository();

      const existing = workflowRepo.getById(workflowId);
      if (!existing) {
        throw new Error(`Workflow with id ${workflowId} not found`);
      }

      const updates: Partial<Omit<Workflow, 'id' | 'projectId' | 'createdAt'>> = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (enabled !== undefined) updates.enabled = enabled;
      if (dagDefinition !== undefined) updates.dagDefinition = dagDefinition;

      // DAG changes re-queue for human review when the setting requires it.
      // Metadata-only changes (name/description/enabled) do not.
      const reviewRequired = settingsRepo.get().workflowReviewRequired !== false;
      if (dagDefinition !== undefined && reviewRequired) {
        updates.reviewStatus = 'pending';
      }

      const workflow = workflowRepo.update(workflowId, updates);
      if (!workflow) {
        throw new Error(`Failed to update workflow ${workflowId}`);
      }

      return {
        success: true,
        workflow: {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          enabled: workflow.enabled,
          nodeCount: workflow.dagDefinition.nodes.length,
          reviewStatus: workflow.reviewStatus,
        },
        message: workflow.reviewStatus === 'pending'
          ? `Workflow "${workflow.name}" updated and re-queued for human review.`
          : `Workflow "${workflow.name}" updated.`,
      };
    },
  })),

  delete_workflow: deferTool(tool({
    description: 'Delete a workflow from the current project',
    inputSchema: z.object({
      workflowId: z.string().describe('The ID of the workflow to delete'),
    }),
    execute: async ({ workflowId }) => {
      const workflowRepo = getWorkflowRepository();

      const existing = workflowRepo.getById(workflowId);
      if (!existing) {
        throw new Error(`Workflow with id ${workflowId} not found`);
      }

      workflowRepo.delete(workflowId);

      return {
        success: true,
        deletedWorkflow: {
          id: existing.id,
          name: existing.name,
        },
      };
    },
  })),

  // ============================================
  // ROUTINE MANAGEMENT TOOLS
  // ============================================

  list_routines: tool({
    description: 'List all scheduled routines for the current project. Shows name, schedule, enabled status, and next/last run times.',
    inputSchema: z.object({
      enabledOnly: z.boolean().optional().describe('If true, only show enabled routines. Default: false (show all)'),
    }),
    execute: async ({ enabledOnly = false }) => {
      const { currentState } = getCurrentProject();
      const routinesRepo = getRoutineRepository();

      let routines = routinesRepo.getByProjectId(currentState.projectId);

      if (enabledOnly) {
        routines = routines.filter(r => r.enabled);
      }

      return {
        routineCount: routines.length,
        routines: routines.map((r, index) => ({
          index: index + 1,
          id: r.id,
          name: r.name,
          description: r.description,
          cronSchedule: r.cronSchedule,
          enabled: r.enabled,
          lastRun: r.lastRun ? new Date(r.lastRun).toISOString() : null,
          nextRun: r.nextRun ? new Date(r.nextRun).toISOString() : null,
          workflowId: r.workflowId,
        })),
      };
    },
  }),

  create_routine: deferTool(tool({
    description: `Create a new scheduled routine for the current project. Standard 5-field cron ("minute hour dayOfMonth month dayOfWeek"), interpreted in the server's timezone: ${SERVER_TIMEZONE}. Call get_tool_info({toolName: "create_routine"}) for worked cron examples.`,
    inputSchema: z.object({
      name: z.string().describe('Name of the routine'),
      description: z.string().optional().describe('Description of what the routine does'),
      cronSchedule: z.string().describe('Cron expression for when to run (e.g., "0 9 * * *" for 9 AM daily)'),
      enabled: z.boolean().optional().describe('Whether routine is enabled. Default: true'),
      workflowId: z.string().optional().describe('Optional workflow ID to execute when routine runs'),
    }),
    execute: async ({ name, description, cronSchedule, enabled = true, workflowId }) => {
      const { currentState } = getCurrentProject();
      const routinesRepo = getRoutineRepository();

      // Validate cron expression by trying to calculate next run
      let nextRun: number;
      try {
        nextRun = RoutineScheduler.calculateNextRun(cronSchedule);
      } catch (error) {
        // Restate the format on rejection — the worked examples moved out of
        // the description into toolDocs.ts, so the error is where a caller
        // that guessed wrong learns the shape.
        throw new Error(
          `Invalid cron schedule "${cronSchedule}": ${error instanceof Error ? error.message : String(error)}\n${TOOL_DOCS.create_routine}`
        );
      }

      const routine = routinesRepo.create({
        projectId: currentState.projectId,
        name,
        description,
        cronSchedule,
        enabled,
        workflowId,
        nextRun: enabled ? nextRun : undefined,
      });

      return {
        success: true,
        routine: {
          id: routine.id,
          name: routine.name,
          description: routine.description,
          cronSchedule: routine.cronSchedule,
          enabled: routine.enabled,
          nextRun: routine.nextRun ? new Date(routine.nextRun).toISOString() : null,
        },
      };
    },
  })),

  update_routine: deferTool(tool({
    description: `Update an existing routine. Can change name, description, schedule, or enabled status. Cron schedules are interpreted in the server's timezone: ${SERVER_TIMEZONE}.`,
    inputSchema: z.object({
      routineId: z.string().describe('The ID of the routine to update'),
      name: z.string().optional().describe('New name for the routine'),
      description: z.string().optional().describe('New description'),
      cronSchedule: z.string().optional().describe('New cron schedule'),
      enabled: z.boolean().optional().describe('Enable or disable the routine'),
    }),
    execute: async ({ routineId, name, description, cronSchedule, enabled }) => {
      const routinesRepo = getRoutineRepository();

      const existing = routinesRepo.getById(routineId);
      if (!existing) {
        throw new Error(`Routine with id ${routineId} not found`);
      }

      const updates: Partial<Omit<Routine, 'id' | 'projectId' | 'createdAt'>> = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (enabled !== undefined) updates.enabled = enabled;

      if (cronSchedule !== undefined) {
        // Validate new cron expression
        try {
          const nextRun = RoutineScheduler.calculateNextRun(cronSchedule);
          updates.cronSchedule = cronSchedule;
          updates.nextRun = nextRun;
        } catch (error) {
          // Restate the format on rejection — the worked examples moved out of
        // the description into toolDocs.ts, so the error is where a caller
        // that guessed wrong learns the shape.
        throw new Error(
          `Invalid cron schedule "${cronSchedule}": ${error instanceof Error ? error.message : String(error)}\n${TOOL_DOCS.create_routine}`
        );
        }
      }

      const routine = routinesRepo.update(routineId, updates);
      if (!routine) {
        throw new Error(`Routine ${routineId} not found`);
      }

      return {
        success: true,
        routine: {
          id: routine.id,
          name: routine.name,
          description: routine.description,
          cronSchedule: routine.cronSchedule,
          enabled: routine.enabled,
          nextRun: routine.nextRun ? new Date(routine.nextRun).toISOString() : null,
        },
      };
    },
  })),

  toggle_routine: deferTool(tool({
    description: 'Enable or disable a routine',
    inputSchema: z.object({
      routineId: z.string().describe('The ID of the routine to toggle'),
    }),
    execute: async ({ routineId }) => {
      const routinesRepo = getRoutineRepository();

      const existing = routinesRepo.getById(routineId);
      if (!existing) {
        throw new Error(`Routine with id ${routineId} not found`);
      }

      const newEnabled = !existing.enabled;
      const updates: any = { enabled: newEnabled };

      // If enabling, calculate next run time
      if (newEnabled) {
        updates.nextRun = RoutineScheduler.calculateNextRun(existing.cronSchedule);
      }

      const routine = routinesRepo.update(routineId, updates);

      return {
        success: true,
        routine: {
          id: routine!.id,
          name: routine!.name,
          enabled: routine!.enabled,
          nextRun: routine!.nextRun ? new Date(routine!.nextRun).toISOString() : null,
        },
      };
    },
  })),

  delete_routine: deferTool(tool({
    description: 'Delete a routine from the current project',
    inputSchema: z.object({
      routineId: z.string().describe('The ID of the routine to delete'),
    }),
    execute: async ({ routineId }) => {
      const routinesRepo = getRoutineRepository();

      const existing = routinesRepo.getById(routineId);
      if (!existing) {
        throw new Error(`Routine with id ${routineId} not found`);
      }

      routinesRepo.delete(routineId);

      return {
        success: true,
        deletedRoutine: {
          id: existing.id,
          name: existing.name,
        },
      };
    },
  })),

  execute_routine: deferTool(tool({
    description:
      'Immediately execute a routine (trigger it now regardless of schedule) and return what happened: ' +
      'whether it ran, what each node produced, and why it was skipped or failed. ' +
      'A routine can be skipped without failing — a disabled routine, one with no workflow attached, ' +
      'or one whose workflow is still awaiting human review all skip rather than run.',
    inputSchema: z.object({
      routineId: z.string().describe('The ID of the routine to execute'),
    }),
    // Reports the scheduler's actual outcome. This used to return success:true
    // whatever happened, so an agent could trigger a routine that never ran and
    // tell the user it had — and had no way to observe the result even when it
    // did run.
    execute: async ({ routineId }) => {
      const routinesRepo = getRoutineRepository();

      const existing = routinesRepo.getById(routineId);
      if (!existing) {
        throw new Error(`Routine with id ${routineId} not found`);
      }

      const scheduler = require('./RoutineScheduler').getRoutineScheduler();
      const outcome = await scheduler.executeRoutine(routineId);
      const updated = routinesRepo.getById(routineId);

      const nodes = outcome.execution
        ? Object.entries(outcome.execution.nodeResults).map(([nodeId, r]: [string, any]) => ({
            nodeId,
            success: r.success,
            durationMs: r.durationMs,
            ...(r.error ? { error: r.error } : {}),
            ...(r.output !== undefined ? { output: truncateForTool(r.output) } : {}),
          }))
        : [];

      return {
        success: outcome.status === 'success',
        status: outcome.status,
        ...(outcome.error ? { reason: outcome.error } : {}),
        ...(outcome.execution
          ? {
              executionId: outcome.execution.executionId,
              durationMs: outcome.execution.durationMs,
              outputs: truncateForTool(outcome.execution.outputs),
              nodes,
              failedNodes: nodes.filter(n => !n.success).map(n => n.nodeId),
            }
          : {}),
        routine: {
          id: updated!.id,
          name: updated!.name,
          lastRun: updated!.lastRun ? new Date(updated!.lastRun).toISOString() : null,
          nextRun: updated!.nextRun ? new Date(updated!.nextRun).toISOString() : null,
        },
      };
    },
  })),

  // ============================================
  // FILE OPERATIONS
  // ============================================

  read_file: tool({
    description: 'Read the contents of a file in the project. Use this before edit_file so the old_string you provide matches the file exactly. Credential files (.env, keys, certificates) are withheld by policy.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to project root or absolute within project)'),
    }),
    // Read-only, and scoped to the project directories — the same posture as
    // glob and grep, which are ungated for the same reason.
    execute: async ({ path: filePath }) => {
      const resolved = resolveNonSecretPath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      return { success: true, path: filePath, content };
    },
  }),

  write_file: tool({
    description: 'Create a file, or replace an entire existing file. Prefer edit_file when changing part of a file that already exists — a whole-file write silently discards anything you did not include. Credential files (.env, keys, certificates) are refused by policy.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to project root or absolute within project)'),
      content: z.string().describe('The complete file content. This REPLACES the file — it is not appended.'),
    }),
    // Same gate as edit_file, and for a stronger reason: this one does not need
    // to match existing text, so an unreviewed call can replace a file whole.
    needsApproval: true,
    execute: async ({ path: filePath, content }) => {
      const resolved = resolveNonSecretPath(filePath);
      const existed = await fs.access(resolved).then(() => true, () => false);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      return {
        success: true,
        path: filePath,
        created: !existed,
        message: existed ? 'File replaced' : 'File created',
      };
    },
  }),

  edit_file: tool({
    description: 'Make a targeted edit to a file by replacing a specific string. The old_string must match exactly (including whitespace). Use read_file first to see the current content.',
    inputSchema: z.object({
      path: z.string().describe('File path (relative to project root or absolute within project)'),
      old_string: z.string().describe('The exact string to find and replace'),
      new_string: z.string().describe('The replacement string'),
    }),
    // Filesystem mutation gets the same human gate as bash/execute_code — it
    // writes to disk within the project, so a self-enabled edit_file could
    // otherwise modify source/config with no review. Same tool-approval flow.
    needsApproval: true,
    execute: async ({ path: filePath, old_string, new_string }) => {
      const resolved = resolveNonSecretPath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');

      if (!content.includes(old_string)) {
        throw new Error(`old_string not found in ${filePath}. Use read_file to check current content.`);
      }

      const occurrences = content.split(old_string).length - 1;
      if (occurrences > 1) {
        throw new Error(`old_string matches ${occurrences} locations in ${filePath}. Provide more context to make it unique.`);
      }

      const updated = content.replace(old_string, new_string);
      await fs.writeFile(resolved, updated, 'utf-8');

      return { success: true, path: filePath, message: 'File edited successfully' };
    },
  }),

  glob: tool({
    description: 'Find files matching a glob pattern within the project directory. Returns file paths relative to the project root.',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.test.js")'),
      maxResults: z.number().optional().describe('Maximum results to return (default: 100)'),
    }),
    execute: async ({ pattern, maxResults = 100 }) => {
      const dirs = getProjectDirectories();
      if (dirs.length === 0) {
        throw new Error('No project directories are available. Open a project first.');
      }

      // Dynamic import for glob
      const { glob: globFn } = await import('glob');
      const allResults: string[] = [];

      for (const dir of dirs) {
        const matches = await globFn(pattern, {
          cwd: dir,
          nodir: true,
          dot: false,
          ignore: ['**/node_modules/**', '**/.git/**', ...SENSITIVE_FILE_PATTERNS],
        });
        for (const match of matches) {
          allResults.push(match);
          if (allResults.length >= maxResults) break;
        }
        if (allResults.length >= maxResults) break;
      }

      return {
        pattern,
        matchCount: allResults.length,
        truncated: allResults.length >= maxResults,
        files: allResults.slice(0, maxResults),
      };
    },
  }),

  grep: tool({
    description: 'Search file contents for a pattern within the project directory. Returns matching lines with file paths and line numbers.',
    inputSchema: z.object({
      pattern: z.string().describe('Search string or regex pattern'),
      filePattern: z.string().optional().describe('Glob pattern to filter files (e.g., "**/*.ts"). Default: all text files'),
      maxResults: z.number().optional().describe('Maximum matching lines to return (default: 50)'),
    }),
    execute: async ({ pattern, filePattern = '**/*', maxResults = 50 }) => {
      const dirs = getProjectDirectories();
      if (dirs.length === 0) {
        throw new Error('No project directories are available. Open a project first.');
      }

      const { glob: globFn } = await import('glob');
      const results: Array<{ file: string; line: number; content: string }> = [];
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        // Fall back to literal string match
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }

      for (const dir of dirs) {
        const files = await globFn(filePattern, {
          cwd: dir,
          nodir: true,
          dot: false,
          ignore: ['**/node_modules/**', '**/.git/**', '**/*.png', '**/*.jpg', '**/*.gif', '**/*.ico', '**/*.woff*', '**/*.ttf', '**/*.eot', ...SENSITIVE_FILE_PATTERNS],
        });

        for (const file of files) {
          if (results.length >= maxResults) break;
          try {
            const content = await fs.readFile(path.join(dir, file), 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({ file, line: i + 1, content: lines[i].trim().substring(0, 200) });
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // Skip binary/unreadable files
          }
        }
      }

      return {
        pattern,
        matchCount: results.length,
        truncated: results.length >= maxResults,
        results,
      };
    },
  }),

  // ============================================
  // CODE EXECUTION
  // ============================================

  bash: tool({
    description: 'Execute a shell command and return its output. The working directory is the project\'s first attached folder, or the project workspace when none is attached. Use for build commands, git operations, package management, etc.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000, max: 120000). Raise it for long-running work (data pulls, downloads, builds).'),
    }),
    // Always gate behind a human approval — shell access is the highest-risk
    // tool we expose. The SDK surfaces a tool-approval-request part; the chat
    // service stores it as a contentBlock and only resumes once the user
    // approves via IPC. The original HTTP stream never blocks during think-time.
    needsApproval: true,
    execute: async ({ command, timeout = 120000 }) => {
      const dirs = getProjectDirectories();
      const cwd = dirs.length > 0 ? dirs[0] : undefined;
      const executor = getCodeExecutor();

      const result = await executor.execute({
        language: 'shell',
        code: command,
        timeout: Math.min(timeout, 120000),
        workingDirectory: cwd,
      });

      return {
        exitCode: result.exitCode,
        stdout: clampToolStream(result.stdout || ''),
        stderr: clampToolStream(result.stderr || ''),
        success: result.success,
        duration: result.executionTime,
      };
    },
  }),

  execute_code: tool({
    // Only the two rules whose violation is expensive stay on the wire; the
    // rest are in toolDocs.ts, served by get_tool_info.
    description:
      'Run a SMALL, self-contained script in JavaScript or Python and return its output — for data processing, calculations, or quick automation. This is not a general coding environment; reach for it only when the dedicated tools cannot do the job. ' +
      'Each run is a FRESH process — no variables, files, or imports persist between calls. ' +
      'Do NOT print large output: write results to a file and return a short summary plus the path, since large stdout is replayed into context on every later turn. ' +
      'See get_tool_info({toolName: "execute_code"}) for the rest.',
    inputSchema: z.object({
      language: z.enum(['javascript', 'python']).describe('Programming language'),
      code: z.string().describe('A small, self-contained script. Remember: state does NOT persist between runs, and large stdout is costly — write big results to a file and summarize.'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000, max: 120000). Raise it for long-running work.'),
    }),
    // Same rationale as bash — arbitrary code execution gets the same gate.
    needsApproval: true,
    execute: async ({ language, code, timeout = 120000 }) => {
      const executor = getCodeExecutor();

      // Same working directory as bash. Without it a script ran in the
      // executor's temp script directory, so the tool's own advice — "write
      // results to a file and return the path" — produced files at a path the
      // file tools could not reach.
      const dirs = getProjectDirectories();

      const result = await executor.execute({
        language,
        code,
        timeout: Math.min(timeout, 120000),
        workingDirectory: dirs.length > 0 ? dirs[0] : undefined,
      });

      return {
        stdout: clampToolStream(result.stdout || ''),
        stderr: clampToolStream(result.stderr || ''),
        success: result.success,
        duration: result.executionTime,
      };
    },
  }),

  // ============================================
  // WEB
  // ============================================

  web_fetch: tool({
    description: 'Fetch a web page and return its text content. Useful for reading documentation, APIs, or web resources.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch'),
      maxLength: z.number().optional().describe('Maximum characters to return (default: 50000)'),
    }),
    // Renderer keeps the structured envelope (status, contentType, etc.);
    // the model just gets the page text — no need to make it parse JSON.
    toModelOutput: ({ output }) => {
      const o = output as { url?: string; status?: number; contentType?: string; truncated?: boolean; content?: string } | null;
      if (!o || typeof o.content !== 'string') {
        return { type: 'text', value: '(empty response)' };
      }
      const header = `URL: ${o.url ?? '?'}\nStatus: ${o.status ?? '?'} ${o.contentType ?? ''}${o.truncated ? '\n[truncated]' : ''}`;
      return { type: 'text', value: `${header}\n\n${o.content}` };
    },
    execute: async ({ url, maxLength = 50000 }) => {
      validateFetchUrl(url);

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Eaves/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
          },
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();

        // Strip HTML tags for HTML content to get readable text
        let content = text;
        if (contentType.includes('html')) {
          content = text
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }

        const truncated = content.length > maxLength;
        content = content.substring(0, maxLength);

        return {
          url,
          status: response.status,
          contentType,
          contentLength: content.length,
          truncated,
          content,
        };
      } catch (error) {
        throw new Error(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  // ============================================
  // INTERACTION
  // ============================================

  ask_user_question: tool({
    description: 'Ask the user a clarifying question and wait for their response. Use this when you need more information before proceeding with a task.',
    inputSchema: z.object({
      question: z.string().describe('The question to ask the user'),
    }),
    execute: async ({ question }) => {
      // Emit the question as a special event that the renderer can display
      // The agent's question is returned as content — the user will see it
      // in the chat and can respond naturally in the next message.
      return {
        question,
        note: 'Your question has been presented to the user. Wait for their response in the next message before proceeding.',
      };
    },
  }),

  // ─── Memory ───────────────────────────────────────────────────────────────
  // These route through the active `memory-backend` service rather than any one
  // store: the core default (SQLite + FTS5) when no plugin is present, or a
  // plugin backend (simple-memory / openmemory / an Obsidian-via-MCP bridge)
  // when one overrides it. Because built-in tools win name collisions (see
  // buildToolset), they supersede a plugin's own memory tools while still
  // calling whatever backend is the live default — so the tool surface survives
  // even when the memory *backend* is swapped or a plugin is removed.
  store_memory: tool({
    description: 'Store a memory (key/value) that persists across conversations. Re-storing an existing key overwrites it.',
    inputSchema: z.object({
      key: z.string().describe('Unique key for this memory'),
      value: z.string().describe('The value to store (a JSON string for complex data)'),
      metadata: z.object({
        tags: z.array(z.string()).optional().describe('Tags for filtering in search'),
        description: z.string().optional(),
      }).passthrough().optional(),
    }),
    execute: async ({ key, value, metadata }) =>
      getServiceRegistry().call('memory-backend', 'store', { key, value, metadata }),
  }),

  retrieve_memory: tool({
    description: 'Retrieve a stored memory by its exact key.',
    inputSchema: z.object({ key: z.string().describe('The key to retrieve') }),
    execute: async ({ key }) => getServiceRegistry().call('memory-backend', 'retrieve', key),
  }),

  search_memories: tool({
    description: 'Search stored memories by relevance and return only the most relevant entries. Prefer this over list_memories — listing everything can be large.',
    inputSchema: z.object({
      query: z.string().describe('What to search for'),
      limit: z.number().optional().describe('Max results (default 10)'),
      tags: z.array(z.string()).optional().describe('Only return memories carrying at least one of these tags'),
    }),
    execute: async ({ query, limit, tags }) =>
      getServiceRegistry().call('memory-backend', 'search', { query, limit, tags }),
  }),

  list_memories: tool({
    description: 'List stored memory keys, optionally filtered by a `*`-wildcard pattern. Results are bounded; use search_memories to find specific content rather than listing everything.',
    inputSchema: z.object({
      pattern: z.string().optional().describe('Optional key filter, supports * wildcards (e.g. "user_*")'),
    }),
    execute: async ({ pattern }) => getServiceRegistry().call('memory-backend', 'list', pattern),
  }),

  delete_memory: tool({
    description: 'Delete a stored memory by its exact key.',
    inputSchema: z.object({ key: z.string().describe('The key to delete') }),
    execute: async ({ key }) => getServiceRegistry().call('memory-backend', 'delete', key),
  }),
};
