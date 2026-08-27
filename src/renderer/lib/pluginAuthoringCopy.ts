/**
 * The words shown when someone is deciding whether agents may write and run
 * code in this app.
 *
 * Shared because the decision is now offered in two places — Settings →
 * Advanced, and inline in the Workshop where a non-technical user actually
 * meets it — and two copies of a warning drift until one of them is wrong.
 */

export const PLUGIN_AUTHORING_TITLE = 'Let agents build plugins';

export const PLUGIN_AUTHORING_EXPLAINER =
  'When ON, an agent working in the Workshop can stage a plugin and run it. ' +
  'Staged plugins are not installed — they never appear in the sidebar, and they ' +
  'disappear when you discard them or restart Eaves. Writing and activating each ' +
  'ask for your approval, and keeping one asks again.';

export const PLUGIN_AUTHORING_WARNING_TITLE = '⚠️ Agents can run code they wrote';

export const PLUGIN_AUTHORING_WARNING =
  'An activated plugin runs in a sandbox worker with the permissions its own manifest ' +
  'asks for — the same trust you would extend to a shell. Read what you are approving: ' +
  'the permission list is the whole of what it can reach. A prompt injection in any ' +
  'agent interaction could try to walk you through approving one.';
