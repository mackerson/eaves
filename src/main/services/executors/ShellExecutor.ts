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
    // Stock Windows has no usable `bash` — probe the common Git-for-Windows
    // locations and fail with an actionable message instead of a bare
    // `spawn bash ENOENT`.
    //
    // Git Bash is tried *before* a bare `bash` deliberately. System32 is on
    // every Windows PATH, and the bash.exe it holds is the WSL launcher, which
    // cannot run a script addressed by a Windows path. Resolution rejects that
    // one outright (see BaseExecutor.resolveExecutable), so a bare `bash` stays
    // last as the way to find a Git Bash installed somewhere non-standard.
    const candidates =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\Git\\bin\\bash.exe',
            'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
            'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
            'bash',
          ]
        : ['bash'];

    const bash = this.resolveExecutable(candidates);
    if (!bash) {
      throw new Error(
        process.platform === 'win32'
          ? 'bash was not found. Install Git for Windows (which bundles bash), then restart Eaves. ' +
            'WSL does not work here: it cannot read a Windows script path.'
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
