/**
 * The tools are a thin skin over pluginDraftService and the plugin manager, so
 * what is worth testing here is the skin: that a refusal comes back as a result
 * the model can read and correct from rather than an exception, that the two
 * verbs with effects are approval-gated, and that activation reports what it
 * actually changed.
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
  getPluginManifest: vi.fn<(id: string) => PluginManifest | null>(() => null),
  isPluginLoaded: vi.fn<(id: string) => boolean>(() => false),
  getLoadedPluginIds: vi.fn<() => string[]>(() => []),
  getRegisteredTools: vi.fn<() => Record<string, unknown>>(() => ({})),
  loadDraftPlugin: vi.fn(),
  removeDraftPlugin: vi.fn(),
};
vi.mock('./sandbox', () => ({ getSandboxedPluginManager: () => managerMock }));

import { createPluginDraftTools } from './pluginDraftTools';

type ToolShape = {
  needsApproval?: boolean;
  execute: (args: Record<string, unknown>) => Promise<any>;
};
const tools = () => createPluginDraftTools() as unknown as Record<string, ToolShape>;

const manifest = {
  id: 'com.alice.sketch',
  name: 'Sketch',
  version: '1.0.0',
  type: 'ui' as const,
  entry: 'index.cjs',
  permissions: ['ui:views:register'],
};
const files = [{ path: 'index.cjs', content: 'module.exports = { activate() {} };' }];

describe('plugin draft tools', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-draft-tools-'));
    vi.clearAllMocks();
    managerMock.getDraftPluginsDir.mockReturnValue(root);
    managerMock.getPluginManifest.mockReturnValue(null);
    managerMock.isPluginLoaded.mockReturnValue(false);
    managerMock.getLoadedPluginIds.mockReturnValue([]);
    managerMock.getRegisteredTools.mockReturnValue({});
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gates the two verbs with effects, and only those', () => {
    const t = tools();
    expect(t.plugin_define.needsApproval).toBe(true);
    expect(t.plugin_activate.needsApproval).toBe(true);
    expect(t.plugin_inspect.needsApproval).toBeUndefined();
    expect(t.plugin_retract.needsApproval).toBeUndefined();
  });

  describe('plugin_inspect', () => {
    it('reports the callable surface with the grant each call needs', async () => {
      const result = await tools().plugin_inspect.execute({ what: 'api' });

      expect(result.success).toBe(true);
      expect(result.api.methods).toContainEqual({
        call: 'context.tools.register()',
        requires: ['tools:register'],
      });
      expect(result.api.entryShape).toContain('module.exports');
      expect(result.api.uiShape).toContain('/node_modules/react');
      expect(result.drafts).toBeUndefined();
    });

    it('narrows to drafts without paying for the rest', async () => {
      await tools().plugin_define.execute({ manifest, files });
      const result = await tools().plugin_inspect.execute({ what: 'drafts' });

      expect(result.drafts).toEqual([expect.objectContaining({ id: 'com.alice.sketch', running: false })]);
      expect(result.api).toBeUndefined();
      expect(result.loadedPlugins).toBeUndefined();
    });
  });

  describe('plugin_define', () => {
    it('stages the draft and says it is not running', async () => {
      const result = await tools().plugin_define.execute({ manifest, files });

      expect(result.success).toBe(true);
      expect(result.draft.id).toBe('com.alice.sketch');
      expect(result.draft.running).toBe(false);
      expect(result.note).toMatch(/plugin_activate/);
      expect(fs.existsSync(path.join(root, 'com-alice-sketch', 'index.cjs'))).toBe(true);
    });

    it('returns a refusal the model can act on rather than throwing', async () => {
      const result = await tools().plugin_define.execute({
        manifest,
        files: [...files, { path: '../escaped.js', content: 'x' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/climb out/);
    });
  });

  describe('plugin_activate', () => {
    it('names the tool that would show what is staged when the id is unknown', async () => {
      const result = await tools().plugin_activate.execute({ id: 'com.nobody.nothing' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/plugin_inspect/);
      expect(managerMock.loadDraftPlugin).not.toHaveBeenCalled();
    });

    it('loads by folder name and reports the tools that appeared', async () => {
      await tools().plugin_define.execute({ manifest, files });
      managerMock.loadDraftPlugin.mockResolvedValue({ ...manifest, source: 'draft' });
      managerMock.getRegisteredTools
        .mockReturnValueOnce({ existing: {} })
        .mockReturnValueOnce({ existing: {}, sketch_draw: {} });

      const result = await tools().plugin_activate.execute({ id: 'com.alice.sketch' });

      expect(managerMock.loadDraftPlugin).toHaveBeenCalledWith('com-alice-sketch');
      expect(result.registeredTools).toEqual(['sketch_draw']);
      expect(result.note).toMatch(/next turn/);
    });

    it('says plainly that a draft view is not surfaced', async () => {
      const withUi = { ...manifest, ui: { entry: 'ui/index.js', components: { Sketch: 'named' } } };
      await tools().plugin_define.execute({
        manifest: withUi,
        files: [...files, { path: 'ui/index.js', content: 'export const Sketch = () => null;' }],
      });
      managerMock.loadDraftPlugin.mockResolvedValue({ ...withUi, source: 'draft' });

      const result = await tools().plugin_activate.execute({ id: 'com.alice.sketch' });
      expect(result.viewNote).toMatch(/not shown in the sidebar/);
    });

    it('relays a refusal from the manager', async () => {
      await tools().plugin_define.execute({ manifest, files });
      managerMock.loadDraftPlugin.mockRejectedValue(new Error('that id belongs to a loaded user plugin'));

      const result = await tools().plugin_activate.execute({ id: 'com.alice.sketch' });
      expect(result).toEqual({ success: false, error: 'that id belongs to a loaded user plugin' });
    });
  });

  describe('plugin_retract', () => {
    it('delegates to the manager, which owns the ownership checks', async () => {
      managerMock.removeDraftPlugin.mockResolvedValue(undefined);
      const result = await tools().plugin_retract.execute({ id: 'com.alice.sketch' });

      expect(managerMock.removeDraftPlugin).toHaveBeenCalledWith('com.alice.sketch');
      expect(result.success).toBe(true);
    });

    it('relays the manager refusing to touch an installed plugin', async () => {
      managerMock.removeDraftPlugin.mockRejectedValue(new Error('Cannot retract user plugin x — it is not a draft'));
      const result = await tools().plugin_retract.execute({ id: 'x' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a draft/);
    });
  });
});
