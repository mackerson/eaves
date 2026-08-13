/**
 * Terminal Manager
 * Manages pseudoterminal (PTY) processes for embedded terminal views
 */

import * as pty from '@lydell/node-pty';
import { BrowserWindow } from 'electron';
import os from 'os';
import { logger } from './logger';

export interface TerminalOptions {
  cwd?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface TerminalSession {
  id: string;
  ptyProcess: pty.IPty;
  cwd: string;
  command: string;
}

class TerminalManagerClass {
  private terminals: Map<string, TerminalSession> = new Map();
  private getWindow: () => BrowserWindow | null = () => null;

  /**
   * Point the manager at the current main window.
   *
   * Takes an accessor rather than the window itself — the same shape
   * TrayManager and the updater already use. A pinned `BrowserWindow` went
   * stale the moment the window was destroyed: `main.ts` nulls its reference
   * on 'closed' and `app.on('activate')` builds a *new* window, but nothing
   * re-initialized this, so it kept a handle on the dead one. `sendToRenderer`
   * guards on isDestroyed(), so every byte of PTY output was silently dropped
   * instead of erroring — the reopened terminal rendered as a permanently
   * blank, unresponsive pane.
   */
  initialize(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow;
    logger.info('[TerminalManager] Initialized');
  }

  /**
   * Create a new terminal session. Returns the directory the shell was
   * actually started in — `options.cwd` is only a request, and it falls back
   * to the home directory when absent, which the caller has no other way to
   * learn.
   */
  createTerminal(id: string, options: TerminalOptions = {}): string {
    const existing = this.terminals.get(id);
    if (existing) {
      logger.warn(`[TerminalManager] Terminal ${id} already exists`);
      return existing.cwd;
    }

    const shell = options.command || this.getDefaultShell();
    const cwd = options.cwd || os.homedir();
    let args = options.args || [];

    // Preserve full environment and only override with custom env vars
    const env: Record<string, string> = {
      ...process.env,  // Start with full process.env
      ...Object.entries(options.env || {})
        .filter(([_, value]) => value !== undefined)
        .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})
    } as Record<string, string>;

    // Ensure critical environment variables exist
    const requiredEnvVars = ['HOME', 'PATH', 'USER', 'SHELL'];
    const missingVars = requiredEnvVars.filter(v => !env[v]);
    if (missingVars.length > 0) {
      logger.warn(`[TerminalManager] Missing environment variables: ${missingVars.join(', ')}`);
      env.HOME = env.HOME || os.homedir();
      env.USER = env.USER || os.userInfo().username;
      env.SHELL = env.SHELL || shell;
      env.PATH = env.PATH || (process.env.PATH as string) || '/usr/local/bin:/usr/bin:/bin';
    }

    // For zsh/bash, force interactive mode if no args provided
    if ((shell.includes('zsh') || shell.includes('bash')) && args.length === 0) {
      args = ['-i'];  // Force interactive mode to prevent early exit
    }

    logger.info(`[TerminalManager] Creating terminal ${id}`, {
      shell,
      cwd,
      args,
    });

    try {
      const ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: options.cols || 80,
        rows: options.rows || 24,
        cwd,
        env,
      });

      // Forward PTY output to renderer
      ptyProcess.onData((data) => {
        this.sendToRenderer(`terminal:data:${id}`, data);
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info(`[TerminalManager] Terminal ${id} exited`, { exitCode, signal });
        this.sendToRenderer(`terminal:exit:${id}`, { exitCode, signal });
        this.terminals.delete(id);
      });

      this.terminals.set(id, {
        id,
        ptyProcess,
        cwd,
        command: shell,
      });

      logger.info(`[TerminalManager] Terminal ${id} created successfully`);
      return cwd;
    } catch (error) {
      logger.error(`[TerminalManager] Failed to create terminal ${id}`, error);
      throw error;
    }
  }

  /**
   * Write data to a terminal
   */
  writeToTerminal(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      logger.warn(`[TerminalManager] Terminal ${id} not found`);
      return;
    }

    terminal.ptyProcess.write(data);
  }

  /**
   * Resize a terminal
   */
  resizeTerminal(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      logger.warn(`[TerminalManager] Terminal ${id} not found`);
      return;
    }

    terminal.ptyProcess.resize(cols, rows);
    logger.info(`[TerminalManager] Terminal ${id} resized to ${cols}x${rows}`);
  }

  /**
   * Destroy a terminal session
   */
  destroyTerminal(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      logger.warn(`[TerminalManager] Terminal ${id} not found`);
      return;
    }

    logger.info(`[TerminalManager] Destroying terminal ${id}`);
    terminal.ptyProcess.kill();
    this.terminals.delete(id);
  }

  /**
   * Get all active terminal sessions
   */
  getTerminals(): TerminalSession[] {
    return Array.from(this.terminals.values());
  }

  /**
   * Kill every PTY. Safe to call repeatedly.
   *
   * A PTY outlives the renderer that owns it, and its id only ever existed in
   * that renderer's memory — so once the window is gone the session is
   * unreachable by anything, including the next window. Nothing kills these
   * except this method, which is why closing the window used to orphan the
   * shell child (holding its cwd and any running command) for the lifetime of
   * the app.
   *
   * `kill()` is best-effort per terminal: one PTY that refuses to die must not
   * strand the rest, which matters most on the quit path.
   */
  cleanup(): void {
    if (this.terminals.size === 0) return;
    logger.info(`[TerminalManager] Cleaning up ${this.terminals.size} terminal(s)`);
    for (const [id, terminal] of this.terminals.entries()) {
      try {
        terminal.ptyProcess.kill();
      } catch (error) {
        logger.warn(`[TerminalManager] Failed to kill terminal ${id}`, error);
      }
      this.terminals.delete(id);
    }
  }

  /**
   * Get the default shell for the current platform
   */
  private getDefaultShell(): string {
    const platform = os.platform();

    if (platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }

    // Unix-like systems
    return process.env.SHELL || '/bin/bash';
  }

  /**
   * Send data to renderer process
   */
  private sendToRenderer(channel: string, data: any): void {
    const window = this.getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, data);
    }
  }
}

let _terminalManagerInstance: TerminalManagerClass | null = null;
export function getTerminalManager(): TerminalManagerClass {
  if (!_terminalManagerInstance) _terminalManagerInstance = new TerminalManagerClass();
  return _terminalManagerInstance;
}
export const TerminalManager = getTerminalManager();
