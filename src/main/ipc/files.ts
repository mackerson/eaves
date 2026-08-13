import { ipcMain, dialog, app } from 'electron';
import { randomUUID } from 'crypto';
import { logger } from '../services/logger';
import { getFileRepository } from '../repositories';
import * as path from 'path';
import * as fs from 'fs';
import {
  EntityIdSchema,
  AddFileSchema,
  AddMultipleFilesSchema,
  DialogFileOptionsSchema,
  DialogDirectoryOptionsSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import {
  getMimeType,
  getImageMimeType,
  isImageAttachmentExt,
  IMAGE_ATTACHMENT_EXTS,
  TEXT_ATTACHMENT_EXTS,
} from '../utils/mimeTypes';

export function registerFileHandlers() {
  const filesRepo = getFileRepository();

  ipcMain.handle('dialog:open-file', ipcResult('dialog:open-file', async (_event, options?: unknown) => {
    const validation = validateIPC(DialogFileOptionsSchema, options, 'dialog:open-file');
    if (!validation.success) return validation;
    const validOptions = validation.data;

    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: validOptions?.title || 'Select File',
      filters: validOptions?.filters || [],
    });

    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    };
  }));

  ipcMain.handle('dialog:pick-images', ipcResult('dialog:pick-images', async () => {
    // Extensions without the leading dot for Electron's filter format.
    const imageExts = [...IMAGE_ATTACHMENT_EXTS].map(e => e.slice(1));
    const textExts = [...TEXT_ATTACHMENT_EXTS].map(e => e.slice(1));
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Select Files',
      filters: [
        { name: 'Supported files', extensions: [...imageExts, ...textExts] },
        { name: 'Images', extensions: imageExts },
        { name: 'Text & documents', extensions: textExts },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result.canceled) {
      return { canceled: true, filePaths: [] };
    }

    const files = result.filePaths.map(filePath => {
      const filename = path.basename(filePath);
      const isImage = isImageAttachmentExt(path.extname(filePath));
      // Only images get an inline preview data URL; text files just show a
      // chip. mimeType still resolves for both (default per kind).
      if (isImage) {
        const mimeType = getImageMimeType(filePath, 'image/jpeg');
        const base64 = fs.readFileSync(filePath).toString('base64');
        return {
          path: filePath,
          filename,
          mimeType,
          previewDataUrl: `data:${mimeType};base64,${base64}`,
        };
      }
      return {
        path: filePath,
        filename,
        mimeType: getMimeType(filePath) ?? 'text/plain',
        previewDataUrl: undefined,
      };
    });

    return { canceled: false, files };
  }));

  ipcMain.handle('dialog:pick-avatar', ipcResult('dialog:pick-avatar', async () => {
    const imageExts = [...IMAGE_ATTACHMENT_EXTS].map(e => e.slice(1));
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Select Avatar Image',
      filters: [{ name: 'Images', extensions: imageExts }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const sourcePath = result.filePaths[0];
    const ext = path.extname(sourcePath).toLowerCase();
    if (!isImageAttachmentExt(ext)) {
      throw new Error(`Unsupported avatar image type: ${ext || '(no extension)'}`);
    }

    // The avatar:// protocol only serves files from userData/avatars by bare
    // filename, so copy the picked image there and hand back the filename.
    const avatarsDir = path.join(app.getPath('userData'), 'avatars');
    fs.mkdirSync(avatarsDir, { recursive: true });
    const filename = `${randomUUID()}${ext}`;
    fs.copyFileSync(sourcePath, path.join(avatarsDir, filename));

    return { canceled: false, filename };
  }));

  ipcMain.handle('dialog:open-directory', ipcResult('dialog:open-directory', async (_event, options?: unknown) => {
    const validation = validateIPC(DialogDirectoryOptionsSchema, options, 'dialog:open-directory');
    if (!validation.success) return validation;
    const validOptions = validation.data;

    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: validOptions?.title || 'Select Directory',
    });

    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    };
  }));

  ipcMain.handle('files:pick-files', ipcResult('files:pick-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Select Files',
    });

    if (result.canceled) {
      return { canceled: true, paths: [] };
    }

    return { canceled: false, paths: result.filePaths };
  }));

  ipcMain.handle('files:pick-folder', ipcResult('files:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Folder',
    });

    if (result.canceled) {
      return { canceled: true, paths: [] };
    }

    return { canceled: false, paths: result.filePaths };
  }));

  ipcMain.handle('files:list', ipcResult('files:list', async (_event, projectId: string) => {
    const validation = validateIPC(EntityIdSchema, projectId, 'files:list');
    if (!validation.success) return validation;

    logger.debug('[Files] Listing files for project:', validation.data);
    return filesRepo.getByProjectId(validation.data);
  }));

  ipcMain.handle('files:add', ipcResult('files:add', async (_event, { projectId, filePath }: { projectId: string; filePath: string }) => {
    const validation = validateIPC(AddFileSchema, { projectId, filePath }, 'files:add');
    if (!validation.success) return validation;
    const validData = validation.data;

    logger.info('[Files] Adding file:', { projectId: validData.projectId, filePath: validData.filePath });

    if (!fs.existsSync(validData.filePath)) {
      throw new Error(`Path does not exist: ${validData.filePath}`);
    }

    const stats = fs.statSync(validData.filePath);
    const isDirectory = stats.isDirectory();
    const fileName = path.basename(validData.filePath);

    const existing = filesRepo.getByPath(validData.filePath, validData.projectId);
    if (existing) {
      logger.warn('[Files] File already exists in database:', validData.filePath);
      return existing;
    }

    const file = filesRepo.create({
      projectId: validData.projectId,
      name: fileName,
      path: validData.filePath,
      type: isDirectory ? 'directory' : 'file',
      size: isDirectory ? undefined : stats.size,
      mimeType: isDirectory ? undefined : getMimeType(validData.filePath),
    });

    logger.info('[Files] File added successfully:', file.id);
    return file;
  }));

  ipcMain.handle('files:add-multiple', ipcResult('files:add-multiple', async (_event, { projectId, filePaths }: { projectId: string; filePaths: string[] }) => {
    const validation = validateIPC(AddMultipleFilesSchema, { projectId, filePaths }, 'files:add-multiple');
    if (!validation.success) return validation;
    const validData = validation.data;

    logger.info('[Files] Adding multiple files:', { projectId: validData.projectId, count: validData.filePaths.length });

    const results = [];
    for (const fp of validData.filePaths) {
      try {
        if (!fs.existsSync(fp)) {
          throw new Error(`Path does not exist: ${fp}`);
        }

        const stats = fs.statSync(fp);
        const isDirectory = stats.isDirectory();
        const fileName = path.basename(fp);

        const existing = filesRepo.getByPath(fp, validData.projectId);
        if (existing) {
          results.push({ success: true, file: existing });
          continue;
        }

        const file = filesRepo.create({
          projectId: validData.projectId,
          name: fileName,
          path: fp,
          type: isDirectory ? 'directory' : 'file',
          size: isDirectory ? undefined : stats.size,
          mimeType: undefined,
        });

        results.push({ success: true, file });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[Files] Failed to add file:', { filePath: fp, error: message });
        results.push({ success: false, path: fp, error: message });
      }
    }

    return results;
  }));

  ipcMain.handle('files:remove', ipcResult('files:remove', async (_event, fileId: string) => {
    const validation = validateIPC(EntityIdSchema, fileId, 'files:remove');
    if (!validation.success) return validation;

    logger.info('[Files] Removing file:', validation.data);
    const success = filesRepo.delete(validation.data);
    return { success };
  }));

  ipcMain.handle('files:get', ipcResult('files:get', async (_event, fileId: string) => {
    const validation = validateIPC(EntityIdSchema, fileId, 'files:get');
    if (!validation.success) return validation;

    return filesRepo.getById(validation.data);
  }));
}
