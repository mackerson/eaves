import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { ipcMain, app } from 'electron';
import type { Snapshot } from '../services/BackupService';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { relaunch: vi.fn(), quit: vi.fn() },
}));

const { mockLogger, mockService, mockScheduler, mockSync } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockService: {
    listSnapshots: vi.fn(),
    createSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    restoreFromSnapshot: vi.fn(),
  },
  mockScheduler: { stop: vi.fn() },
  mockSync: { stop: vi.fn() },
}));
// Quiesced before the restore so their timers can't fire a DB read into the
// window where enclave.db is being replaced.
vi.mock('../services/RoutineScheduler', () => ({ getRoutineScheduler: () => mockScheduler }));
vi.mock('../services/sync/SyncService', () => ({ getSyncService: () => mockSync }));
vi.mock('../services/logger', () => ({
  logger: mockLogger,
  getLogger: () => mockLogger,
}));
vi.mock('../services/BackupService', () => ({
  getBackupService: () => mockService,
}));

import { registerBackupHandlers } from './backups';

const VALID_FILENAME = 'enclave-20260514T143218456Z-manual.db';

function fakeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    filename: VALID_FILENAME,
    path: '/data/backups/' + VALID_FILENAME,
    sizeBytes: 12345,
    createdAt: 1747234338456,
    reason: 'manual',
    ...overrides,
  };
}

describe('Backup IPC handlers', () => {
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });
    registerBackupHandlers();
  });

  afterEach(() => vi.clearAllMocks());

  describe('backup:list', () => {
    it('returns the snapshot list from the service', async () => {
      const snaps = [fakeSnapshot({ filename: VALID_FILENAME, reason: 'manual' })];
      mockService.listSnapshots.mockReturnValue(snaps);

      const result = await handlers.get('backup:list')!({});
      expect(result).toEqual({ success: true, snapshots: snaps });
    });
  });

  describe('backup:create', () => {
    it('forces reason="manual" so the renderer cannot poison the history', async () => {
      mockService.createSnapshot.mockResolvedValue(fakeSnapshot());
      await handlers.get('backup:create')!({});
      expect(mockService.createSnapshot).toHaveBeenCalledWith('manual');
    });

    it('returns the created snapshot', async () => {
      const snap = fakeSnapshot();
      mockService.createSnapshot.mockResolvedValue(snap);

      const result = await handlers.get('backup:create')!({});
      expect(result).toEqual({ success: true, snapshot: snap });
    });
  });

  describe('backup:delete', () => {
    it('rejects malformed filenames before touching the service', async () => {
      const result = await handlers.get('backup:delete')!({}, '../../etc/passwd');
      expect(result.success).toBe(false);
      expect(mockService.deleteSnapshot).not.toHaveBeenCalled();
    });

    it('rejects unknown reasons embedded in the filename', async () => {
      const result = await handlers.get('backup:delete')!(
        {},
        'enclave-20260514T143218456Z-evil.db',
      );
      expect(result.success).toBe(false);
      expect(mockService.deleteSnapshot).not.toHaveBeenCalled();
    });

    it('forwards valid filenames to the service', async () => {
      const result = await handlers.get('backup:delete')!({}, VALID_FILENAME);
      expect(result.success).toBe(true);
      expect(mockService.deleteSnapshot).toHaveBeenCalledWith(VALID_FILENAME);
    });

    it('accepts the optional `-N` counter suffix', async () => {
      const withSuffix = 'enclave-20260514T143218456Z-manual-2.db';
      const result = await handlers.get('backup:delete')!({}, withSuffix);
      expect(result.success).toBe(true);
      expect(mockService.deleteSnapshot).toHaveBeenCalledWith(withSuffix);
    });
  });

  describe('backup:restore', () => {
    it('rejects malformed filenames', async () => {
      const result = await handlers.get('backup:restore')!({}, '../enclave.db');
      expect(result.success).toBe(false);
      expect(mockService.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(app.relaunch).not.toHaveBeenCalled();
      // Nothing is restored, so nothing should be torn down either.
      expect(mockScheduler.stop).not.toHaveBeenCalled();
      expect(mockSync.stop).not.toHaveBeenCalled();
    });

    // A routine tick or sync apply landing between closeDb and the file copy
    // reopens the DB about to be overwritten. Stop the tickers first.
    it('stops the timer-driven services before restoring', async () => {
      const order: string[] = [];
      mockScheduler.stop.mockImplementation(() => { order.push('scheduler'); });
      mockSync.stop.mockImplementation(() => { order.push('sync'); });
      mockService.restoreFromSnapshot.mockImplementation(async () => { order.push('restore'); });

      await handlers.get('backup:restore')!({}, VALID_FILENAME);

      expect(order).toEqual(['scheduler', 'sync', 'restore']);
    });

    it('restores even if a service refuses to stop', async () => {
      mockScheduler.stop.mockImplementation(() => { throw new Error('wedged'); });
      mockService.restoreFromSnapshot.mockResolvedValue(undefined);

      const result = await handlers.get('backup:restore')!({}, VALID_FILENAME);

      expect(result.success).toBe(true);
      expect(mockSync.stop).toHaveBeenCalled();
      expect(mockService.restoreFromSnapshot).toHaveBeenCalledWith(VALID_FILENAME);
    });

    it('relaunches the app after a successful restore', async () => {
      mockService.restoreFromSnapshot.mockResolvedValue(undefined);

      const result = await handlers.get('backup:restore')!({}, VALID_FILENAME);
      expect(result.success).toBe(true);
      expect(mockService.restoreFromSnapshot).toHaveBeenCalledWith(VALID_FILENAME);
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    it('does not relaunch when the service throws', async () => {
      mockService.restoreFromSnapshot.mockRejectedValue(new Error('disk full'));

      const result = await handlers.get('backup:restore')!({}, VALID_FILENAME);
      expect(result.success).toBe(false);
      expect(app.relaunch).not.toHaveBeenCalled();
      expect(app.quit).not.toHaveBeenCalled();
    });
  });
});
