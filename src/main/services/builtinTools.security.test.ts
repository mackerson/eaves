import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const { settingsRepo, filesRepo, projectRepo } = vi.hoisted(() => ({
  settingsRepo: { getCurrentState: vi.fn() },
  filesRepo: { getByProjectId: vi.fn() },
  projectRepo: { getById: vi.fn() },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock('../repositories', () => ({
  getSettingsRepository: () => settingsRepo,
  getFileRepository: () => filesRepo,
  getProjectRepository: () => projectRepo,
  getRoutineRepository: () => ({}),
  getWorkflowRepository: () => ({}),
}));

import { resolveProjectPath, validateFetchUrl, isSensitiveFile, builtinTools } from './builtinTools';

describe('resolveProjectPath', () => {
  const projectRoot = path.resolve('/home/user/proj');

  beforeEach(() => {
    vi.clearAllMocks();
    settingsRepo.getCurrentState.mockReturnValue({ projectId: 'p1' });
    filesRepo.getByProjectId.mockReturnValue([
      { type: 'directory', path: projectRoot, name: 'proj', createdAt: 1 },
      { type: 'file', path: path.join(projectRoot, 'readme.md'), createdAt: 2 },
    ]);
    // Containment is the subject here; the workspace root gets its own tests.
    projectRepo.getById.mockReturnValue(null);
  });

  it('throws when there is no project at all', () => {
    settingsRepo.getCurrentState.mockReturnValue({});
    expect(() => resolveProjectPath('src/a.ts')).toThrow(/No project directories/);
  });

  it('resolves relative paths under the first project directory', () => {
    expect(resolveProjectPath('src/a.ts')).toBe(path.join(projectRoot, 'src/a.ts'));
  });

  it('resolves against the OLDEST attached folder, so a new attachment does not repoint them', () => {
    const older = path.resolve('/home/user/older');
    filesRepo.getByProjectId.mockReturnValue([
      // Newest first, as the files UI lists them.
      { type: 'directory', path: projectRoot, name: 'proj', createdAt: 9 },
      { type: 'directory', path: older, name: 'older', createdAt: 1 },
    ]);
    expect(resolveProjectPath('a.ts')).toBe(path.join(older, 'a.ts'));
  });

  describe('workspace root', () => {
    const workspace = path.resolve('/data/projects/proj-abc12345');

    beforeEach(() => {
      projectRepo.getById.mockReturnValue({ id: 'p1', directory: workspace });
    });

    it('is reachable even though the user attached nothing', () => {
      filesRepo.getByProjectId.mockReturnValue([]);
      expect(resolveProjectPath('notes.md')).toBe(path.join(workspace, 'notes.md'));
    });

    it('stays available alongside attached folders, but does not capture relative paths', () => {
      expect(resolveProjectPath('a.ts')).toBe(path.join(projectRoot, 'a.ts'));
      expect(resolveProjectPath(path.join(workspace, 'out.json'))).toBe(
        path.join(workspace, 'out.json'),
      );
    });

    it('does not widen containment to the whole projects directory', () => {
      expect(() => resolveProjectPath(path.resolve('/data/projects/other-99999999/x'))).toThrow(
        /Access denied/,
      );
    });
  });

  it('accepts absolute paths inside a project directory', () => {
    const abs = path.join(projectRoot, 'nested', 'f.ts');
    expect(resolveProjectPath(abs)).toBe(path.resolve(abs));
  });

  it('accepts the project directory itself', () => {
    expect(resolveProjectPath(projectRoot)).toBe(path.resolve(projectRoot));
  });

  it('rejects path traversal outside project directories', () => {
    expect(() => resolveProjectPath('../../etc/passwd')).toThrow(/Access denied/);
    expect(() => resolveProjectPath('/tmp/outside')).toThrow(/Access denied/);
  });
});

describe('validateFetchUrl', () => {
  it.each([
    'https://example.com/api',
    'http://example.com',
    'https://docs.enclave.dev/path?q=1',
  ])('allows public http(s) URL %s', (url) => {
    expect(() => validateFetchUrl(url)).not.toThrow();
  });

  it('rejects invalid URLs and non-http protocols', () => {
    expect(() => validateFetchUrl('not a url')).toThrow(/Invalid URL/);
    expect(() => validateFetchUrl('ftp://example.com')).toThrow(/Protocol not allowed/);
    expect(() => validateFetchUrl('file:///etc/passwd')).toThrow(/Protocol not allowed/);
  });

  it.each([
    'http://localhost/x',
    'http://127.0.0.1/x',
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://app.localhost/x',
    'http://[::]/x',
  ])('blocks localhost variant %s', (url) => {
    expect(() => validateFetchUrl(url)).toThrow(/Localhost/);
  });

  it.each([
    'http://127.0.0.2/x',
    'http://127.1.2.3/x',
    'http://127.255.255.254/x',
  ])('blocks the whole loopback /8, not just 127.0.0.1 (%s)', (url) => {
    expect(() => validateFetchUrl(url)).toThrow(/Localhost/);
  });

  it.each([
    ['decimal', 'http://2130706433/x'],
    ['octal', 'http://0177.0.0.1/x'],
    ['hex', 'http://0x7f000001/x'],
    ['short form', 'http://127.1/x'],
  ])('blocks %s encodings of loopback (WHATWG URL normalizes them)', (_label, url) => {
    expect(() => validateFetchUrl(url)).toThrow(/Localhost/);
  });

  it.each([
    'http://[::ffff:127.0.0.1]/x',
    'http://[::ffff:7f00:1]/x',
  ])('blocks IPv4-mapped loopback %s', (url) => {
    expect(() => validateFetchUrl(url)).toThrow(/Localhost/);
  });

  it.each([
    ['unique local fc00::/7', 'http://[fc00::1]/x'],
    ['unique local fd00::/8', 'http://[fd12:3456::1]/x'],
    ['link-local fe80::/10', 'http://[fe80::1]/x'],
    ['IPv4-mapped private', 'http://[::ffff:192.168.1.1]/x'],
  ])('blocks IPv6 %s', (_label, url) => {
    expect(() => validateFetchUrl(url)).toThrow(/Private\/internal/);
  });

  it('blocks cloud metadata, CGNAT, and multicast/reserved', () => {
    expect(() => validateFetchUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /Private\/internal/,
    );
    expect(() => validateFetchUrl('http://100.64.0.1/x')).toThrow(/Private\/internal/);
    expect(() => validateFetchUrl('http://224.0.0.1/x')).toThrow(/Private\/internal/);
    expect(() => validateFetchUrl('http://255.255.255.255/x')).toThrow(/Private\/internal/);
  });

  it('still allows public IPv6 and public IPv4 adjacent to blocked ranges', () => {
    expect(() => validateFetchUrl('http://[2606:4700::1111]/x')).not.toThrow();
    expect(() => validateFetchUrl('http://128.0.0.1/x')).not.toThrow();
    expect(() => validateFetchUrl('http://126.255.255.255/x')).not.toThrow();
    expect(() => validateFetchUrl('http://100.63.255.255/x')).not.toThrow();
    expect(() => validateFetchUrl('http://100.128.0.1/x')).not.toThrow();
    expect(() => validateFetchUrl('http://223.255.255.255/x')).not.toThrow();
  });

  // Documented gap, not an oversight: URL-time validation cannot see what a
  // hostname resolves to. Locking this keeps the limitation visible.
  it('does NOT catch public hostnames that resolve to private IPs (DNS rebinding)', () => {
    expect(() => validateFetchUrl('http://localtest.me/x')).not.toThrow();
  });

  it.each([
    'http://10.0.0.5/x',
    'http://172.16.1.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.1/x',
    'http://169.254.1.1/x',
    'http://0.1.2.3/x',
  ])('blocks private/reserved IP %s', (url) => {
    expect(() => validateFetchUrl(url)).toThrow(/Private\/internal/);
  });

  it('allows public-looking IPv4 and non-private 172 ranges', () => {
    expect(() => validateFetchUrl('http://8.8.8.8/')).not.toThrow();
    expect(() => validateFetchUrl('http://172.15.0.1/')).not.toThrow();
    expect(() => validateFetchUrl('http://172.32.0.1/')).not.toThrow();
  });
});

describe('web_fetch', () => {
  const exec = (input: unknown) =>
    (builtinTools.web_fetch as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
      input,
      {} as never,
    );

  const toModel = (output: unknown) =>
    (
      builtinTools.web_fetch as {
        toModelOutput: (a: { output: unknown }) => { type: string; value: string };
      }
    ).toModelOutput({ output });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects SSRF targets before fetch', async () => {
    await expect(exec({ url: 'http://127.0.0.1/' })).rejects.toThrow(/Localhost/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns stripped HTML text and truncates over maxLength', async () => {
    const html = '<html><script>x</script><style>y</style><body><p>Hello world</p></body></html>';
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => html + 'x'.repeat(100),
    } as Response);

    const result = (await exec({ url: 'https://example.com/doc', maxLength: 20 })) as {
      status: number;
      truncated: boolean;
      content: string;
      contentType: string;
    };
    expect(result.status).toBe(200);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(20);
    expect(result.content).toContain('Hello');
    expect(result.contentType).toContain('html');
  });

  it('surfaces HTTP errors and network failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'text/plain' },
      text: async () => 'missing',
    } as Response);
    await expect(exec({ url: 'https://example.com/404' })).rejects.toThrow(/HTTP 404/);

    vi.mocked(fetch).mockRejectedValueOnce(new Error('timeout'));
    await expect(exec({ url: 'https://example.com/x' })).rejects.toThrow(/Fetch failed: timeout/);
  });

  it('toModelOutput formats envelope for the model', () => {
    expect(toModel(null).value).toBe('(empty response)');
    expect(
      toModel({
        url: 'https://x',
        status: 200,
        contentType: 'text/plain',
        truncated: true,
        content: 'body',
      }).value,
    ).toContain('URL: https://x');
    expect(
      toModel({
        url: 'https://x',
        status: 200,
        contentType: 'text/plain',
        truncated: true,
        content: 'body',
      }).value,
    ).toContain('[truncated]');
    expect(
      toModel({
        url: 'https://x',
        status: 200,
        contentType: 'text/plain',
        truncated: true,
        content: 'body',
      }).value,
    ).toContain('body');
  });
});

describe('isSensitiveFile', () => {
  // SENSITIVE_FILE_PATTERNS (globs, for glob/grep `ignore`) and isSensitiveFile
  // (a predicate, for single-path tools) are two encodings of one policy. Each
  // case here is the canonical example of one of those globs; if the two ever
  // drift, this is what notices.
  it.each([
    ['**/.env', 'proj/.env'],
    ['**/.env.*', 'proj/.env.local'],
    ['**/.env.production', 'proj/config/.env.production'],
    ['**/*.pem', 'proj/certs/server.pem'],
    ['**/*.key', 'proj/certs/server.key'],
    ['**/*.p12', 'proj/certs/bundle.p12'],
    ['**/*.pfx', 'proj/certs/bundle.pfx'],
    ['**/*.jks', 'proj/certs/store.jks'],
    ['**/id_rsa', 'proj/id_rsa'],
    ['**/id_ed25519', 'proj/keys/id_ed25519'],
    ['**/id_ecdsa', 'proj/keys/id_ecdsa'],
    ['**/id_dsa', 'proj/keys/id_dsa'],
    ['**/.ssh/**', 'proj/.ssh/config'],
    ['**/.gnupg/**', 'proj/.gnupg/secring.gpg'],
    ['**/credentials.json', 'proj/credentials.json'],
    ['**/service-account*.json', 'proj/service-account-prod.json'],
    ['**/.npmrc', 'proj/.npmrc'],
    ['**/.pypirc', 'proj/.pypirc'],
  ])('matches the %s policy via %s', (_pattern, filePath) => {
    expect(isSensitiveFile(filePath)).toBe(true);
  });

  it('is case-insensitive on extensions', () => {
    expect(isSensitiveFile('proj/certs/SERVER.PEM')).toBe(true);
  });

  it('catches anything nested under a secret directory', () => {
    expect(isSensitiveFile('proj/.ssh/deep/nested/whatever.txt')).toBe(true);
  });

  it('does not flag ordinary source files', () => {
    for (const p of [
      'proj/src/index.ts',
      'proj/README.md',
      'proj/environment.ts',
      'proj/keys.ts',
      'proj/src/env/config.ts',
      'proj/service-accounts.md',
    ]) {
      expect(isSensitiveFile(p)).toBe(false);
    }
  });

  it('does not flag a directory merely named like a secret file', () => {
    // `.env` as a path segment rather than the basename — a directory called
    // .env is not itself the credential file the policy is about.
    expect(isSensitiveFile('proj/.env/notes.md')).toBe(false);
  });
});

describe('file tools refuse credential files', () => {
  const projectRoot = path.resolve('/home/user/proj');

  beforeEach(() => {
    vi.clearAllMocks();
    settingsRepo.getCurrentState.mockReturnValue({ projectId: 'p1' });
    filesRepo.getByProjectId.mockReturnValue([{ type: 'directory', path: projectRoot }]);
  });

  const exec = (name: string, args: unknown) =>
    (builtinTools as Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }>)
      [name].execute(args, {} as never);

  it.each(['read_file', 'write_file', 'edit_file'])(
    '%s refuses a path inside .ssh',
    async (name) => {
      const args = name === 'read_file'
        ? { path: '.ssh/id_rsa' }
        : name === 'write_file'
          ? { path: '.ssh/id_rsa', content: 'x' }
          : { path: '.ssh/id_rsa', old_string: 'a', new_string: 'b' };

      await expect(exec(name, args)).rejects.toThrow(/credential file/i);
    },
  );

  it.each(['read_file', 'write_file', 'edit_file'])(
    '%s refuses .env even though it sits at the project root',
    async (name) => {
      const args = name === 'read_file'
        ? { path: '.env' }
        : name === 'write_file'
          ? { path: '.env', content: 'SECRET=1' }
          : { path: '.env', old_string: 'a', new_string: 'b' };

      await expect(exec(name, args)).rejects.toThrow(/credential file/i);
    },
  );

  it('still enforces containment before the secret check', async () => {
    await expect(exec('read_file', { path: '../../etc/passwd' })).rejects.toThrow(/Access denied/);
  });
});

describe('write_file gating', () => {
  it('requires approval, like edit_file and unlike read_file', () => {
    const gate = (name: string) =>
      (builtinTools as Record<string, { needsApproval?: unknown }>)[name].needsApproval;

    expect(gate('write_file')).toBe(true);
    expect(gate('edit_file')).toBe(true);
    // Read-only, so ungated — same posture as glob and grep.
    expect(gate('read_file')).toBeUndefined();
  });
});
