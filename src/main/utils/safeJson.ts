/**
 * Safe JSON parsing utilities
 * Handles corrupted or invalid JSON data gracefully
 */

import { logger } from '../services/logger';

/**
 * Safely parse JSON with a fallback value
 * Returns the fallback if parsing fails instead of throwing
 */
export function safeJsonParse<T>(
  value: string | null | undefined,
  fallback: T,
  context?: string
): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    if (context) {
      logger.warn(`[SafeJSON] Failed to parse JSON in ${context}:`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        valuePreview: value.substring(0, 100)
      });
    }
    return fallback;
  }
}

/**
 * Safely parse JSON, returning undefined if parsing fails
 */
export function safeJsonParseOptional<T>(
  value: string | null | undefined,
  context?: string
): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    if (context) {
      logger.warn(`[SafeJSON] Failed to parse JSON in ${context}:`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        valuePreview: value.substring(0, 100)
      });
    }
    return undefined;
  }
}
