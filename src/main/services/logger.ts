import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LoggerConfig {
  maxFileSize: number; // in bytes
  maxFiles: number;
  logToFile: boolean;
  logToConsole: boolean;
}

/**
 * Ceiling on one serialized argument.
 *
 * There was none, so a single object could write itself to disk without
 * limit — an AI SDK error carries the whole outgoing request, and one failed
 * turn wrote 22 KB across 538 lines including the system prompt and every
 * message. Call sites should summarize before logging (see
 * summarizeProviderError); this is the backstop for the ones that don't, and
 * for the ones nobody has written yet.
 */
const MAX_ARG_CHARS = 4000;

/** Cut with a marker rather than silently — a log that lies about being
 *  complete is worse than one that admits it was cut. */
function truncate(text: string): string {
  if (text.length <= MAX_ARG_CHARS) return text;
  return `${text.slice(0, MAX_ARG_CHARS)}… [truncated, ${text.length} chars total]`;
}

/**
 * An Error's `message` and `stack` are non-enumerable, so `JSON.stringify`
 * renders one as `{}` — plus whatever own properties it happens to carry.
 *
 * A packaged build failing to load better-sqlite3 logged `{ reason, promise }`
 * and reached the log file as `{"reason":{"code":"ERR_DLOPEN_FAILED"}}`. The
 * code survived only because better-sqlite3 sets it directly; the sentence
 * naming the module and the ABI mismatch was gone. stdout had all of it, and
 * a packaged app's stdout goes nowhere — so the one artifact a user can send
 * back was the one with the reason removed.
 *
 * A replacer rather than a check at the top level, because an error is
 * usually nested inside a context object rather than passed on its own.
 */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    // `cause` is own-but-not-enumerable when set through the Error
    // constructor, so the spread below misses it. Read it explicitly — a
    // wrapped error's cause is usually the half that says what went wrong.
    const cause = (value as { cause?: unknown }).cause;
    return {
      // Own enumerable extras first (`code`, `errno`, provider payloads), so
      // the three fields that actually matter can't be shadowed by a subclass
      // that happens to assign its own enumerable `name` or `message`.
      ...value,
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(cause !== undefined ? { cause } : {}),
    };
  }
  return value;
}

/** Render log arguments to the single line that gets written to disk. */
export function formatLogArgs(...args: any[]): string {
  return args.map(arg => {
    if (arg instanceof Error) {
      return truncate(arg.stack || `${arg.name}: ${arg.message}`);
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return truncate(JSON.stringify(arg, errorReplacer, 2));
      } catch {
        return String(arg);
      }
    }
    return truncate(String(arg));
  }).join(' ');
}

class Logger {
  private level: LogLevel = LogLevel.INFO;
  private config: LoggerConfig = {
    maxFileSize: 10 * 1024 * 1024, // 10MB per file
    maxFiles: 5, // Keep 5 log files
    logToFile: true,
    logToConsole: true,
  };
  private logDir: string;
  private currentLogFile: string;

  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.ensureLogDir();
    this.currentLogFile = this.getCurrentLogPath();
    this.rotateIfNeeded();

    const envLevel = process.env.EAVES_LOG_LEVEL?.toUpperCase();
    if (envLevel) {
      switch (envLevel) {
        case 'DEBUG':
          this.level = LogLevel.DEBUG;
          break;
        case 'INFO':
          this.level = LogLevel.INFO;
          break;
        case 'WARN':
          this.level = LogLevel.WARN;
          break;
        case 'ERROR':
          this.level = LogLevel.ERROR;
          break;
        default:
          break;
      }
    }
  }

  private ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getCurrentLogPath(): string {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logDir, `eaves-${date}.log`);
  }

  private rotateIfNeeded() {
    if (!fs.existsSync(this.currentLogFile)) {
      return;
    }

    const stats = fs.statSync(this.currentLogFile);
    if (stats.size >= this.config.maxFileSize) {
      // Rename current log with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = path.join(this.logDir, `eaves-${timestamp}.log`);
      fs.renameSync(this.currentLogFile, rotatedPath);

      // Clean up old files
      this.cleanupOldLogs();

      // Update current log file path
      this.currentLogFile = this.getCurrentLogPath();
    }
  }

  private cleanupOldLogs() {
    const files = fs.readdirSync(this.logDir)
      .filter(f => f.startsWith('eaves-') && f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(this.logDir, f),
        mtime: fs.statSync(path.join(this.logDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime); // Sort by modified time, newest first

    // Keep only maxFiles, delete the rest
    files.slice(this.config.maxFiles).forEach(file => {
      fs.unlinkSync(file.path);
    });
  }

  private writeToFile(level: string, message: string) {
    if (!this.config.logToFile) return;

    try {
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] [${level}] ${message}\n`;

      fs.appendFileSync(this.currentLogFile, logLine);
      this.rotateIfNeeded();
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  private formatArgs(...args: any[]): string {
    return formatLogArgs(...args);
  }


  setLevel(level: LogLevel) {
    this.level = level;
  }

  setConfig(config: Partial<LoggerConfig>) {
    this.config = { ...this.config, ...config };
  }

  getLogDir(): string {
    return this.logDir;
  }

  getLogFiles(): string[] {
    return fs.readdirSync(this.logDir)
      .filter(f => f.startsWith('eaves-') && f.endsWith('.log'))
      .map(f => path.join(this.logDir, f));
  }

  clearLogs() {
    const files = this.getLogFiles();
    files.forEach(file => {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        console.error('Failed to delete log file:', file, error);
      }
    });
    this.currentLogFile = this.getCurrentLogPath();
  }

  debug(...args: any[]) {
    if (this.level <= LogLevel.DEBUG) {
      const message = this.formatArgs(...args);
      if (this.config.logToConsole) {
        try {
        } catch (error: any) {
          // Ignore EPIPE errors (broken pipe when stdout is closed)
          if (error?.code !== 'EPIPE') {
            throw error;
          }
        }
      }
      this.writeToFile('DEBUG', message);
    }
  }

  info(...args: any[]) {
    if (this.level <= LogLevel.INFO) {
      const message = this.formatArgs(...args);
      if (this.config.logToConsole) {
        try {
        } catch (error: any) {
          // Ignore EPIPE errors (broken pipe when stdout is closed)
          if (error?.code !== 'EPIPE') {
            throw error;
          }
        }
      }
      this.writeToFile('INFO', message);
    }
  }

  warn(...args: any[]) {
    if (this.level <= LogLevel.WARN) {
      const message = this.formatArgs(...args);
      if (this.config.logToConsole) {
        try {
        } catch (error: any) {
          // Ignore EPIPE errors (broken pipe when stdout is closed)
          if (error?.code !== 'EPIPE') {
            throw error;
          }
        }
      }
      this.writeToFile('WARN', message);
    }
  }

  error(...args: any[]) {
    if (this.level <= LogLevel.ERROR) {
      const message = this.formatArgs(...args);
      if (this.config.logToConsole) {
        try {
          console.error('[ERROR]', new Date().toISOString(), ...args);
        } catch (error: any) {
          // Ignore EPIPE errors (broken pipe when stdout is closed)
          if (error?.code !== 'EPIPE') {
            throw error;
          }
        }
      }
      this.writeToFile('ERROR', message);
    }
  }
}

let _loggerInstance: Logger | null = null;
export function getLogger(): Logger {
  if (!_loggerInstance) _loggerInstance = new Logger();
  return _loggerInstance;
}
export const logger = getLogger();
export { LogLevel };
