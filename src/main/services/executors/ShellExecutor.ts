import { BaseExecutor } from './BaseExecutor';
import { ExecutorOptions } from '../../types/code-execution';

/**
 * Executes shell scripts in isolated subprocess
 * Security: Runs with restricted environment
 */
export class ShellExecutor extends BaseExecutor {
  protected language = 'Shell';

  protected getFileExtension(): string {
    return 'sh';
  }

  protected getCommand(scriptPath: string): { command: string; args: string[] } {
    // stock Windows has no `bash` on PATH — probe the common Git-for-Windows
    // and WSL locations before giving up, and fail with an actionable message
    // instead of a bare `spawn bash ENOENT`.
    const candidates =
      process.platform === 'win32'
        ? [
            'bash',
            'C:\\Program Files\\Git\\bin\\bash.exe',
            'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
            'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
          ]
        : ['bash'];

    const bash = this.resolveExecutable(candidates);
    if (!bash) {
      throw new Error(
        process.platform === 'win32'
          ? 'bash was not found. Install Git for Windows (which bundles bash) or WSL, then restart Eaves.'
          : 'bash was not found on PATH.'
      );
    }

    return {
      command: bash,
      args: [scriptPath],
    };
  }

  protected createEnvironment(options: ExecutorOptions): Record<string, string> {
    return this.createRestrictedEnvironment(options);
  }

  /**
   * Create a restricted environment for security
   * Limits access to sensitive env vars
   */
  private createRestrictedEnvironment(options: ExecutorOptions): Record<string, string> {
    const allowedVars = [
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'LANG',
      'LC_ALL',
    ];

    const restrictedEnv: Record<string, string> = {};

    // Only include allowed environment variables
    for (const key of allowedVars) {
      if (process.env[key]) {
        restrictedEnv[key] = process.env[key] as string;
      }
    }

    // Add custom env from options
    if (options.env) {
      Object.assign(restrictedEnv, options.env);
    }

    return restrictedEnv;
  }
}
