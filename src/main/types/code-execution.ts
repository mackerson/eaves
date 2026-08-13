export type ExecutionLanguage = 'javascript' | 'python' | 'shell';

export interface ExecutionRequest {
  language: ExecutionLanguage;
  code: string;
  context?: Record<string, any>;
  /** Default: 30000 */
  timeout?: number;
  /** Default: 256 */
  maxMemory?: number;
  workingDirectory?: string;
  /** Whitelist; default: all standard library */
  allowedImports?: string[];
  /** Default: false */
  allowNetwork?: boolean;
  env?: Record<string, string>;
}

export interface ExecutionArtifact {
  name: string;
  path: string;
  /** For small text files */
  content?: string;
  mimeType?: string;
  size?: number;
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  returnValue?: any;
  artifacts?: ExecutionArtifact[];
  /** Milliseconds */
  executionTime: number;
  exitCode: number;
  error?: string;
  executionId?: string;
}

export interface ExecutorOptions {
  /** Milliseconds */
  timeout: number;
  /** MB */
  maxMemory: number;
  workingDirectory: string;
  env: Record<string, string>;
  allowNetwork: boolean;
  /** Workflow context variables available to code */
  context?: Record<string, any>;
}

export interface ExecutionContext {
  id: string;
  language: ExecutionLanguage;
  startTime: number;
  pid?: number;
  abortController: AbortController;
}

export interface ExecutionStats {
  total: number;
  successful: number;
  failed: number;
  timedOut: number;
  /** Milliseconds */
  averageTime: number;
  /** Milliseconds */
  totalTime: number;
  byLanguage: Record<ExecutionLanguage, {
    count: number;
    avgTime: number;
  }>;
}
