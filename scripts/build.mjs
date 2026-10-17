import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { VERSION, FLOW_MATCH, BRAND_NAME } from '../src/shared/constants.js';
import { writeIcons } from './icons.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
// Resolve and verify the full destination before recursively replacing a build.
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (relative(root, output) !== 'dist' || pkg.name !== 'flow-runner') throw new Error('Unexpected build destination or project');
if (pkg.version !== VERSION) throw new Error('Version mismatch');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'public'), output, { recursive: true });
await build({
  absWorkingDir: root, bundle: true, minify: false, sourcemap: false,
  target: 'chrome120', legalComments: 'inline', charset: 'utf8',
  entryPoints: { 'background/worker': 'src/background/worker.js', 'ui/popup': 'src/ui/popup.js' },
  format: 'esm', outdir: output, logLevel: 'warning'
});
await build({
  absWorkingDir: root, bundle: true, minify: false, sourcemap: false,
  target: 'chrome120', legalComments: 'inline', charset: 'utf8',
  entryPoints: { 'content/main': 'src/content/main.js', 'content/status': 'src/content/status.js' },
  format: 'iife', outdir: output, logLevel: 'warning'
});
await writeIcons(join(output, 'icons'));
const icons = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/icon-${size}.png`]));
const manifest = {
  manifest_version: 3, name: BRAND_NAME, version: VERSION,
  minimum_chrome_version: '120', default_locale: 'en',
  description: '__MSG_extensionDescription__',
  permissions: ['scripting', 'storage'], host_permissions: [FLOW_MATCH],
  background: { service_worker: 'background/worker.js', type: 'module' },
  action: { default_title: BRAND_NAME, default_popup: 'ui/popup.html', default_icon: icons },
  icons,
  content_security_policy: {
    extension_pages: "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'; frame-ancestors 'none'"
  }
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const [locale, description] of Object.entries({
  en: 'Locally adjusts a Google Flow regional configuration response, with a simple on/off switch.'
})) {
  const folder = join(output, '_locales', locale);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'messages.json'), JSON.stringify({ extensionDescription: { message: description } }, null, 2) + '\n');
}
console.log(`Built ${BRAND_NAME} ${VERSION}: ${output}`);
