/**
 * Deferred tools — declared at the definition site, kept off the wire.
 *
 * Tool schemas are resent on every step of every turn, so a tool that is
 * expensive to describe and rarely called is a standing tax on every request
 * — measured at ~7,400 tokens of tool schema per request against a 151-token
 * system prompt, i.e. ~88% of each step's input. A deferred tool is still registered with
 * the SDK and still listed by `list_tools`; it is simply not put in front of
 * the model until something enables it — after which `prepareStep` picks it up
 * on the very next step, so enable→use costs one step, not one user turn.
 *
 * Defer a tool when both are true: its schema is large, and the turns that need
 * it are a small and *deliberate* minority (authoring a workflow, editing a
 * routine). Do not defer cheap tools, and do not defer anything on a common
 * read path — the discovery round trip costs more than the schema does, and
 * cheap models are the worst at the list→enable→use dance.
 *
 * The marker is a symbol so it cannot leak into a JSON-serialized tool
 * definition or show up in `Object.keys`.
 */

const DEFERRED = Symbol.for('enclave.deferredTool');

/** Mark a tool as deferred. Returns the same object, for use inline at definition. */
export function deferTool<T extends object>(toolDef: T): T {
  (toolDef as Record<symbol, unknown>)[DEFERRED] = true;
  return toolDef;
}

export function isDeferredTool(toolDef: unknown): boolean {
  return (
    typeof toolDef === 'object' &&
    toolDef !== null &&
    (toolDef as Record<symbol, unknown>)[DEFERRED] === true
  );
}
