import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ExecutionResult, ExecutorOptions, ExecutionArtifact } from '../../types/code-execution';
import { logger } from '../logger';

/** Max stdout/stderr bytes captured per stream before truncation. */
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;

/**
 * Env var names that carry secrets, stripped from code-execution child
 * environments. Matches provider keys (`*_API_KEY`), tokens (`*_TOKEN`, incl.
 * AWS/GitHub), passwords, credentials, and private keys anywhere in the name.
 */
const SECRET_ENV_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i;

/**
 * Abstract base class for code executors
 * Provides common functionality for subprocess-based code execution
 */
export abstract class BaseExecutor {
  protected abstract language: string;

  protected abstract getCommand(scriptPath: string): { command: string; args: string[] };

  protected wrapCode(code: string, _context?: Record<string, any>): string {
    return code;
  }

  protected abstract getFileExtension(): string;

  /**
   * Resolve the first candidate executable that actually exists, searching
   * PATH (and PATHEXT on Windows). Returns an absolute path, or null if none
   * resolve. On Windows, entries under `WindowsApps` are skipped: those are
   * the Microsoft Store app-execution-alias stubs (e.g. the `python`/`python3`
   * aliases that just print "Python was not found") — spawning them never runs
   * a real interpreter, it only produces a confusing failure.
   */
  protected resolveExecutable(candidates: string[]): string | null {
    const isWin = process.platform === 'win32';
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = isWin
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

    const usable = (full: string): boolean => {
      if (!existsSync(full)) return false;
      if (isWin && /\\WindowsApps\\/i.test(full)) return false;
      return true;
    };

    for (const candidate of candidates) {
      // Explicit path (absolute or relative) — use as given.
      if (candidate.includes('/') || candidate.includes('\\')) {
        if (usable(candidate)) return candidate;
        continue;
      }
      for (const dir of pathDirs) {
        for (const ext of exts) {
          const full = path.join(dir, path.extname(candidate) ? candidate : candidate + ext);
          if (usable(full)) return full;
        }
      }
    }
    return null;
  }

  protected createEnvironment(options: ExecutorOptions): Record<string, string> {
    // Strip secret-bearing vars from the child env. execute_code runs real
    // node/python as the user, so without this an agent-generated script could
    // read provider API keys / tokens / credentials straight out of process.env
    // and exfiltrate them over the (unrestricted) network. Everything else —
    // PATH, HOME, SystemRoot, locale — is preserved so scripts still run.
    // (Shell overrides this with a stricter allowlist.)
    const scrubbed: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (SECRET_ENV_PATTERN.test(key)) continue;
      scrubbed[key] = value;
    }
    return {
      ...scrubbed,
      ...options.env,
    };
  }

  /**
   * Execute code in isolated subprocess
   * Template method - implements common flow, delegates specifics to subclasses
   */
  async executeCode(
    code: string,
    options: ExecutorOptions
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    // The *ephemeral* directory that holds the generated script — always a
    // fresh temp dir, never the user's working directory. Only this is ever
    // cleaned up, so it must never be options.workingDirectory: cleanup would
    // then `rm -rf` the user's project folder after every bash call.
    let scriptDir = '';

    try {
      const wrappedCode = this.wrapCode(code, options.context);
      const { scriptPath, scriptDir: sd, cwd } = await this.prepareEnvironment(
        wrappedCode,
        this.getFileExtension(),
        options
      );
      scriptDir = sd;

      const result = await this.runProcess(scriptPath, cwd, options);
      const executionTime = Date.now() - startTime;

      const execResult = await this.createResult(
        result.exitCode === 0,
        result.stdout,
        result.stderr,
        result.exitCode,
        executionTime,
        scriptDir,
        result.error
      );

      await this.cleanup(scriptDir);

      return execResult;
    } catch (error: any) {
      const executionTime = Date.now() - startTime;

      if (scriptDir) {
        await this.cleanup(scriptDir);
      }

      return {
        success: false,
        stdout: '',
        stderr: error.message || String(error),
        exitCode: 1,
        executionTime,
        error: error.message || String(error),
      };
    }
  }

  protected runProcess(
    scriptPath: string,
    cwd: string,
    options: ExecutorOptions
  ): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }> {
    return new Promise((resolve) => {
      const { command, args } = this.getCommand(scriptPath);

      logger.info(`[${this.language}Executor] Executing: ${command} ${args.join(' ')}`);

      // Note: no `timeout` option here — we manage the timeout manually below so
      // we can set `timedOut` before killing (and kill the whole process tree).
      // Node's built-in timeout races that and can close the child first,
      // dropping the 124/timeout signal.
      const child = spawn(command, args, {
        cwd,
        env: this.createEnvironment(options),
        // Own process group (POSIX) so a timeout can kill the whole tree. Without
        // this, killing the shell orphans its children (e.g. `sleep`), which keep
        // the stdio pipes open and the 'close' event never fires.
        detached: process.platform !== 'win32',
      });

      // Cap captured output. A misfire (e.g. `bash` falling through to
      // PowerShell on Windows and erroring once per token) can spew tens of MB
      // of stderr; without a cap it's all held in memory and persisted into the
      // message + activity feed. This is display/telemetry, not a data channel.
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;

      child.stdout.on('data', (data) => {
        if (stdoutTruncated) return;
        stdout += data.toString();
        if (stdout.length > MAX_CAPTURED_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_CAPTURED_OUTPUT_BYTES) + '\n…[output truncated]';
          stdoutTruncated = true;
        }
      });

      child.stderr.on('data', (data) => {
        if (stderrTruncated) return;
        stderr += data.toString();
        if (stderr.length > MAX_CAPTURED_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_CAPTURED_OUTPUT_BYTES) + '\n…[output truncated]';
          stderrTruncated = true;
        }
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        // child.kill('SIGTERM') doesn't reap the child's descendants on Windows
        // (SIGTERM is emulated and doesn't cascade), so a shell that spawned a
        // runaway PowerShell survives its own timeout. Kill the whole tree.
        this.killProcessTree(child);
      }, options.timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);

        if (timedOut) {
          resolve({
            stdout,
            stderr: stderr + '\nExecution timed out',
            exitCode: 124,
            error: `Execution exceeded timeout of ${options.timeout}ms`,
          });
        } else {
          // A non-zero exit with no thrown error must still carry an `error`
          // string — otherwise downstream (CodeExecutor) collapses it to the
          // useless literal "Unknown error" and drops the exit code entirely.
          const exitCode = code ?? 0;
          const firstStderrLine = stderr
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean);
          resolve({
            stdout,
            stderr,
            exitCode,
            error:
              exitCode !== 0
                ? `Process exited with code ${exitCode}${firstStderrLine ? `: ${firstStderrLine}` : ''}`
                : undefined,
          });
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        resolve({
          stdout,
          stderr: stderr + '\n' + error.message,
          exitCode: 1,
          error: error.message,
        });
      });
    });
  }

  /**
   * Kill a child process and all its descendants. On Windows `child.kill()`
   * only signals the immediate process, orphaning any tree it spawned (e.g. a
   * shell → PowerShell), so use `taskkill /T /F`. On POSIX, SIGTERM then a
   * SIGKILL backstop.
   */
  protected killProcessTree(child: ReturnType<typeof spawn>): void {
    const pid = child.pid;
    if (!pid) {
      child.kill('SIGKILL');
      return;
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
        return;
      } catch {
        child.kill('SIGKILL');
        return;
      }
    }
    // POSIX: the child leads its own process group (spawned detached), so a
    // negative pid signals the whole group — the shell and everything it spawned.
    try {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1000);
    } catch {
      child.kill('SIGKILL');
    }
  }

  protected async prepareEnvironment(
    code: string,
    extension: string,
    options: ExecutorOptions
  ): Promise<{ scriptPath: string; scriptDir: string; cwd: string }> {
    const executionId = randomUUID();
    // The script always lives in its own throwaway temp dir — this is what gets
    // deleted on cleanup. The *cwd* the process runs in is a separate concern:
    // the caller's workingDirectory (e.g. the project folder for the bash tool)
    // when provided, else the throwaway dir. This keeps cleanup from ever
    // touching, and the script file from ever landing in, the user's folder.
    const scriptDir = path.join(os.tmpdir(), `eaves-exec-${executionId}`);
    const cwd = options.workingDirectory?.trim() ? options.workingDirectory : scriptDir;

    try {
      await fs.mkdir(scriptDir, { recursive: true });
      logger.info(`[${this.language}Executor] Created script directory:`, scriptDir);

      const scriptPath = path.join(scriptDir, `script.${extension}`);
      await fs.writeFile(scriptPath, code, 'utf8');
      logger.info(`[${this.language}Executor] Wrote script to:`, scriptPath, 'cwd:', cwd);

      return { scriptPath, scriptDir, cwd };
    } catch (error) {
      logger.error(`[${this.language}Executor] Failed to prepare environment:`, error);
      throw new Error(`Failed to prepare execution environment: ${error}`);
    }
  }

  protected async writeContext(
    workDir: string,
    context?: Record<string, any>
  ): Promise<string | null> {
    if (!context || Object.keys(context).length === 0) {
      return null;
    }

    try {
      const contextPath = path.join(workDir, 'context.json');
      await fs.writeFile(contextPath, JSON.stringify(context, null, 2), 'utf8');
      logger.info(`[${this.language}Executor] Wrote context to:`, contextPath);
      return contextPath;
    } catch (error) {
      logger.warn(`[${this.language}Executor] Failed to write context:`, error);
      return null;
    }
  }

  protected async discoverArtifacts(
    workDir: string,
    excludeFiles: string[] = ['script.js', 'script.py', 'context.json']
  ): Promise<ExecutionArtifact[]> {
    try {
      const files = await fs.readdir(workDir);
      const artifacts: ExecutionArtifact[] = [];

      for (const file of files) {
        if (excludeFiles.includes(file)) {
          continue;
        }

        const filePath = path.join(workDir, file);
        const stats = await fs.stat(filePath);

        if (!stats.isFile()) {
          continue;
        }

        const artifact: ExecutionArtifact = {
          name: file,
          path: filePath,
          size: stats.size,
        };

        // Read small text files
        if (stats.size < 1024 * 100 && this.isTextFile(file)) {
          try {
            artifact.content = await fs.readFile(filePath, 'utf8');
          } catch (error) {
            logger.warn(`[${this.language}Executor] Could not read artifact ${file}:`, error);
          }
        }

        artifacts.push(artifact);
      }

      return artifacts;
    } catch (error) {
      logger.warn(`[${this.language}Executor] Failed to discover artifacts:`, error);
      return [];
    }
  }

  private isTextFile(filename: string): boolean {
    const textExtensions = [
      '.txt', '.json', '.csv', '.md', '.log',
      '.js', '.ts', '.py', '.sh', '.html', '.css',
      '.xml', '.yaml', '.yml', '.toml'
    ];
    const ext = path.extname(filename).toLowerCase();
    return textExtensions.includes(ext);
  }

  protected async cleanup(workDir: string): Promise<void> {
    // Defense in depth: only ever recursively delete inside the OS temp root.
    // Callers pass the ephemeral scriptDir, but this guard guarantees a stray
    // path (a project folder, home dir) can never be `rm -rf`'d.
    const tmpRoot = path.resolve(os.tmpdir());
    const target = path.resolve(workDir);
    if (target === tmpRoot || !target.startsWith(tmpRoot + path.sep)) {
      logger.warn(`[${this.language}Executor] Refusing to clean up non-temp path:`, target);
      return;
    }
    try {
      await fs.rm(workDir, { recursive: true, force: true });
      logger.info(`[${this.language}Executor] Cleaned up:`, workDir);
    } catch (error) {
      logger.warn(`[${this.language}Executor] Cleanup failed:`, error);
    }
  }

  protected parseReturnValue(stdout: string): any {
    try {
      // Look for JSON output between markers
      const returnMarker = '<<<EAVES_RETURN>>>';
      const endMarker = '<<<EAVES_RETURN_END>>>';

      const startIdx = stdout.indexOf(returnMarker);
      if (startIdx === -1) {
        return undefined;
      }

      const endIdx = stdout.indexOf(endMarker, startIdx);
      if (endIdx === -1) {
        return undefined;
      }

      const jsonStr = stdout.substring(
        startIdx + returnMarker.length,
        endIdx
      ).trim();

      return JSON.parse(jsonStr);
    } catch (error) {
      logger.warn(`[${this.language}Executor] Failed to parse return value:`, error);
      return undefined;
    }
  }

  protected cleanOutput(stdout: string): string {
    return stdout
      .replace(/<<<EAVES_RETURN>>>[\s\S]*?<<<EAVES_RETURN_END>>>/g, '')
      .trim();
  }

  protected async createResult(
    success: boolean,
    stdout: string,
    stderr: string,
    exitCode: number,
    executionTime: number,
    workDir: string,
    error?: string
  ): Promise<ExecutionResult> {
    const artifacts = await this.discoverArtifacts(workDir);
    const returnValue = this.parseReturnValue(stdout);
    const cleanStdout = this.cleanOutput(stdout);

    return {
      success,
      stdout: cleanStdout,
      stderr,
      exitCode,
      executionTime,
      error,
      returnValue,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    };
  }
}
