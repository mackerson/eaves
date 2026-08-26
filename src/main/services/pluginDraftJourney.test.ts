/**
 * The whole journey, end to end: a person asks for a thing on the bench, an
 * agent writes it, it runs, and keeping it puts a new view in the left-hand
 * menu.
 *
 * This drives the **real tool implementations** — the same `execute` bodies the
 * model's tool calls land in — rather than the service functions underneath
 * them, because the interesting failures live in that layer: a manifest shape
 * the schema rejects, a UI file the extension allowlist refuses, an id
 * collision, a permission the code needs and the manifest never declared.
 *
 * What it deliberately does not cover is the worker actually starting and
 * registering the view; that needs a real sandbox and belongs to the QA
 * harness (`.claude/skills/e2e-qa`), which drives this same plugin through
 * activate → preview → keep → sidebar in a live app.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PluginManifest } from '../../shared/types';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const managerMock = {
  getDraftPluginsDir: vi.fn<() => string>(),
  getUserPluginsDir: vi.fn<() => string>(),
  getPluginManifest: vi.fn<(id: string) => PluginManifest | null>(() => null),
  isPluginLoaded: vi.fn<(id: string) => boolean>(() => false),
  getDraftContributions: vi.fn(() => ({ tools: [], views: [] })),
  getRegisteredTools: vi.fn(() => ({})),
  getLoadedPluginIds: vi.fn(() => [] as string[]),
  loadDraftPlugin: vi.fn(async () => ({}) as PluginManifest),
  unloadPlugin: vi.fn(async () => {}),
  loadUserPlugin: vi.fn(async () => ({})),
};
vi.mock('./sandbox', () => ({ getSandboxedPluginManager: () => managerMock }));

const grantsMock = { set: vi.fn(), get: vi.fn(() => null), delete: vi.fn() };
vi.mock('../repositories', () => ({ getPluginGrantsRepository: () => grantsMock }));

const showPluginConsent = vi.fn(async () => true);
vi.mock('../windows/pluginConsentWindow', () => ({ showPluginConsent }));

import { createPluginDraftTools } from './pluginDraftTools';
import { promoteDraft, listDrafts } from './pluginDraftService';
import { resetRevisions } from './pluginDraftRevisions';

/** The plugin an agent writes when asked for "a snowglobe in the sidebar". */
const SNOWGLOBE = {
  manifest: {
    id: 'com.eaves.snowglobe',
    name: 'Snowglobe',
    version: '1.0.0',
    type: 'ui',
    description: 'A snowglobe you can shake.',
    entry: 'index.cjs',
    icon: '🔮',
    sandboxVersion: 1,
    permissions: ['ui:views:register'],
    ui: { entry: 'ui/index.js', components: { SnowglobePanel: 'named' } },
  },
  files: [
    {
      path: 'index.cjs',
      content:
        "module.exports = {\n" +
        "  async activate(context) {\n" +
        "    await context.ui.registerView({ id: 'snowglobe', title: 'Snowglobe', " +
        "icon: '\u{1F52E}', component: 'SnowglobePanel' });\n" +
        "  },\n" +
        "  async deactivate() {},\n" +
        "};\n",
    },
    {
      // Hand-written ES module: React is externalised by moduleShim, so a
      // draft UI needs no build step and is served exactly as written.
      path: 'ui/index.js',
      content:
        "import React from '/node_modules/react';\n" +
        "export function SnowglobePanel() {\n" +
        "  return React.createElement('div', null, 'Snowglobe');\n" +
        "}\n",
    },
  ],
};

let root: string;
let userRoot: string;
let tools: ReturnType<typeof createPluginDraftTools>;

// The AI SDK's tool() wraps execute; call it the way the runtime does.
const run = async (tool: any, input: unknown) => tool.execute(input, {} as never);

describe('the workbench journey: ask → written → running → kept', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-journey-drafts-'));
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-journey-user-'));
    managerMock.getDraftPluginsDir.mockReturnValue(root);
    managerMock.getUserPluginsDir.mockReturnValue(userRoot);
    managerMock.getPluginManifest.mockReturnValue(null);
    managerMock.isPluginLoaded.mockReturnValue(false);
    managerMock.loadDraftPlugin.mockResolvedValue(SNOWGLOBE.manifest as never);
    resetRevisions();
    vi.clearAllMocks();
    managerMock.getDraftPluginsDir.mockReturnValue(root);
    managerMock.getUserPluginsDir.mockReturnValue(userRoot);
    managerMock.getRegisteredTools.mockReturnValue({});
    managerMock.getDraftContributions.mockReturnValue({ tools: [], views: [] });
    managerMock.loadDraftPlugin.mockResolvedValue(SNOWGLOBE.manifest as never);
    managerMock.loadUserPlugin.mockResolvedValue({} as never);
    tools = createPluginDraftTools();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  });

  it('accepts the plugin an agent writes for a sidebar view, verbatim', async () => {
    const result: any = await run(tools.plugin_define, SNOWGLOBE);

    expect(result.success).toBe(true);
    expect(result.draft.id).toBe('com.eaves.snowglobe');
    // Staged, not running — defining is deliberately effect-free.
    expect(result.draft.running).toBe(false);
    expect(result.note).toMatch(/Staged, not running/);

    // The files are on disk exactly as written: a hand-written ES module
    // needs no build step, so what the agent typed is what gets served.
    const ui = fs.readFileSync(path.join(root, 'com-eaves-snowglobe', 'ui', 'index.js'), 'utf-8');
    expect(ui).toBe(SNOWGLOBE.files[1].content);
  });

  it('reports the one grant it asks for as actually used, and nothing undeclared', async () => {
    await run(tools.plugin_define, SNOWGLOBE);

    const draft = listDrafts()[0];
    expect(draft.analysis?.capabilities).toEqual([
      expect.objectContaining({
        permission: 'ui:views:register',
        label: 'Add its own views to the app',
        status: 'used',
        gating: 'gated',
        calls: ['context.ui.registerView'],
      }),
    ]);
    expect(draft.analysis?.undeclared).toEqual([]);
  });

  it('addresses the UI bundle in the draft namespace, never the installed one', async () => {
    const result: any = await run(tools.plugin_define, SNOWGLOBE);
    expect(result.draft.bundleUrl).toBe('plugin://draft.com-eaves-snowglobe/ui/index.js');
  });

  // Running is not rendering, and activation must not imply otherwise — the
  // agent has to be told to ask for a preview.
  it('warns on activation that a draft view is not in the sidebar and may not have rendered', async () => {
    await run(tools.plugin_define, SNOWGLOBE);
    const result: any = await run(tools.plugin_activate, { id: 'com.eaves.snowglobe' });

    expect(result.success).toBe(true);
    expect(managerMock.loadDraftPlugin).toHaveBeenCalledWith('com-eaves-snowglobe');
    expect(result.viewNote).toMatch(/not shown in the sidebar/);
    expect(result.viewNote).toMatch(/Running does NOT mean it rendered/);
  });

  it('keeps it: the draft becomes a user install and its grant is recorded', async () => {
    await run(tools.plugin_define, SNOWGLOBE);
    managerMock.isPluginLoaded.mockReturnValue(true); // it was running

    const kept = await promoteDraft('com.eaves.snowglobe');

    expect(kept).toEqual({ id: 'com.eaves.snowglobe', folderName: 'com-eaves-snowglobe' });
    // Stopped before its files moved, then loaded from the user tier.
    expect(managerMock.unloadPlugin).toHaveBeenCalledWith('com.eaves.snowglobe');
    expect(managerMock.loadUserPlugin).toHaveBeenCalledWith('com-eaves-snowglobe');
    // Installed, with the same files it was reviewed as.
    const installed = path.join(userRoot, 'com-eaves-snowglobe');
    expect(fs.existsSync(path.join(installed, 'plugin.json'))).toBe(true);
    expect(fs.readFileSync(path.join(installed, 'ui', 'index.js'), 'utf-8'))
      .toBe(SNOWGLOBE.files[1].content);
    // The draft is gone: it is not a draft any more.
    expect(listDrafts()).toEqual([]);
    expect(grantsMock.set).toHaveBeenCalledWith(
      'com.eaves.snowglobe', ['ui:views:register'], '1.0.0', expect.any(Number),
    );
  });

  it('asks a person before keeping it, and keeps nothing if they decline', async () => {
    await run(tools.plugin_define, SNOWGLOBE);
    showPluginConsent.mockResolvedValueOnce(false);

    await expect(promoteDraft('com.eaves.snowglobe')).rejects.toThrow(/cancelled/);

    expect(fs.existsSync(path.join(userRoot, 'com-eaves-snowglobe'))).toBe(false);
    expect(listDrafts().map(d => d.id)).toEqual(['com.eaves.snowglobe']); // still on the bench
  });

  // One-way per id: installed code is never agent-rewritable.
  it('refuses to redefine the plugin once it is installed', async () => {
    await run(tools.plugin_define, SNOWGLOBE);
    await promoteDraft('com.eaves.snowglobe');
    managerMock.getPluginManifest.mockReturnValue({ source: 'user' } as PluginManifest);

    const result: any = await run(tools.plugin_define, SNOWGLOBE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already the id of a loaded user plugin/);
  });
});
