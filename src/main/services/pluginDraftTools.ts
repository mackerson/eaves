import { tool } from 'ai';
import { z } from 'zod/v3';
import { PluginManifestSchema } from '../../shared/validation';
import { describePluginApi } from './pluginApiCatalog';
import {
  writeDraft,
  listDrafts,
  readDraft,
  PluginDraftError,
  type DraftRecord,
} from './pluginDraftService';
import { getSandboxedPluginManager } from './sandbox';
import { logger } from './logger';

/**
 * The plugin-authoring toolset: four verbs over the draft tier.
 *
 * Four rather than forty is the whole design. The alternative — a tool per
 * capability (`register_tool`, `register_view`, `register_command`, …) — grows
 * without bound as extension points are added, and still needs the same
 * validation, just one step earlier. One primitive whose vocabulary is "a
 * plugin" covers every capability the plugin system will ever have, and what
 * the agent writes is exactly what `plugin_inspect` reads back.
 *
 * Registered only when `pluginAuthoringEnabled` is on. An activated draft is
 * agent-written code in a real worker under real permission grants — the same
 * trust you extend to a bash tool — so the two verbs with effects also ask for
 * per-call approval.
 */

const failure = (error: unknown) => {
  if (error instanceof PluginDraftError) return { success: false as const, error: error.message };
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('[PluginDraftTools] Refused', { error: message });
  return { success: false as const, error: message };
};

const describeDraft = (draft: DraftRecord) => ({
  id: draft.id,
  name: draft.name,
  version: draft.version,
  type: draft.type,
  permissions: draft.permissions,
  files: draft.files,
  running: draft.running,
  bundleUrl: draft.bundleUrl,
});

export function createPluginDraftTools() {
  return {
    plugin_inspect: tool({
      description:
        'Read the plugin system: the API a plugin can call and what each call requires, ' +
        'the plugins currently loaded, and the drafts you have staged. ' +
        'Call this before writing a plugin — it is cheaper than guessing at method names and permissions.',
      inputSchema: z.object({
        what: z
          .enum(['api', 'plugins', 'drafts', 'all'])
          .default('all')
          .describe(
            'api = callable surface and the grant each call needs, plus the entry and UI file shapes. ' +
            'plugins = what is loaded right now. drafts = what you have staged. all = everything.',
          ),
      }),
      execute: async ({ what }) => {
        try {
          const wants = (section: string) => what === 'all' || what === section;
          const manager = getSandboxedPluginManager();

          return {
            success: true,
            api: wants('api') ? describePluginApi() : undefined,
            loadedPlugins: wants('plugins')
              ? manager.getLoadedPluginIds().map(id => {
                  const manifest = manager.getPluginManifest(id);
                  return { id, name: manifest?.name, type: manifest?.type, source: manifest?.source };
                })
              : undefined,
            drafts: wants('drafts') ? listDrafts().map(describeDraft) : undefined,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    plugin_define: tool({
      description:
        'Stage a plugin to disk. Nothing runs — this writes the manifest and its files and stops, ' +
        'so a definition can be reviewed before it executes. Call plugin_activate to run it. ' +
        'Redefining a running draft is refused: retract it first. ' +
        'Read plugin_inspect with what:"api" for the entry and UI file shapes before your first call.',
      inputSchema: z.object({
        manifest: PluginManifestSchema.describe(
          'The plugin.json. Declare only the permissions you actually call.',
        ),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe('Relative to the plugin directory, forward slashes, e.g. "ui/index.js".'),
              content: z.string().describe('The file, verbatim. Text only.'),
            }),
          )
          .min(1)
          .describe(
            'Every file the plugin needs except plugin.json, which is written from the manifest. ' +
            'Must include the entry file, and the UI bundle if the manifest declares one.',
          ),
      }),
      needsApproval: true,
      execute: async ({ manifest, files }) => {
        try {
          const record = writeDraft({ manifest, files });
          return {
            success: true,
            draft: describeDraft(record),
            note:
              'Staged, not running. Call plugin_activate with this id to run it. ' +
              'It is not installed: it disappears on retract or on restart.',
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    plugin_activate: tool({
      description:
        'Run a staged draft in a sandboxed worker with the permissions its manifest declares. ' +
        'Re-activating a draft reloads it. Tools it registers become available on your NEXT turn, ' +
        'not this one — the toolset is assembled once per turn.',
      inputSchema: z.object({
        id: z.string().min(1).describe('The plugin id from plugin_define.'),
      }),
      needsApproval: true,
      execute: async ({ id }) => {
        try {
          const staged = readDraft(id);
          if (!staged) {
            return {
              success: false,
              error: `No draft with id "${id}". Call plugin_inspect with what:"drafts" to see what is staged.`,
            };
          }

          const manager = getSandboxedPluginManager();
          const before = new Set(Object.keys(manager.getRegisteredTools()));
          const manifest = await manager.loadDraftPlugin(staged.record.folderName);
          const registered = Object.keys(manager.getRegisteredTools()).filter(name => !before.has(name));

          return {
            success: true,
            id: manifest.id,
            registeredTools: registered,
            note: registered.length
              ? `Running. ${registered.join(', ')} become callable on your next turn.`
              : 'Running. It registered no tools.',
            viewNote: manifest.ui
              ? 'Its view is not shown in the sidebar: a draft UI does not share a window with the dialog that would approve it.'
              : undefined,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    plugin_retract: tool({
      description:
        'Stop a draft and delete it from disk. Always available — this is how you undo a define ' +
        'or an activate. Refuses anything that is not a draft.',
      inputSchema: z.object({
        id: z.string().min(1).describe('The plugin id to retract.'),
      }),
      execute: async ({ id }) => {
        try {
          await getSandboxedPluginManager().removeDraftPlugin(id);
          return { success: true, id, note: 'Stopped and deleted.' };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}
