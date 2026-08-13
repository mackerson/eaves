import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { ipcMain, dialog, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { registerFileHandlers } from './files';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn() },
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/logger', () => ({
  logger: mockLogger,
  getLogger: () => mockLogger,
}));
vi.mock('../repositories', () => ({
  getFileRepository: vi.fn(() => ({})),
}));

describe('Files IPC Handlers', () => {
  let handlers: Map<string, Function>;
  let userDataDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-files-test-'));
    (app.getPath as Mock).mockReturnValue(userDataDir);

    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    registerFileHandlers();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  describe('dialog:pick-avatar', () => {
    it('copies the picked image into userData/avatars and returns the bare filename', async () => {
      const handler = handlers.get('dialog:pick-avatar')!;
      const sourcePath = path.join(userDataDir, 'source.png');
      fs.writeFileSync(sourcePath, 'fake-png-bytes');
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: false,
        filePaths: [sourcePath],
      });

      const result = await handler({});

      expect(result.canceled).toBe(false);
      expect(result.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
      expect(result.filename).not.toContain(path.sep);
      const copiedPath = path.join(userDataDir, 'avatars', result.filename);
      expect(fs.readFileSync(copiedPath, 'utf8')).toBe('fake-png-bytes');
    });

    it('returns canceled when the user cancels the dialog', async () => {
      const handler = handlers.get('dialog:pick-avatar')!;
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await handler({});

      expect(result.canceled).toBe(true);
      expect(fs.existsSync(path.join(userDataDir, 'avatars'))).toBe(false);
    });

    it('rejects files without an image extension', async () => {
      const handler = handlers.get('dialog:pick-avatar')!;
      const sourcePath = path.join(userDataDir, 'not-an-image.txt');
      fs.writeFileSync(sourcePath, 'text');
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: false,
        filePaths: [sourcePath],
      });

      const result = await handler({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported avatar image type');
    });
  });
});
