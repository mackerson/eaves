import { ipcMain, shell } from 'electron';
import { logger } from '../services/logger';
import * as fs from 'fs';
import * as path from 'path';
import { LogErrorSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { z } from 'zod/v3';

const LogFilePathSchema = z.string().min(1).max(500);

/**
 * The only names the logger ever writes: `enclave-<date>.log` and
 * `enclave-<rotation timestamp>.log`. Matching against the producer's own
 * naming — rather than just stripping directories — is what keeps this handler
 * a log reader instead of a general-purpose file reader for anything that
 * happens to sit in the log directory. The character class excludes both path
 * separators, so nothing that passes can name a file outside it.
 */
const LOG_FILE_NAME_PATTERN = /^enclave-[A-Za-z0-9._-]+\.log$/;

/**
 * A log file is capped at 10MB by the logger and there can be five of them.
 * Shipping a whole one over IPC to be rendered would be a UI freeze, so read
 * the tail — the end of a log is the part anyone actually wants — and tell the
 * caller when the read was cut, rather than handing back a silently partial
 * file.
 */
const MAX_LOG_READ_BYTES = 1024 * 1024;

export function registerLogHandlers() {
  ipcMain.handle('get-log-files', ipcResult('get-log-files', async () => {
    const files = logger.getLogFiles();
    return files.map(filePath => ({
      path: filePath,
      name: filePath.split('/').pop() || filePath.split('\\').pop() || 'unknown',
      size: fs.statSync(filePath).size,
      modified: fs.statSync(filePath).mtime.getTime(),
    }));
  }));

  ipcMain.handle('get-log-dir', ipcResult('get-log-dir', async () => {
    return logger.getLogDir();
  }));

  ipcMain.handle('open-log-dir', ipcResult('open-log-dir', async () => {
    const logDir = logger.getLogDir();
    shell.openPath(logDir);
    return { success: true };
  }));

  ipcMain.handle('read-log-file', ipcResult('read-log-file', async (_event, filePath: string) => {
    const validation = validateIPC(LogFilePathSchema, filePath, 'read-log-file');
    if (!validation.success) return validation;

    // Accepts either a bare filename or a full path as returned by
    // get-log-files; only the basename is ever trusted, and it must look like a
    // file this app wrote.
    const name = path.basename(validation.data);
    if (!LOG_FILE_NAME_PATTERN.test(name)) {
      return { success: false, error: 'Invalid log file path' };
    }

    // Resolve symlinks on both sides before comparing. A name that passes the
    // pattern can still be a symlink someone dropped in the log directory
    // pointing at ~/.ssh/id_rsa; comparing real paths is what makes the
    // containment check mean something.
    const logDir = fs.realpathSync(logger.getLogDir());
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(path.join(logDir, name));
    } catch {
      return { success: false, error: 'Log file not found' };
    }

    const stats = fs.statSync(resolvedPath);
    if (path.dirname(resolvedPath) !== logDir || !stats.isFile()) {
      return { success: false, error: 'Invalid log file path' };
    }

    const start = Math.max(0, stats.size - MAX_LOG_READ_BYTES);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }

    return {
      success: true,
      content: buffer.toString('utf-8'),
      size: stats.size,
      truncated: start > 0,
    };
  }));

  ipcMain.handle('clear-logs', ipcResult('clear-logs', async () => {
    logger.clearLogs();
    return { success: true };
  }));

  ipcMain.handle('log-error', ipcResult('log-error', async (_event, errorData: {
    message: string;
    stack?: string;
    componentStack?: string;
    timestamp?: number;
  }) => {
    const validation = validateIPC(LogErrorSchema, errorData, 'log-error');
    if (!validation.success) return validation;
    const validData = validation.data;

    let timestampISO: string;
    try {
      timestampISO = validData.timestamp && !isNaN(validData.timestamp)
        ? new Date(validData.timestamp).toISOString()
        : new Date().toISOString();
    } catch {
      timestampISO = new Date().toISOString();
    }

    logger.error('React Error:', {
      message: validData.message,
      stack: validData.stack,
      componentStack: validData.componentStack,
      timestamp: timestampISO,
    });
    return { success: true };
  }));
}
