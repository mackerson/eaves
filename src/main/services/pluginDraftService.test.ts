/**
 * The draft service is the layer that decides what an agent is allowed to put
 * on disk, so these tests are mostly refusals. Each one corresponds to a way a
 * staged directory could stop being a plugin directory.
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
};
vi.mock('./sandbox', () => ({ getSandboxedPluginManager: () => managerMock }));

import { writeDraft, listDrafts, readDraft, PluginDraftError } from './pluginDraftService';

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'com.alice.sketch',
  name: 'Sketch',
  version: '1.0.0',
  type: 'ui',
  entry: 'index.cjs',
  permissions: ['ui:views:register'],
  ...overrides,
});

const entryFile = { path: 'index.cjs', content: 'module.exports = { activate() {} };' };

describe('pluginDraftService', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-drafts-'));
    managerMock.getDraftPluginsDir.mockReturnValue(root);
    managerMock.getPluginManifest.mockReturnValue(null);
    managerMock.isPluginLoaded.mockReturnValue(false);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('writing', () => {
    it('stages the manifest and every declared file', () => {
      const record = writeDraft({
        manifest: manifest({ ui: { entry: 'ui/index.js', components: { Sketch: 'named' } } }),
        files: [entryFile, { path: 'ui/index.js', content: 'export const Sketch = () => null;' }],
      });

      const dir = path.join(root, 'com-alice-sketch');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8')).id)
        .toBe('com.alice.sketch');
      expect(fs.readFileSync(path.join(dir, 'ui/index.js'), 'utf-8')).toContain('Sketch');
      expect(record.files).toEqual(['index.cjs', 'ui/index.js']);
      expect(record.running).toBe(false);
    });

    it('defaults sandboxVersion so a draft can never be staged unsandboxed', () => {
      writeDraft({ manifest: manifest(), files: [entryFile] });
      const written = JSON.parse(
        fs.readFileSync(path.join(root, 'com-alice-sketch', 'plugin.json'), 'utf-8'),
      );
      expect(written.sandboxVersion).toBe(1);
    });

    it('addresses a UI bundle through the draft-prefixed bundle URL', () => {
      const record = writeDraft({
        manifest: manifest({ ui: { entry: 'ui/index.js', components: { Sketch: 'named' } } }),
        files: [entryFile, { path: 'ui/index.js', content: 'export const Sketch = () => null;' }],
      });
      expect(record.bundleUrl).toBe('plugin://draft.com-alice-sketch/ui/index.js');
    });

    it('replaces an earlier draft with the same id', () => {
      writeDraft({ manifest: manifest(), files: [entryFile, { path: 'stale.js', content: 'x' }] });
      writeDraft({ manifest: manifest(), files: [entryFile] });
      expect(fs.existsSync(path.join(root, 'com-alice-sketch', 'stale.js'))).toBe(false);
    });
  });

  describe('path refusals', () => {
    const rejects = (filePath: string, pattern: RegExp) => {
      expect(() =>
        writeDraft({ manifest: manifest(), files: [entryFile, { path: filePath, content: 'x' }] }),
      ).toThrow(pattern);
    };

    it('refuses traversal out of the plugin directory', () => {
      rejects('../escaped.js', /climb out/);
    });

    it('refuses traversal buried mid-path', () => {
      rejects('ui/../../escaped.js', /climb out/);
    });

    it('refuses absolute paths', () => {
      rejects('/etc/passwd.js', /must be relative/);
    });

    it('refuses backslash separators', () => {
      rejects('ui\\index.js', /forward slashes/);
    });

    it('refuses an extension that is not text a plugin can use', () => {
      rejects('native.node', /may not contain/);
    });

    it('refuses the same path twice', () => {
      expect(() =>
        writeDraft({ manifest: manifest(), files: [entryFile, entryFile] }),
      ).toThrow(/declared twice/);
    });

    it('writes nothing at all when one file is rejected', () => {
      expect(() =>
        writeDraft({
          manifest: manifest(),
          files: [entryFile, { path: '../escaped.js', content: 'x' }],
        }),
      ).toThrow(PluginDraftError);
      expect(fs.existsSync(path.join(root, 'com-alice-sketch'))).toBe(false);
      expect(fs.readdirSync(root)).toEqual([]);
    });
  });

  describe('manifest refusals', () => {
    it('refuses a manifest whose entry file was not provided', () => {
      expect(() =>
        writeDraft({ manifest: manifest({ entry: 'missing.cjs' }), files: [entryFile] }),
      ).toThrow(/names "missing.cjs" as its entry/);
    });

    it('refuses a manifest whose UI bundle was not provided', () => {
      expect(() =>
        writeDraft({
          manifest: manifest({ ui: { entry: 'ui/index.js', components: { S: 'named' } } }),
          files: [entryFile],
        }),
      ).toThrow(/as its UI bundle/);
    });

    it('refuses an unknown permission', () => {
      expect(() =>
        writeDraft({ manifest: manifest({ permissions: ['system:everything'] }), files: [entryFile] }),
      ).toThrow(/Invalid plugin manifest/);
    });

    it('refuses an id that a loaded installed plugin already answers to', () => {
      managerMock.getPluginManifest.mockReturnValue({ source: 'user' } as PluginManifest);
      expect(() => writeDraft({ manifest: manifest(), files: [entryFile] }))
        .toThrow(/already the id of a loaded user plugin/);
    });

    it('refuses to redefine a draft that is currently running', () => {
      managerMock.isPluginLoaded.mockReturnValue(true);
      expect(() => writeDraft({ manifest: manifest(), files: [entryFile] }))
        .toThrow(/Retract it before redefining/);
    });
  });

  describe('caps', () => {
    it('refuses a draft with no files', () => {
      expect(() => writeDraft({ manifest: manifest(), files: [] })).toThrow(/at least its entry/);
    });

    it('refuses more files than a plugin plausibly has', () => {
      const files = Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.js`, content: 'x' }));
      expect(() => writeDraft({ manifest: manifest(), files })).toThrow(/at most 40 files/);
    });

    it('refuses a single oversized file', () => {
      const files = [entryFile, { path: 'big.js', content: 'x'.repeat(512 * 1024 + 1) }];
      expect(() => writeDraft({ manifest: manifest(), files })).toThrow(/per-file cap/);
    });
  });

  describe('reading back', () => {
    it('lists staged drafts and reads one back verbatim', () => {
      writeDraft({ manifest: manifest(), files: [entryFile] });

      expect(listDrafts().map(draft => draft.id)).toEqual(['com.alice.sketch']);

      const read = readDraft('com.alice.sketch');
      expect(read?.files).toEqual([entryFile]);
      expect(read?.record.permissions).toEqual(['ui:views:register']);
    });

    it('skips a directory that is not a readable plugin', () => {
      fs.mkdirSync(path.join(root, 'junk'), { recursive: true });
      fs.writeFileSync(path.join(root, 'junk', 'plugin.json'), 'not json');
      expect(listDrafts()).toEqual([]);
    });

    it('reports nothing when the draft root does not exist yet', () => {
      managerMock.getDraftPluginsDir.mockReturnValue(path.join(root, 'absent'));
      expect(listDrafts()).toEqual([]);
    });
  });
});
