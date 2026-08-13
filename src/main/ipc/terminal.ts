import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { getTerminalManager, TerminalOptions } from '../services/TerminalManager';
import { getLogger } from '../services/logger';
import {
  CreateTerminalSchema,
  ResizeTerminalSchema,
  EntityIdSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerTerminalHandlers(): void {
  const TerminalManager = getTerminalManager();
  ipcMain.handle('terminal:create', ipcResult('terminal:create', async (_event: IpcMainInvokeEvent, { id, options }: { id: string; options: TerminalOptions }) => {
    const idValidation = validateIPC(EntityIdSchema, id, 'terminal:create id');
    if (!idValidation.success) return idValidation;
    const optionsValidation = validateIPC(CreateTerminalSchema, options, 'terminal:create options');
    if (!optionsValidation.success) return optionsValidation;

    // `optionsValidation.data`, not the raw `options` — passing the
    // unvalidated original discards anything the schema coerced or defaulted.
    // Inert today because the consumer whitelists fields, and a real bug the
    // moment this schema gains a transform or default.
    const cwd = TerminalManager.createTerminal(idValidation.data, optionsValidation.data);
    // The resolved directory, not the requested one — `options.cwd` falls back
    // to the home directory when absent, and the renderer has to be able to
    // tell the user where the shell actually is.
    return { success: true, cwd };
  }));

  ipcMain.handle('terminal:write', ipcResult('terminal:write', async (_event: IpcMainInvokeEvent, { id, data }: { id: string; data: string }) => {
    const validation = validateIPC(EntityIdSchema, id, 'terminal:write');
    if (!validation.success) return validation;

    TerminalManager.writeToTerminal(validation.data, data);
    return { success: true };
  }));

  ipcMain.handle('terminal:resize', ipcResult('terminal:resize', async (_event: IpcMainInvokeEvent, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    const idValidation = validateIPC(EntityIdSchema, id, 'terminal:resize id');
    if (!idValidation.success) return idValidation;
    const dimsValidation = validateIPC(ResizeTerminalSchema, { cols, rows }, 'terminal:resize dims');
    if (!dimsValidation.success) return dimsValidation;

    TerminalManager.resizeTerminal(idValidation.data, dimsValidation.data.cols, dimsValidation.data.rows);
    return { success: true };
  }));

  ipcMain.handle('terminal:destroy', ipcResult('terminal:destroy', async (_event: IpcMainInvokeEvent, id: string) => {
    const validation = validateIPC(EntityIdSchema, id, 'terminal:destroy');
    if (!validation.success) return validation;

    TerminalManager.destroyTerminal(validation.data);
    return { success: true };
  }));

  ipcMain.handle('terminal:list', ipcResult('terminal:list', async () => {
    const terminals = TerminalManager.getTerminals();
    return {
      success: true,
      terminals: terminals.map((t) => ({
        id: t.id,
        cwd: t.cwd,
        command: t.command,
      })),
    };
  }));
}

export function unregisterTerminalHandlers(): void {
  const logger = getLogger();
  const terminalManager = getTerminalManager();

  logger.info('[IPC] Unregistering terminal handlers');

  ipcMain.removeHandler('terminal:create');
  ipcMain.removeHandler('terminal:write');
  ipcMain.removeHandler('terminal:resize');
  ipcMain.removeHandler('terminal:destroy');
  ipcMain.removeHandler('terminal:list');

  terminalManager.cleanup();
}
