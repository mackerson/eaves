import { app, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { reactShimResponse } from './moduleShim';
import { logger } from '../services/logger';

/**
 * Privileged scheme that serves installed-plugin UI bundles from
 * `userData/plugins/`. Bundled plugins load from `dist/plugins/` over file://
 * (reachable from the packaged renderer as `../../plugins/...`); marketplace- and
 * user-installed plugins live in `userData/plugins/`, which the packaged renderer
 * cannot reach — this scheme bridges that gap so the no-dev-build install path
 * works end to end.
 *
 * Registered privileged (standard + secure + supportFetchAPI) in main.ts so the
 * renderer `import()`s these bundles as real ES modules.
 *
 * URL form: `plugin://<folderName>/<entry>` e.g. `plugin://simple-memory/ui/dist/index.js`.
 * Folder names are lowercase (derived from lowercase plugin ids), matching the
 * standard-scheme host lowercasing.
 */
export const PLUGIN_BUNDLE_SCHEME = 'plugin';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function registerPluginBundleProtocol(): void {
  const pluginsRoot = path.join(app.getPath('userData'), 'plugins');

  protocol.handle(PLUGIN_BUNDLE_SCHEME, async (request) => {
    try {
      // A bundle's externalized `/node_modules/react*` imports resolve against
      // the plugin:// origin (not file://), so the module-shim file:// redirect
      // can't catch them — serve the same React shims here. Check first.
      const shim = reactShimResponse(request.url);
      if (shim) return shim;

      const url = new URL(request.url);
      const folder = path.basename(decodeURIComponent(url.host)); // host = plugin folder
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!folder || !rel) return new Response('Not found', { status: 404 });

      const baseDir = path.join(pluginsRoot, folder);
      const resolved = path.normalize(path.join(baseDir, rel));

      // Containment: resolved must stay inside the plugin's own directory
      // (path.relative, not startsWith — avoids the sibling-prefix escape).
      const within = path.relative(baseDir, resolved);
      if (within.startsWith('..') || path.isAbsolute(within)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return new Response('Not found', { status: 404 });
      }

      const body = await fs.promises.readFile(resolved);
      const mime = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' },
      });
    } catch (error) {
      logger.error('[protocol] Failed to serve plugin bundle', { url: request.url, error: error instanceof Error ? error.message : String(error) });
      return new Response('Internal server error', { status: 500 });
    }
  });
}
