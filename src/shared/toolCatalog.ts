/**
 * Tool catalog — single source of truth for tool metadata.
 * Referenced by both builtinTools.ts (main process) and AgentEditorView (renderer).
 *
 * Only lists tools that are actually implemented. When a new tool is added
 * to builtinTools.ts, add its entry here to make it appear in the UI.
 */

export interface ToolEntry {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
}

export type ToolCategory = 'file' | 'code' | 'web' | 'project' | 'channel' | 'discovery';

export const TOOL_CATALOG: ToolEntry[] = [
  // File Operations
  { name: 'read_file', label: 'Read File', description: 'Read file contents (via MCP filesystem)', category: 'file' },
  { name: 'write_file', label: 'Write File', description: 'Create or overwrite files (via MCP filesystem)', category: 'file' },
  { name: 'edit_file', label: 'Edit File', description: 'Make targeted string replacements in files', category: 'file' },
  { name: 'glob', label: 'Glob', description: 'Find files by pattern in project directories', category: 'file' },
  { name: 'grep', label: 'Grep', description: 'Search file contents with regex or string matching', category: 'file' },

  // Code & Execution
  { name: 'bash', label: 'Bash', description: 'Execute shell commands in the project directory', category: 'code' },
  { name: 'execute_code', label: 'Execute Code', description: 'Run JavaScript or Python code', category: 'code' },

  // Web & Network
  { name: 'web_search', label: 'Web Search', description: 'Search the web via DuckDuckGo', category: 'web' },
  { name: 'web_fetch', label: 'Web Fetch', description: 'Fetch and read web page content', category: 'web' },

  // Project Management
  { name: 'list_tasks', label: 'List Tasks', description: 'List tasks for the current project', category: 'project' },
  { name: 'add_task', label: 'Add Task', description: 'Create a new task in the project', category: 'project' },
  { name: 'toggle_task', label: 'Toggle Task', description: 'Mark a task complete or incomplete', category: 'project' },
  { name: 'delete_task', label: 'Delete Task', description: 'Remove a task from the project', category: 'project' },
  { name: 'list_notes', label: 'List Notes', description: 'List notes for the current project', category: 'project' },
  { name: 'add_note', label: 'Add Note', description: 'Create a new note in the project', category: 'project' },
  { name: 'delete_note', label: 'Delete Note', description: 'Remove a note from the project', category: 'project' },
  { name: 'ask_user_question', label: 'Ask User', description: 'Ask the user a clarifying question', category: 'project' },

  // Discovery
  { name: 'eaves_guide', label: 'Eaves Guide', description: 'Look up how Eaves itself works', category: 'discovery' },

  // Channel Tools
  { name: 'channel_send_message', label: 'Send Message', description: 'Post a message to another channel', category: 'channel' },
  { name: 'channel_list', label: 'List Channels', description: 'List channels the agent participates in', category: 'channel' },
  { name: 'channel_create', label: 'Create Channel', description: 'Create a new channel', category: 'channel' },
  { name: 'channel_invite', label: 'Invite to Channel', description: 'Invite an agent or user to a channel', category: 'channel' },
  { name: 'channel_history', label: 'Channel History', description: 'Read recent messages from a channel', category: 'channel' },
];

/** Where a tool comes from — its trust tier. */
export type ToolSource = 'builtin' | 'plugin' | 'mcp';

/**
 * A tool actually available to agents, enumerated at runtime from the live
 * registries (built-in + loaded plugins). Carries an approximate per-turn
 * schema token cost so the editor can show the weight of a default-tool
 * selection. MCP-server tools are intentionally excluded — enumerating them
 * requires connecting to (spawning) the servers, which the Connections section
 * manages instead. See getToolInventory (main) and the app:get-tool-inventory IPC.
 */
export interface ToolInventoryEntry {
  name: string;
  description: string;
  source: ToolSource;
  /** Approximate tokens the tool's definition adds to each request it rides on. */
  estTokens: number;
}

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  file: 'File Operations',
  code: 'Code & Execution',
  web: 'Web & Network',
  project: 'Project Management',
  channel: 'Channel Communication',
  discovery: 'Discovery',
};

/** Group catalog entries by category */
export function getToolsByCategory(): Map<ToolCategory, ToolEntry[]> {
  const grouped = new Map<ToolCategory, ToolEntry[]>();
  for (const entry of TOOL_CATALOG) {
    const list = grouped.get(entry.category) || [];
    list.push(entry);
    grouped.set(entry.category, list);
  }
  return grouped;
}
