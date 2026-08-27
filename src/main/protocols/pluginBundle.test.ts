/**
 * The bundle protocol serves two roots through one scheme, so the tests that
 * matter are the ones that keep them apart: a draft must never be reachable as
 * an installed plugin, an installed plugin must never be reachable as a draft,
 * and neither may be climbed out of.
 *
 * `plugins-draft` has `plugins` as a literal string prefix, which is exactly
 * the class of bug `isInsideDirectory` exists to prevent — so containment is
 * asserted per-root rather than once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let userData = '';
type Handler = (request: { url: string }) => Promise<Response>;
let handler: Handler | null = null;

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  protocol: {
    handle: (_scheme: string, fn: Handler) => {
      handler = fn;
    },
  },
}));

import { registerPluginBundleProtocol, DRAFT_HOST_PREFIX } from './pluginBundle';

const serve = (url: string) => handler!({ url });

describe('plugin:// bundle protocol', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'eaves-bundle-'));
    userData = root;
    await fsp.mkdir(path.join(root, 'plugins', 'notes'), { recursive: true });
    await fsp.mkdir(path.join(root, 'plugins-draft', 'sketch'), { recursive: true });
    await fsp.writeFile(path.join(root, 'plugins', 'notes', 'ui.js'), 'INSTALLED');
    await fsp.writeFile(path.join(root, 'plugins-draft', 'sketch', 'ui.js'), 'DRAFT');
    handler = null;
    registerPluginBundleProtocol();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('serves an installed plugin from the install root', async () => {
    const res = await serve('plugin://notes/ui.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('INSTALLED');
  });

  it('serves a draft only under the reserved host prefix', async () => {
    const res = await serve(`plugin://${DRAFT_HOST_PREFIX}sketch/ui.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('DRAFT');
  });

  it('does not reach a draft through an unprefixed host', async () => {
    expect((await serve('plugin://sketch/ui.js')).status).toBe(404);
  });

  it('does not reach an installed plugin through the draft prefix', async () => {
    expect((await serve(`plugin://${DRAFT_HOST_PREFIX}notes/ui.js`)).status).toBe(404);
  });

  it('refuses to climb out of the install root', async () => {
    const res = await serve('plugin://notes/..%2F..%2Fplugins-draft%2Fsketch%2Fui.js');
    expect(res.status).toBe(403);
  });

  it('refuses to climb out of the draft root', async () => {
    const res = await serve(`plugin://${DRAFT_HOST_PREFIX}sketch/..%2F..%2Fplugins%2Fnotes%2Fui.js`);
    expect(res.status).toBe(403);
  });

  it('404s a missing file rather than leaking the root', async () => {
    expect((await serve('plugin://notes/missing.js')).status).toBe(404);
  });
});
