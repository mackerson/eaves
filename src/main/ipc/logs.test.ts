import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { registerLogHandlers } from './logs';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    getLogDir: vi.fn(), getLogFiles: vi.fn(), clearLogs: vi.fn(),
  },
}));
vi.mock('../services/logger', () => ({
  logger: mockLogger,
  getLogger: () => mockLogger,
}));

describe('Logs IPC Handlers', () => {
  let handlers: Map<string, Function>;
  let logDir: string;
  let outsideDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-logs-outside-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-logs-test-'));
    // macOS hands out /var/... symlinked to /private/var/...; the handler
    // compares real paths, so the test's expectation has to as well.
    logDir = fs.realpathSync(logDir);
    mockLogger.getLogDir.mockReturnValue(logDir);

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerLogHandlers();
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe('read-log-file', () => {
    const read = (input: unknown) => handlers.get('read-log-file')!({}, input);

    it('reads a log file by bare name', async () => {
      fs.writeFileSync(path.join(logDir, 'enclave-2026-01-01.log'), 'hello');
      const result = await read('enclave-2026-01-01.log');
      expect(result).toMatchObject({ success: true, content: 'hello', truncated: false, size: 5 });
    });

    it('reads a log file by the absolute path get-log-files returns', async () => {
      const full = path.join(logDir, 'enclave-2026-01-01.log');
      fs.writeFileSync(full, 'hello');
      expect(await read(full)).toMatchObject({ success: true, content: 'hello' });
    });

    it('refuses a relative traversal', async () => {
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret');
      const result = await read(`../${path.basename(outsideDir)}/secret.txt`);
      expect(result.success).toBe(false);
      expect(result.content).toBeUndefined();
    });

    it('refuses an absolute path outside the log dir', async () => {
      const secret = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(secret, 'top secret');
      const result = await read(secret);
      expect(result.success).toBe(false);
      expect(result.content).toBeUndefined();
    });

    it('refuses a non-log file that happens to sit in the log dir', async () => {
      fs.writeFileSync(path.join(logDir, 'credentials.json'), '{"key":"sk-live"}');
      expect((await read('credentials.json')).success).toBe(false);
    });

    it('refuses a symlink in the log dir pointing outside it', async () => {
      const secret = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(secret, 'top secret');
      fs.symlinkSync(secret, path.join(logDir, 'enclave-evil.log'));
      const result = await read('enclave-evil.log');
      expect(result.success).toBe(false);
      expect(result.content).toBeUndefined();
    });

    it('refuses a directory', async () => {
      fs.mkdirSync(path.join(logDir, 'enclave-dir.log'));
      expect((await read('enclave-dir.log')).success).toBe(false);
    });

    it('rejects non-string and empty input', async () => {
      expect((await read(null)).success).toBe(false);
      expect((await read('')).success).toBe(false);
      expect((await read({ path: 'enclave-2026-01-01.log' })).success).toBe(false);
    });

    it('returns the tail and flags truncation for an oversized log', async () => {
      const big = path.join(logDir, 'enclave-big.log');
      const size = 1024 * 1024 + 100;
      fs.writeFileSync(big, 'a'.repeat(size - 3) + 'END');
      const result = await read('enclave-big.log');
      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.size).toBe(size);
      expect(result.content.length).toBe(1024 * 1024);
      expect(result.content.endsWith('END')).toBe(true);
    });

    it('reports a missing file without leaking whether it exists elsewhere', async () => {
      const result = await read('enclave-nope.log');
      expect(result).toEqual({ success: false, error: 'Log file not found' });
    });
  });
});
