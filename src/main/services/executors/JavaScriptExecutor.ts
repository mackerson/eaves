import { BaseExecutor } from './BaseExecutor';

/**
 * Executes JavaScript code in isolated Node.js subprocess
 */
export class JavaScriptExecutor extends BaseExecutor {
  protected language = 'JavaScript';

  protected getFileExtension(): string {
    return 'js';
  }

  protected getCommand(scriptPath: string): { command: string; args: string[] } {
    return {
      command: 'node',
      args: [scriptPath],
    };
  }

  protected wrapCode(userCode: string, context?: Record<string, any>): string {
    // Serialize context safely for injection
    const contextJson = context ? JSON.stringify(context, null, 2) : '{}';

    return `
// Eaves Code Execution Wrapper
(async () => {
  try {
    // Workflow context injected from previous nodes
    const context = ${contextJson};
    const data = context;
    const input = context;

    // User code
    const userFunction = async () => {
      ${userCode}
    };

    const result = await userFunction();

    // Output return value with markers for parsing
    if (result !== undefined) {
      console.log('<<<EAVES_RETURN>>>');
      console.log(JSON.stringify(result));
      console.log('<<<EAVES_RETURN_END>>>');
    }

    process.exit(0);
  } catch (error) {
    console.error('Execution error:', error.message || String(error));
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
})();
`.trim();
  }
}
