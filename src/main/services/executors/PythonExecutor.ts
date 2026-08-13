import { BaseExecutor } from './BaseExecutor';

/**
 * Executes Python code in isolated Python subprocess
 */
export class PythonExecutor extends BaseExecutor {
  protected language = 'Python';

  protected getFileExtension(): string {
    return 'py';
  }

  protected getCommand(scriptPath: string): { command: string; args: string[] } {
    // Hardcoding `python3` fails on Windows, where a real install exposes
    // `python`/`py` and the bare `python3` name resolves to the Microsoft
    // Store alias stub (skipped by resolveExecutable). Probe real interpreters
    // and fail with an actionable message instead of the stub's cryptic
    // "Python was not found" stderr.
    const candidates =
      process.platform === 'win32'
        ? ['python', 'python3', 'py']
        : ['python3', 'python'];

    const python = this.resolveExecutable(candidates);
    if (!python) {
      throw new Error(
        'Python was not found. Install Python 3 and ensure it is on your PATH, then restart Enclave.'
      );
    }

    return {
      command: python,
      args: ['-u', scriptPath], // -u for unbuffered output
    };
  }

  protected createEnvironment(options: any): Record<string, string> {
    return {
      ...super.createEnvironment(options),
      PYTHONUNBUFFERED: '1',
    };
  }

  protected wrapCode(userCode: string, context?: Record<string, any>): string {
    // Serialize context safely - escape single quotes for Python string
    const contextJson = context
      ? JSON.stringify(context, null, 2).replace(/'/g, "\\'")
      : '{}';

    return `
import json
import sys
import traceback

def main():
    try:
        # Workflow context injected from previous nodes
        context = json.loads('''${contextJson}''')

        # User code
${this.indentCode(userCode, 8)}

        # If user code returns a value, it will be available here
        # For now, we just execute it

    except Exception as e:
        print(f"Execution error: {str(e)}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`.trim();
  }

  /**
   * Indent code by specified number of spaces
   */
  private indentCode(code: string, spaces: number): string {
    const indent = ' '.repeat(spaces);
    return code.split('\n').map(line => indent + line).join('\n');
  }
}
