import { ipcMain } from 'electron';
import { z } from 'zod/v3';
import { getSyncService } from '../services/sync/SyncService';
import {
  SyncConnectSchema,
  SyncDeviceIdSchema,
  SyncDeviceNameSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerSyncHandlers() {
  ipcMain.handle('sync:get-state', ipcResult('sync:get-state', async () => {
    return { success: true, state: getSyncService().getState() };
  }));

  ipcMain.handle('sync:set-enabled', ipcResult('sync:set-enabled', async (_event, enabled: unknown) => {
    const validation = validateIPC(z.boolean(), enabled, 'sync:set-enabled');
    if (!validation.success) return validation;
    await getSyncService().setEnabled(validation.data);
    return { success: true, state: getSyncService().getState() };
  }));

  ipcMain.handle('sync:set-device-name', ipcResult('sync:set-device-name', async (_event, name: unknown) => {
    const validation = validateIPC(SyncDeviceNameSchema, name, 'sync:set-device-name');
    if (!validation.success) return validation;
    getSyncService().setDeviceName(validation.data);
    return { success: true };
  }));

  ipcMain.handle('sync:set-pairing-mode', ipcResult('sync:set-pairing-mode', async (_event, active: unknown) => {
    const validation = validateIPC(z.boolean(), active, 'sync:set-pairing-mode');
    if (!validation.success) return validation;
    getSyncService().setPairingMode(validation.data);
    return { success: true };
  }));

  ipcMain.handle('sync:confirm-pair', ipcResult('sync:confirm-pair', async () => {
    getSyncService().confirmPairing();
    return { success: true };
  }));

  ipcMain.handle('sync:reject-pair', ipcResult('sync:reject-pair', async () => {
    getSyncService().rejectPairing();
    return { success: true };
  }));

  ipcMain.handle('sync:connect', ipcResult('sync:connect', async (_event, target: unknown) => {
    const validation = validateIPC(SyncConnectSchema, target, 'sync:connect');
    if (!validation.success) return validation;
    await getSyncService().connectToDevice(validation.data.host, validation.data.port);
    return { success: true };
  }));

  ipcMain.handle('sync:unpair', ipcResult('sync:unpair', async (_event, deviceId: unknown) => {
    const validation = validateIPC(SyncDeviceIdSchema, deviceId, 'sync:unpair');
    if (!validation.success) return validation;
    getSyncService().unpair(validation.data);
    return { success: true };
  }));
}
