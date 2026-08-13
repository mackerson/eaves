import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which project a tool call belongs to.
 *
 * Built-in tools used to answer that question by reading
 * `settings.current_project_id` — the project the *user interface* has
 * selected, at the moment the tool happens to run. That is only correct for a
 * chat, where the turn's project is the selected one by construction. A channel
 * turn resolves its project as `channel.projectId || currentState.projectId`
 * (ChannelDispatcher.resolveTurnContext), so an agent answering an @mention in
 * a channel belonging to project A would read files, add tasks and create
 * routines in project B if that was what happened to be on screen. Unattended
 * routine turns inherited whatever the UI last had selected.
 *
 * So the turn states its project explicitly, and the tools ask for that instead.
 * `buildToolset` wraps every built-in and agent-scoped tool's `execute` in the
 * scope of the turn's project, which means the binding also covers the approval
 * resume path — that path rebuilds its toolset through `buildToolset` too.
 *
 * Async-local rather than a module variable because turns overlap: several
 * channel dispatches and chat streams can be in flight at once, and a single
 * mutable "current project" would be read by whichever tool call landed last.
 *
 * Callers outside a turn (there are none today that run these tools, but the
 * fallback matters for future ones) still get the UI selection. That is the old
 * behaviour, kept only as a floor.
 */
const scope = new AsyncLocalStorage<{ projectId: string }>();

/** Run `fn` — and everything it awaits — attributed to `projectId`. */
export function runInProjectScope<T>(projectId: string, fn: () => T): T {
  return scope.run({ projectId }, fn);
}

/** The turn's project, or null when running outside one. */
export function scopedProjectId(): string | null {
  return scope.getStore()?.projectId ?? null;
}

/**
 * Wrap each tool's `execute` so it runs inside `projectId`'s scope.
 *
 * Copies rather than mutates: these tool objects are module-level singletons
 * (`builtinTools`), so binding in place would attribute every agent in the
 * process to the last project that built a toolset.
 */
export function bindProjectScope<T extends Record<string, unknown>>(
  tools: T,
  projectId: string,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const def = definition as { execute?: (...args: unknown[]) => unknown };
    if (typeof def?.execute !== 'function') {
      bound[name] = definition;
      continue;
    }
    const execute = def.execute.bind(def);
    bound[name] = {
      ...def,
      execute: (...args: unknown[]) => runInProjectScope(projectId, () => execute(...args)),
    };
  }
  return bound;
}
