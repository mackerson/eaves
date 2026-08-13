/**
 * Main-process handlers are wrapped in `ipcResult`, and `validateIPC` *returns*
 * `{ success: false, error }` rather than throwing. Both mean the same thing:
 * an IPC call that failed never rejects — it resolves with a failure envelope.
 *
 * So `await window.electron.doThing()` inside a try/catch catches nothing, and
 * code that reads a field off the result gets `undefined` and carries on as if
 * the call had worked. Pass results through here to turn the envelope back into
 * a throw the caller's catch can actually see.
 */

interface FailureEnvelope {
  success: false;
  error?: string;
}

export function isIpcFailure(result: unknown): result is FailureEnvelope {
  return (
    typeof result === 'object' &&
    result !== null &&
    'success' in result &&
    (result as { success?: unknown }).success === false
  );
}

/**
 * Return `result` unchanged, or throw if it is a failure envelope.
 * `context` names the operation for the message the user ends up seeing.
 */
export function unwrapIpc<T>(result: T, context: string): T {
  if (isIpcFailure(result)) {
    throw new Error(result.error ? `${context}: ${result.error}` : `${context} failed`);
  }
  return result;
}
