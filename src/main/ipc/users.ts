import { ipcMain } from 'electron';
import { getUserRepository } from '../repositories';
import { User } from '../types';
import {
  CreateUserSchema,
  UpdateUserSchema,
  EntityIdSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerUserHandlers() {
  ipcMain.handle('get-users', ipcResult('get-users', async () => {
    const userRepo = getUserRepository();
    return userRepo.getAll();
  }));

  ipcMain.handle('get-current-user', ipcResult('get-current-user', async () => {
    const userRepo = getUserRepository();
    return userRepo.getCurrent();
  }));

  ipcMain.handle('create-user', ipcResult('create-user', async (_event, userData: Omit<User, 'id' | 'createdAt' | 'isCurrent'>) => {
    const validation = validateIPC(CreateUserSchema, userData, 'create-user');
    if (!validation.success) return validation;

    const userRepo = getUserRepository();
    return userRepo.create({ name: validation.data.name, color: validation.data.color ?? '#667eea' });
  }));

  ipcMain.handle('update-user', ipcResult('update-user', async (_event, { userId, updates }: { userId: string; updates: Partial<Pick<User, 'name' | 'color'>> }) => {
    const idValidation = validateIPC(EntityIdSchema, userId, 'update-user userId');
    if (!idValidation.success) return idValidation;

    const updatesValidation = validateIPC(UpdateUserSchema, updates, 'update-user updates');
    if (!updatesValidation.success) return updatesValidation;

    const userRepo = getUserRepository();
    return userRepo.update(idValidation.data, updatesValidation.data);
  }));

  ipcMain.handle('delete-user', ipcResult('delete-user', async (_event, userId: string) => {
    const validation = validateIPC(EntityIdSchema, userId, 'delete-user');
    if (!validation.success) return validation;

    const userRepo = getUserRepository();
    return userRepo.delete(validation.data);
  }));

  ipcMain.handle('switch-user', ipcResult('switch-user', async (_event, userId: string) => {
    const validation = validateIPC(EntityIdSchema, userId, 'switch-user');
    if (!validation.success) return validation;

    const userRepo = getUserRepository();
    return userRepo.switchTo(validation.data);
  }));
}
