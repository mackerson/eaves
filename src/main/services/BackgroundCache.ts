import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { logger } from './logger';

/**
 * BackgroundCache service
 * Handles caching of background images (remote URLs and local files) with protocol URL output.
 * All public methods return background:// protocol URLs for use in the renderer.
 */
class BackgroundCacheService {
  private _cacheDir: string | null = null;
  private maxCacheSize: number = 100 * 1024 * 1024; // 100MB max cache
  private maxAge: number = 7 * 24 * 60 * 60 * 1000; // 7 days

  private get cacheDir(): string {
    if (!this._cacheDir) {
      this._cacheDir = path.join(app.getPath('userData'), 'cache', 'backgrounds');
      if (!fs.existsSync(this._cacheDir)) {
        fs.mkdirSync(this._cacheDir, { recursive: true });
        logger.info('[BackgroundCache] Created cache directory', { path: this._cacheDir });
      }
    }
    return this._cacheDir;
  }

  /**
   * Convert a cached filename to a protocol URL
   */
  private toProtocolUrl(filename: string): string {
    return `background://${filename}`;
  }

  /**
   * Generate a cache key (filename) from a URL
   */
  private getCacheKey(url: string): string {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const urlObj = new URL(url);
    const ext = path.extname(urlObj.pathname) || '.jpg';
    return `${hash}${ext}`;
  }

  /**
   * Check if a remote URL is cached and return its protocol URL
   * Returns null if not cached or cache expired
   */
  getCached(url: string): string | null {
    const cacheKey = this.getCacheKey(url);
    const cachedPath = path.join(this.cacheDir, cacheKey);

    if (fs.existsSync(cachedPath)) {
      const stats = fs.statSync(cachedPath);
      const age = Date.now() - stats.mtimeMs;

      if (age < this.maxAge) {
        // Update access time to keep file alive
        fs.utimesSync(cachedPath, new Date(), stats.mtime);
        return this.toProtocolUrl(cacheKey);
      } else {
        // Cache expired, remove it
        fs.unlinkSync(cachedPath);
        logger.debug('[BackgroundCache] Cache expired', { url, cacheKey });
      }
    }

    return null;
  }

  /**
   * Download and cache a remote image, returning its protocol URL
   * Returns null on failure
   */
  async cacheUrl(url: string): Promise<string | null> {
    // Check if already cached
    const existing = this.getCached(url);
    if (existing) {
      logger.debug('[BackgroundCache] Using cached image', { url });
      return existing;
    }

    try {
      logger.info('[BackgroundCache] Downloading image', { url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Invalid content type: ${contentType}`);
      }

      const buffer = await response.arrayBuffer();
      const cacheKey = this.getCacheKey(url);
      const cachedPath = path.join(this.cacheDir, cacheKey);

      fs.writeFileSync(cachedPath, Buffer.from(buffer));
      logger.info('[BackgroundCache] Cached image', { url, path: cachedPath, size: buffer.byteLength });

      this.cleanupCache();

      return this.toProtocolUrl(cacheKey);
    } catch (error) {
      logger.error('[BackgroundCache] Failed to cache image', { url, error });
      return null;
    }
  }

  /**
   * Copy a local file to the cache and return its protocol URL
   * Returns null on failure
   */
  cacheLocalFile(sourcePath: string): string | null {
    try {
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source file does not exist: ${sourcePath}`);
      }

      const ext = path.extname(sourcePath);
      // Key on the file's identity, not on the moment it was picked. `Date.now()`
      // in the hash meant re-picking the same background copied it again every
      // time, so the cache grew without bound on the one action a user is most
      // likely to repeat while trying wallpapers out. mtime + size keeps a
      // genuinely edited file from silently resolving to the stale copy.
      const stats = fs.statSync(sourcePath);
      const hash = crypto
        .createHash('md5')
        .update(`${sourcePath}:${stats.mtimeMs}:${stats.size}`)
        .digest('hex');
      const cacheKey = `local-${hash}${ext}`;
      const cachedPath = path.join(this.cacheDir, cacheKey);

      if (fs.existsSync(cachedPath)) {
        logger.debug('[BackgroundCache] Local file already cached', { source: sourcePath });
        return this.toProtocolUrl(cacheKey);
      }

      fs.copyFileSync(sourcePath, cachedPath);
      logger.info('[BackgroundCache] Copied local file to cache', { source: sourcePath, dest: cachedPath });

      // Pruning used to happen only after a *remote* download, so a user who
      // only ever picked local files never enforced the size cap at all.
      this.cleanupCache();

      return this.toProtocolUrl(cacheKey);
    } catch (error) {
      logger.error('[BackgroundCache] Failed to copy local file', { sourcePath, error });
      return null;
    }
  }

  /**
   * Remove old cache entries to keep cache size under limit
   */
  private cleanupCache(): void {
    try {
      const files = fs.readdirSync(this.cacheDir)
        .map(name => {
          const filePath = path.join(this.cacheDir, name);
          const stats = fs.statSync(filePath);
          return { name, path: filePath, size: stats.size, atime: stats.atimeMs };
        })
        .sort((a, b) => a.atime - b.atime); // Oldest first

      let totalSize = files.reduce((sum, f) => sum + f.size, 0);

      // Remove oldest files until under limit
      for (const file of files) {
        if (totalSize <= this.maxCacheSize) break;

        fs.unlinkSync(file.path);
        totalSize -= file.size;
        logger.debug('[BackgroundCache] Removed old cache entry', { path: file.path });
      }
    } catch (error) {
      logger.error('[BackgroundCache] Failed to cleanup cache', { error });
    }
  }

  /**
   * Clear the entire cache
   */
  clearCache(): void {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      logger.info('[BackgroundCache] Cleared cache');
    } catch (error) {
      logger.error('[BackgroundCache] Failed to clear cache', { error });
    }
  }
}

let _backgroundCacheInstance: BackgroundCacheService | null = null;
export function getBackgroundCache(): BackgroundCacheService {
  if (!_backgroundCacheInstance) _backgroundCacheInstance = new BackgroundCacheService();
  return _backgroundCacheInstance;
}
export const backgroundCache = getBackgroundCache();
