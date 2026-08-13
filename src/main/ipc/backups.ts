import { ipcMain, app } from 'electron';
import { getBackupService } from '../services/BackupService';
import { getRoutineScheduler } from '../services/RoutineScheduler';
import { getSyncService } from '../services/sync/SyncService';
import { BackupFilenameSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { logger } from '../services/logger';

/**
 * Stop the timer-driven services that would otherwise fire a DB read into the
 * middle of a restore. `beginDatabaseRestore` locks the singleton so anything
 * missed here fails loudly instead of reopening the file being replaced, but a
 * logged error still beats a thrown one from inside a timer callback — so stop
 * the known tickers up front and let the lock cover the rest.
 *
 * Best-effort by design: a service that fails to stop must not block the
 * restore the user asked for.
 */
function quiesceForRestore(): void {
  for (const [name, stop] of [
    ['routine scheduler', () => getRoutineScheduler().stop()],
    ['sync service', () => getSyncService().stop()],
  ] as const) {
    try {
      stop();
    } catch (error) {
      logger.warn(`[Backup] Failed to stop ${name} before restore:`, error);
    }
  }
}

export function registerBackupHandlers() {
  ipcMain.handle('backup:list', ipcResult('backup:list', async () => {
    const snapshots = getBackupService().listSnapshots();
    return { success: true, snapshots };
  }));

  ipcMain.handle('backup:create', ipcResult('backup:create', async () => {
    // Manual snapshots only via IPC — startup/periodic/pre-restore are
    // produced internally by the service; reflecting them in the API would
    // let a compromised renderer poison the snapshot-reason history.
    const snapshot = await getBackupService().createSnapshot('manual');
    return { success: true, snapshot };
  }));

  ipcMain.handle('backup:delete', ipcResult('backup:delete', async (_event, filename: unknown) => {
    const validation = validateIPC(BackupFilenameSchema, filename, 'backup:delete');
    if (!validation.success) return validation;
    getBackupService().deleteSnapshot(validation.data);
    return { success: true };
  }));

  ipcMain.handle('backup:restore', ipcResult('backup:restore', async (_event, filename: unknown) => {
    const validation = validateIPC(BackupFilenameSchema, filename, 'backup:restore');
    if (!validation.success) return validation;

    quiesceForRestore();
    await getBackupService().restoreFromSnapshot(validation.data);

    // Relaunch so the renderer reconnects to a fresh DB handle. Quitting
    // before relaunch ensures no half-state survives. We don't relaunch
    // inside the service so its tests don't need to mock Electron.
    logger.info('[Backup] Relaunching after restore');
    app.relaunch();
    app.quit();

    return { success: true };
  }));
}
