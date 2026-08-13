import { ipcMain, BrowserWindow } from 'electron';
import { EntityIdSchema, StartWorkSessionSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import {
  startWorkSession,
  getWorkSession,
  listWorkSessionsForTask,
} from '../services/WorkSessionService';

/**
 * Work-session IPC (docs/architecture/work-sessions.md).
 *
 * Deliberately narrow: start, read, list. Running a turn inside a session is
 * the existing `chat-with-agent` handler — a session is a conversation, and
 * giving it a parallel turn API would be a second thing to keep correct.
 */
export function registerWorkSessionHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle('work-sessions:start', ipcResult('work-sessions:start', async (_event, params: unknown) => {
    const validation = validateIPC(StartWorkSessionSchema, params, 'work-sessions:start');
    if (!validation.success) return validation;
    return startWorkSession({ ...validation.data, getMainWindow });
  }));

  ipcMain.handle('work-sessions:get', ipcResult('work-sessions:get', async (_event, sessionId: string) => {
    const validation = validateIPC(EntityIdSchema, sessionId, 'work-sessions:get');
    if (!validation.success) return validation;
    const session = getWorkSession(validation.data);
    return session ? { success: true, session } : { success: false, error: 'Work session not found' };
  }));

  ipcMain.handle('work-sessions:list-for-task', ipcResult('work-sessions:list-for-task', async (_event, taskId: string) => {
    const validation = validateIPC(EntityIdSchema, taskId, 'work-sessions:list-for-task');
    if (!validation.success) return validation;
    return { success: true, sessions: listWorkSessionsForTask(validation.data) };
  }));
}
