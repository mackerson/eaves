import { app, protocol } from 'electron';
import * as path from 'path';
import { registerFileServiceProtocol } from './fileService';
import { registerModuleShimProtocol } from './moduleShim';
import { registerPluginBundleProtocol } from './pluginBundle';
import { serveStaticFile } from './staticFile';
import { logger } from '../services/logger';

export function registerProtocolHandlers(): void {
  registerFileServiceProtocol();
  registerModuleShimProtocol();
  registerPluginBundleProtocol();

  protocol.handle('background', async (request) => {
    try {
      const url = new URL(request.url);
      const filename = url.host + url.pathname;
      const cacheDir = path.join(app.getPath('userData'), 'cache', 'backgrounds');
      return serveStaticFile(cacheDir, filename, { defaultMime: 'image/jpeg', cacheMaxAge: 86400, label: 'Background' });
    } catch (error) {
      logger.error('[protocol] Failed to serve background', { url: request.url, error: error instanceof Error ? error.message : String(error) });
      return new Response('Internal server error', { status: 500 });
    }
  });

  protocol.handle('avatar', async (request) => {
    try {
      const url = new URL(request.url);
      // For URLs like `avatar://filename.png` (no slashes), the parser puts
      // the filename on host and leaves pathname as `/`. Combine both, then
      // basename, so we resolve regardless of whether the agent stored a
      // bare filename or a full path.
      const raw = decodeURIComponent(url.host + url.pathname);
      const filename = path.basename(raw);
      if (!filename) {
        return new Response('Avatar not found', { status: 404 });
      }
      const avatarsDir = path.join(app.getPath('userData'), 'avatars');
      return serveStaticFile(avatarsDir, filename, { defaultMime: 'image/png', cacheMaxAge: 3600, label: 'Avatar' });
    } catch (error) {
      logger.error('[protocol] Failed to serve avatar', { url: request.url, error: error instanceof Error ? error.message : String(error) });
      return new Response('Internal server error', { status: 500 });
    }
  });
}
