import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/eaves' },
}));

import { __testing__, shouldGateMcpTool } from './mcp';

describe('mcp content mapping', () => {
  const { summarizeMcpContent, mcpContentToModelOutput } = __testing__;

  it('summarizeMcpContent flattens text and labels media', () => {
    expect(summarizeMcpContent([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'b64', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file://x', text: 'inner' } },
      { type: 'resource', resource: { uri: 'file://y', mimeType: 'application/pdf', blob: 'b64' } },
    ])).toBe('hello\n[image: image/png]\n[resource file://x]\ninner\n[resource file://y: application/pdf]');
  });

  it('mcpContentToModelOutput preserves text + image-data + file-data', () => {
    const parts = mcpContentToModelOutput([
      { type: 'text', text: 'page contents' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      { type: 'resource', resource: { uri: 'r', mimeType: 'application/octet-stream', blob: 'BBBB' } },
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'page contents' },
      { type: 'image-data', data: 'AAAA', mediaType: 'image/jpeg' },
      { type: 'file-data', data: 'BBBB', mediaType: 'application/octet-stream' },
    ]);
  });

  it('mcpContentToModelOutput inlines text resources directly', () => {
    const parts = mcpContentToModelOutput([
      { type: 'resource', resource: { uri: 'file://x', text: 'body text' } },
    ]);

    expect(parts).toEqual([
      { type: 'text', text: '[resource file://x]\nbody text' },
    ]);
  });

  it('mcpContentToModelOutput degrades unknown variants to a labeled marker', () => {
    const parts = mcpContentToModelOutput([
      { type: 'novel-thing', somefield: 1 } as never,
    ]);
    expect(parts).toEqual([{ type: 'text', text: '[novel-thing]' }]);
  });

  it('mcpContentToModelOutput handles missing content', () => {
    expect(mcpContentToModelOutput(undefined)).toEqual([]);
  });
});

describe('shouldGateMcpTool', () => {
  const builtinFs = '__builtin_filesystem__:my-project';

  it.each(['write_file', 'create_directory', 'delete_file'])(
    'gates %s on the auto-injected filesystem server',
    (toolName) => {
      // These mutate the project without the user ever enabling the server —
      // the same gate built-in edit_file and write_file carry.
      expect(shouldGateMcpTool(builtinFs, toolName)).toBe(true);
    },
  );

  it.each(['read_file', 'list_directory', 'search_files', 'get_file_info'])(
    'leaves read-only %s ungated',
    (toolName) => {
      expect(shouldGateMcpTool(builtinFs, toolName)).toBe(false);
    },
  );

  it('does not gate a user-configured server that happens to expose write_file', () => {
    // A third-party server is an install-time trust decision the user made,
    // the same posture plugins get. Documented gap, not an oversight.
    expect(shouldGateMcpTool('user-server-123', 'write_file')).toBe(false);
  });

  it('is not fooled by a server id that merely contains the prefix', () => {
    expect(shouldGateMcpTool('evil__builtin_filesystem__:x', 'delete_file')).toBe(false);
  });
});
