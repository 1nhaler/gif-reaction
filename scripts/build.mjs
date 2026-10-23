// Bundles the extension into dist/, ready to load with "Load unpacked" in chrome://extensions.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIconPng } from './icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'icons'), { recursive: true });

await build({
  entryPoints: {
    hook: join(root, 'src/hook/hook.ts'),
    bridge: join(root, 'src/bridge/bridge.ts'),
    popup: join(root, 'src/popup/popup.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome111',
  legalComments: 'none',
  logLevel: 'info',
});

cpSync(join(root, 'static/popup.html'), join(dist, 'popup.html'));
cpSync(join(root, 'static/popup.css'), join(dist, 'popup.css'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'static/manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(dist, 'icons', `icon${size}.png`), makeIconPng(size));
}
console.log('Built dist/ for version', pkg.version);
