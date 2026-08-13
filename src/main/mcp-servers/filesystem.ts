#!/usr/bin/env node
/**
 * Filesystem MCP Server
 *
 * Provides file system access tools scoped to a specific project directory.
 * This server is automatically configured for agents when a project has a directory set.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
// @ts-ignore - glob provides its own types
import { glob } from 'glob';
import { validateProjectPath } from './pathValidation.js';

// Get the project directory from environment variable
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// Ensure the path is absolute and normalize it
const projectRoot = path.resolve(PROJECT_DIR);

// Validate that the project directory exists
try {
  await fs.access(projectRoot);
} catch (error) {
  console.error(`Project directory does not exist: ${projectRoot}`);
  process.exit(1);
}

/**
 * Ensure a file path is within the project directory (security check)
 */
function validatePath(filePath: string): string {
  return validateProjectPath(projectRoot, filePath);
}

/**
 * Available filesystem tools
 */
const tools: Tool[] = [
  {
    name: 'read_file',
    description: `Read the contents of a file. Use paths relative to the project folder root (${projectRoot}). Example: "src/index.ts" not an absolute path.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the project folder root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: `Write content to a file. Use paths relative to the project folder root (${projectRoot}).`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the project folder root',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: `List files and directories. Use paths relative to the project folder root (${projectRoot}). Use "." to list the root.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the project folder root (default: ".")',
          default: '.',
        },
      },
    },
  },
  {
    name: 'create_directory',
    description: 'Create a new directory in the project',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to create',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to delete',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for files matching a glob pattern',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.js")',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_file_info',
    description: 'Get information about a file (size, modified time, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file',
        },
      },
      required: ['path'],
    },
  },
];

/**
 * Initialize the MCP server
 */
const server = new Server(
  {
    name: 'enclave-filesystem',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Handle tool list requests
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

/**
 * Handle tool execution requests
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'read_file': {
        const filePath = validatePath(args.path as string);
        const content = await fs.readFile(filePath, 'utf-8');
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'write_file': {
        const filePath = validatePath(args.path as string);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, args.content as string, 'utf-8');
        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote to ${args.path}`,
            },
          ],
        };
      }

      case 'list_directory': {
        const dirPath = validatePath((args.path as string) || '.');
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(items, null, 2),
            },
          ],
        };
      }

      case 'create_directory': {
        const dirPath = validatePath(args.path as string);
        await fs.mkdir(dirPath, { recursive: true });
        return {
          content: [
            {
              type: 'text',
              text: `Successfully created directory ${args.path}`,
            },
          ],
        };
      }

      case 'delete_file': {
        const filePath = validatePath(args.path as string);
        await fs.unlink(filePath);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully deleted ${args.path}`,
            },
          ],
        };
      }

      case 'search_files': {
        const pattern = args.pattern as string;
        const files = await glob(pattern, {
          cwd: projectRoot,
          nodir: true,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
      }

      case 'get_file_info': {
        const filePath = validatePath(args.path as string);
        const stats = await fs.stat(filePath);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  size: stats.size,
                  created: stats.birthtime,
                  modified: stats.mtime,
                  isDirectory: stats.isDirectory(),
                  isFile: stats.isFile(),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Filesystem MCP server running for project: ${projectRoot}`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
