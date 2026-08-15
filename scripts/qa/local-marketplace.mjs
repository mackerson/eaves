#!/usr/bin/env node
/**
 * Local plugin marketplace for testing the UI before the real GitHub registry
 * is live. Builds the first-party registry plugins, serves a local registry.json
 * + release tarballs over http, and prints the launch command.
 *
 *   node scripts/qa/local-marketplace.mjs [port=8791]
 *   # then, in another terminal:
 *   EAVES_REGISTRY_URL=http://localhost:8791/registry.json yarn dev
 *   # open  Plugins → Marketplace
 *
 * Note: the plugins here also ship bundled, so installing one drops a copy into
 * userData/plugins/ that shadows the bundled build (uninstall reverts). That's
 * expected — it still exercises the full download → verify → unpack → load path.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8791);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // eaves/
const pluginsDir = path.resolve(root, '..', 'plugins'); // sibling ../plugins
const serveDir = path.join(tmpdir(), 'eaves-local-marketplace');

// The V1 first-party registry set (also the plugins with release tooling).
const PLUGINS = ['character-card-import', 'chatgpt-import', 'openmemory', 'event-inspector'];

rmSync(serveDir, { recursive: true, force: true });
mkdirSync(serveDir, { recursive: true });

const entries = [];
for (const name of PLUGINS) {
  const dir = path.join(pluginsDir, name);
  if (!existsSync(path.join(dir, 'plugin.json'))) { console.warn(`skip ${name}: not found at ${dir}`); continue; }
  const m = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8'));

  if (existsSync(path.join(dir, 'vite.config.ts')) || existsSync(path.join(dir, 'vite.config.js'))) {
    process.stdout.write(`building ${name}… `);
    execSync('yarn build', { cwd: dir, stdio: 'ignore' });
  }

  const short = m.id.split('.').pop();
  const asset = `${short}.tgz`;
  const files = ['plugin.json', m.entry || 'index.cjs'];
  if (existsSync(path.join(dir, 'lib'))) files.push('lib'); // backend modules the entry require()s
  if (existsSync(path.join(dir, 'ui/dist'))) files.push('ui/dist');
  execSync(`tar --format=ustar -czf ${path.join(serveDir, asset)} -C ${dir} ${files.join(' ')}`, { stdio: 'ignore' });
  const sha256 = createHash('sha256').update(readFileSync(path.join(serveDir, asset))).digest('hex');

  entries.push({
    id: m.id, name: m.name, description: m.description || '', author: m.author || 'mackerson',
    homepage: `https://github.com/mackerson/eaves-plugin-${name}`,
    tier: 'official', latest: m.version, minAppVersion: '0.3.0',
    permissions: m.permissions || [],
    release: { tag: `v${m.version}`, asset, url: `http://localhost:${PORT}/${asset}`, sha256 },
  });
  console.log(`packed ${asset} (${sha256.slice(0, 12)}…)`);
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(serveDir, 'registry.json'), JSON.stringify({ schemaVersion: 1, updated: today, plugins: entries }));

createServer((req, res) => {
  const f = path.join(serveDir, path.basename(decodeURIComponent((req.url || '/').split('?')[0])));
  if (!existsSync(f) || !f.startsWith(serveDir)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200);
  createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nLocal marketplace serving ${entries.length} plugins on http://localhost:${PORT}`);
  console.log(`\n  Launch the app pointed at it (another terminal):\n`);
  console.log(`    EAVES_REGISTRY_URL=http://localhost:${PORT}/registry.json yarn dev\n`);
  console.log(`  Then open  Plugins → Marketplace.  Ctrl-C here to stop.`);
});
