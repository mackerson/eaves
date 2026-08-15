/**
 * Regression tests for the "installing one plugin can delete another" fix.
 *
 * Root cause: the install-dir folder name used to be `id.split('.').pop()`,
 * so `com.alice.notes` and `org.bob.notes` both resolved to `.../notes` —
 * install of one could rmSync the other's running directory out from under
 * it. The fix has two independent halves and both need coverage:
 *   1. `sanitizeFolderName` derives the folder from the *full* id, so two
 *      ids sharing a last segment no longer collide.
 *   2. `assertDestOwnership` refuses to let the caller clear a directory
 *      whose on-disk plugin.json declares a different id — the backstop
 *      for ids that were already installed under the old collapsed name.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/eaves-marketplace-test-userdata',
    getVersion: () => '1.0.0',
  },
}));

vi.mock('./sandbox', () => ({
  getSandboxedPluginManager: vi.fn(),
}));

vi.mock('./sandbox/pathContainment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox/pathContainment')>()),
  // Containment has its own tests; these exercise ownership and folder naming.
  isInsideDirectory: vi.fn(() => true),
}));

vi.mock('../repositories', () => ({
  getPluginGrantsRepository: vi.fn(),
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { assertDestOwnership, removeLegacyCollapsedInstall } from './MarketplaceService';
import { sanitizeFolderName } from './sandbox/pathContainment';

describe('sanitizeFolderName', () => {
  it('gives two ids that share a last dot-segment different folder names', () => {
    const alice = sanitizeFolderName('com.alice.notes');
    const bob = sanitizeFolderName('org.bob.notes');

    // Old behaviour (`id.split('.').pop()`) collapsed both to "notes".
    expect(alice).not.toBe(bob);
    expect(alice).toBe('com-alice-notes');
    expect(bob).toBe('org-bob-notes');
  });

  it('is a pure function of the full id, not just its last segment', () => {
    expect(sanitizeFolderName('a.b.c')).toBe('a-b-c');
    expect(sanitizeFolderName('simple-id')).toBe('simple-id');
    expect(sanitizeFolderName('with_underscore.and.dots')).toBe('with_underscore-and-dots');
  });
});

describe('assertDestOwnership', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-marketplace-ownership-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(dir: string, id: string | undefined) {
    fs.mkdirSync(dir, { recursive: true });
    if (id !== undefined) {
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id }));
    }
  }

  it('does not throw when dest does not exist (fresh install)', () => {
    const dest = path.join(tmpDir, 'com-alice-notes');
    expect(() => assertDestOwnership(dest, 'com.alice.notes')).not.toThrow();
  });

  it('does not throw when dest already belongs to this same id (upgrade-in-place)', () => {
    const dest = path.join(tmpDir, 'com-alice-notes');
    writeManifest(dest, 'com.alice.notes');
    expect(() => assertDestOwnership(dest, 'com.alice.notes')).not.toThrow();
  });

  it('refuses to clear a directory owned by a different plugin id, and leaves it untouched', () => {
    // Simulates a directory installed before this fix, under the collapsed
    // "notes" folder name, now collided with by a differently-named id.
    const dest = path.join(tmpDir, 'notes');
    writeManifest(dest, 'com.alice.notes');
    fs.writeFileSync(path.join(dest, 'alice-secret.txt'), 'do-not-delete');

    expect(() => assertDestOwnership(dest, 'org.bob.notes')).toThrow(/different plugin/);

    // The real install path only rmSync's dest *after* this guard passes —
    // proving the guard throws first is what keeps Alice's files alive.
    expect(fs.existsSync(path.join(dest, 'alice-secret.txt'))).toBe(true);
  });

  it('fails closed when the occupying manifest cannot be read', () => {
    const dest = path.join(tmpDir, 'broken');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'plugin.json'), '{not valid json');

    expect(() => assertDestOwnership(dest, 'com.alice.notes')).toThrow(/different plugin/);
  });
});

/**
 * Deriving the folder from the full id fixes collisions going forward, but it
 * also relocates every plugin installed before the fix. Upgrading one would
 * strand its old collapsed-name directory, leaving two directories declaring
 * the same id for discovery to load.
 */
describe('removeLegacyCollapsedInstall', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-marketplace-legacy-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(dir: string, id: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id }));
  }

  it('removes the old collapsed directory when it declares the same id', () => {
    const legacy = path.join(tmpDir, 'notes');
    const dest = path.join(tmpDir, 'com-alice-notes');
    writeManifest(legacy, 'com.alice.notes');
    writeManifest(dest, 'com.alice.notes');

    removeLegacyCollapsedInstall(tmpDir, 'com.alice.notes', dest);

    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('leaves a same-named directory owned by a different plugin alone', () => {
    const legacy = path.join(tmpDir, 'notes');
    const dest = path.join(tmpDir, 'com-alice-notes');
    writeManifest(legacy, 'org.bob.notes');
    writeManifest(dest, 'com.alice.notes');

    removeLegacyCollapsedInstall(tmpDir, 'com.alice.notes', dest);

    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('never deletes the destination it just wrote', () => {
    const dest = path.join(tmpDir, 'simple-id');
    writeManifest(dest, 'simple-id');

    removeLegacyCollapsedInstall(tmpDir, 'simple-id', dest);

    expect(fs.existsSync(dest)).toBe(true);
  });

  it('leaves an unreadable manifest in place rather than guessing', () => {
    const legacy = path.join(tmpDir, 'notes');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'plugin.json'), '{not valid json');

    removeLegacyCollapsedInstall(tmpDir, 'com.alice.notes', path.join(tmpDir, 'com-alice-notes'));

    expect(fs.existsSync(legacy)).toBe(true);
  });
});
