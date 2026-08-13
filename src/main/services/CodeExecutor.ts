import { randomUUID } from 'crypto';
import {
  ExecutionRequest,
  ExecutionResult,
  ExecutionContext,
  ExecutionStats,
  ExecutorOptions,
  ExecutionLanguage,
} from '../types/code-execution';
import { JavaScriptExecutor } from './executors/JavaScriptExecutor';
import { PythonExecutor } from './executors/PythonExecutor';
import { ShellExecutor } from './executors/ShellExecutor';
import { eventBus } from './EventBus';
import { logger } from './logger';
import { getActiveWorkRegistry } from './ActiveWorkRegistry';

/**
 * Main code execution service
 * Coordinates execution across different languages with event emission
 */
export class CodeExecutor {
  private jsExecutor: JavaScriptExecutor;
  private pyExecutor: PythonExecutor;
  private shExecutor: ShellExecutor;

  private activeExecutions: Map<string, ExecutionContext> = new Map();
  private stats: ExecutionStats = {
    total: 0,
    successful: 0,
    failed: 0,
    timedOut: 0,
    averageTime: 0,
    totalTime: 0,
    byLanguage: {
      javascript: { count: 0, avgTime: 0 },
      python: { count: 0, avgTime: 0 },
      shell: { count: 0, avgTime: 0 },
    },
  };

  constructor() {
    this.jsExecutor = new JavaScriptExecutor();
    this.pyExecutor = new PythonExecutor();
    this.shExecutor = new ShellExecutor();

    logger.info('[CodeExecutor] Service initialized');
  }

  /**
   * Execute code with specified language and options
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const startTime = Date.now();

    // Create execution context
    const context: ExecutionContext = {
      id: executionId,
      language: request.language,
      startTime,
      abortController: new AbortController(),
    };

    this.activeExecutions.set(executionId, context);
    const work = getActiveWorkRegistry().start({
      kind: 'code-execution',
      containerId: executionId,
      label: request.language,
      onCancel: () => context.abortController.abort(),
    });

    // Emit start event
    eventBus.emitEvent('code-execution:start', {
      executionId,
      language: request.language,
      timeout: request.timeout || 30000,
      codeHash: this.hashCode(request.code),
    });

    try {
      // Prepare options
      const options: ExecutorOptions = {
        timeout: request.timeout || 30000,
        maxMemory: request.maxMemory || 256,
        workingDirectory: request.workingDirectory || '',
        env: request.env || {},
        allowNetwork: request.allowNetwork || false,
        context: request.context,
      };

      // Execute based on language
      const executor = this.getExecutor(request.language);
      const result = await executor.executeCode(request.code, options);

      // Add execution ID to result
      result.executionId = executionId;

      // Update stats
      this.updateStats(request.language, result);

      // Emit completion event
      if (result.success) {
        eventBus.emitEvent('code-execution:complete', {
          executionId,
          language: request.language,
          executionTime: result.executionTime,
          success: true,
          hasArtifacts: !!result.artifacts && result.artifacts.length > 0,
        });
      } else {
        eventBus.emitEvent('code-execution:error', {
          executionId,
          language: request.language,
          executionTime: result.executionTime,
          exitCode: result.exitCode,
          error: result.error || 'Unknown error',
          stderr: result.stderr,
        });
      }

      return result;
    } catch (error: any) {
      const executionTime = Date.now() - startTime;

      logger.error('[CodeExecutor] Execution failed:', error);

      // Update stats
      this.stats.total++;
      this.stats.failed++;
      this.stats.totalTime += executionTime;
      this.stats.averageTime = this.stats.totalTime / this.stats.total;

      // Emit error event
      eventBus.emitEvent('code-execution:error', {
        executionId,
        language: request.language,
        executionTime,
        error: error.message || String(error),
      });

      return {
        success: false,
        stdout: '',
        stderr: error.message || String(error),
        exitCode: 1,
        executionTime,
        error: error.message || String(error),
        executionId,
      };
    } finally {
      this.activeExecutions.delete(executionId);
      work.done();
    }
  }

  /**
   * Cancel an active execution
   */
  async cancel(executionId: string): Promise<boolean> {
    const context = this.activeExecutions.get(executionId);
    if (!context) {
      return false;
    }

    logger.info(`[CodeExecutor] Cancelling execution ${executionId}`);
    context.abortController.abort();
    this.activeExecutions.delete(executionId);

    eventBus.emitEvent('code-execution:cancelled', {
      executionId,
      language: context.language,
    });

    return true;
  }

  /**
   * Get active executions
   */
  getActiveExecutions(): ExecutionContext[] {
    return Array.from(this.activeExecutions.values());
  }

  /**
   * Get execution statistics
   */
  getStats(): ExecutionStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      total: 0,
      successful: 0,
      failed: 0,
      timedOut: 0,
      averageTime: 0,
      totalTime: 0,
      byLanguage: {
        javascript: { count: 0, avgTime: 0 },
        python: { count: 0, avgTime: 0 },
        shell: { count: 0, avgTime: 0 },
      },
    };
    logger.info('[CodeExecutor] Statistics reset');
  }

  /**
   * Get executor for language
   */
  private getExecutor(language: ExecutionLanguage) {
    switch (language) {
      case 'javascript':
        return this.jsExecutor;
      case 'python':
        return this.pyExecutor;
      case 'shell':
        return this.shExecutor;
      default:
        throw new Error(`Unsupported language: ${language}`);
    }
  }

  /**
   * Update statistics after execution
   */
  private updateStats(language: ExecutionLanguage, result: ExecutionResult): void {
    this.stats.total++;
    this.stats.totalTime += result.executionTime;

    if (result.success) {
      this.stats.successful++;
    } else {
      this.stats.failed++;

      // Check if timeout
      if (result.exitCode === 124) {
        this.stats.timedOut++;
      }
    }

    this.stats.averageTime = this.stats.totalTime / this.stats.total;

    // Update by-language stats
    const langStats = this.stats.byLanguage[language];
    langStats.count++;
    langStats.avgTime = langStats.avgTime
      ? (langStats.avgTime * (langStats.count - 1) + result.executionTime) / langStats.count
      : result.executionTime;
  }

  /**
   * Simple hash of code for tracking (not cryptographic)
   */
  private hashCode(code: string): string {
    let hash = 0;
    for (let i = 0; i < code.length; i++) {
      const char = code.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }
}

// Singleton instance
let codeExecutor: CodeExecutor | null = null;

/**
 * Get CodeExecutor singleton instance
 */
export function getCodeExecutor(): CodeExecutor {
  if (!codeExecutor) {
    codeExecutor = new CodeExecutor();
  }
  return codeExecutor;
}
