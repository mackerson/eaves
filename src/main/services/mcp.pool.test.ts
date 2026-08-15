/**
 * The auto-injected filesystem servers are pooled per project directory.
 *
 * Before pooling, every turn spawned one node process per project directory:
 * chat turns closed theirs in a finally, channel turns never did, so they piled
 * up at ~75MB each for the life of the app. These pin the two properties that
 * fix depends on — one process per directory across turns, and a pooled client
 * that a finishing turn cannot close out from under other turns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const connectSpy = vi.fn();
const closeSpy = vi.fn();
const listToolsSpy = vi.fn(async () => ({
  tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
}));

/** Every Client the code under test constructs, in order. */
const constructed: Array<Record<string, unknown>> = [];

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose?: () => void;
    onerror?: (e: Error) => void;
    connect = connectSpy;
    close = closeSpy;
    listTools = listToolsSpy;
    callTool = vi.fn(async () => ({ content: [] }));
    constructor() {
      constructed.push(this as unknown as Record<string, unknown>);
    }
  },
}));

const transportSpy = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(opts: unknown) {
      transportSpy(opts);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {},
}));

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DIR = { name: 'personal', path: '/home/u/personal' };
const OTHER = { name: 'work', path: '/home/u/work' };

let mcp: typeof import('./mcp');

beforeEach(async () => {
  vi.resetModules();
  constructed.length = 0;
  vi.clearAllMocks();
  mcp = await import('./mcp');
});

afterEach(async () => {
  await mcp.shutdownMCPPool();
});

describe('filesystem MCP server pooling', () => {
  it('spawns one server per directory and reuses it across turns', async () => {
    const first = await mcp.connectMCPServers([], [DIR]);
    const second = await mcp.connectMCPServers([], [DIR]);
    const third = await mcp.connectMCPServers([], [DIR]);

    expect(constructed).toHaveLength(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    // Every turn still gets the tools, without a fresh listTools round trip.
    for (const turn of [first, second, third]) {
      expect(Object.keys(turn.tools)).toContain('read_file');
    }
    expect(listToolsSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps pooled clients out of the per-turn disconnect list', async () => {
    const { clients } = await mcp.connectMCPServers([], [DIR]);

    // A turn ending disconnects everything it was handed; if the pooled client
    // were in here, the next turn would inherit a dead server.
    expect(clients).toHaveLength(0);
    mcp.disconnectMCPClients(clients);
    expect(closeSpy).not.toHaveBeenCalled();

    await mcp.connectMCPServers([], [DIR]);
    expect(constructed).toHaveLength(1);
  });

  it('spawns separately for each distinct directory', async () => {
    await mcp.connectMCPServers([], [DIR, OTHER]);
    await mcp.connectMCPServers([], [DIR, OTHER]);

    expect(constructed).toHaveLength(2);
    const dirs = transportSpy.mock.calls.map(([o]: [{ env: Record<string, string> }]) => o.env.PROJECT_DIR);
    expect(dirs).toEqual([DIR.path, OTHER.path]);
  });

  it('does not let concurrent turns race two servers into existence', async () => {
    // Two turns starting at once for the same directory must share one spawn.
    const [a, b] = await Promise.all([
      mcp.connectMCPServers([], [DIR]),
      mcp.connectMCPServers([], [DIR]),
    ]);

    expect(constructed).toHaveLength(1);
    expect(Object.keys(a.tools)).toContain('read_file');
    expect(Object.keys(b.tools)).toContain('read_file');
  });

  it('respawns after a pooled server closes', async () => {
    await mcp.connectMCPServers([], [DIR]);
    expect(constructed).toHaveLength(1);

    // The server died (crash, killed externally) — the pool must not keep
    // handing out its client.
    (constructed[0].onclose as () => void)();

    await mcp.connectMCPServers([], [DIR]);
    expect(constructed).toHaveLength(2);
  });

  it('does not cache a failed spawn', async () => {
    connectSpy.mockRejectedValueOnce(new Error('spawn failed'));

    const failed = await mcp.connectMCPServers([], [DIR]);
    expect(Object.keys(failed.tools)).toHaveLength(0);

    // A transient failure must not poison the directory for the whole session.
    const recovered = await mcp.connectMCPServers([], [DIR]);
    expect(Object.keys(recovered.tools)).toContain('read_file');
    expect(constructed).toHaveLength(2);
  });

  it('closes pooled servers on shutdown', async () => {
    await mcp.connectMCPServers([], [DIR, OTHER]);
    expect(constructed).toHaveLength(2);

    await mcp.shutdownMCPPool();
    expect(closeSpy).toHaveBeenCalledTimes(2);

    // Pool is empty afterwards, so a later call starts fresh rather than
    // reusing a client that was just closed.
    await mcp.connectMCPServers([], [DIR]);
    expect(constructed).toHaveLength(3);
  });
});
