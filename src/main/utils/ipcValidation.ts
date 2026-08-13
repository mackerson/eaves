import { z } from 'zod/v3';
import { validateWithSchema, type ValidationResult } from '../../shared/validation';
import { logger } from '../services/logger';

/**
 * Validate IPC input with automatic warning log on failure.
 * Reduces the repeated 4-line validate+check+log+return pattern to 2 lines:
 *
 *   const v = validateIPC(Schema, data, 'handler-name');
 *   if (!v.success) return v;
 */
export function validateIPC<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  handlerName: string
): ValidationResult<T> {
  const result = validateWithSchema(schema, data);
  if (!result.success) {
    logger.warn(`[IPC] ${handlerName} validation failed:`, result.error);
  }
  return result;
}

/**
 * Wrap an IPC handler so thrown errors are caught and returned as
 * `{ success: false, error: string }` instead of rejecting the IPC promise.
 *
 * Use this for handlers that need a uniform response envelope.
 */
export function ipcResult<T extends (...args: any[]) => Promise<any>>(
  handlerName: string,
  fn: T
): (...args: Parameters<T>) => Promise<ReturnType<T> | { success: false; error: string }> {
  return async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error(`[IPC] ${handlerName} failed:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  };
}
