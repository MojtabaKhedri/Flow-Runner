import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { VERSION, FLOW_MATCH, BRAND_NAME } from '../src/shared/constants.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const expectedFiles = [
  'manifest.json', '_locales/en/messages.json', 'background/worker.js',
  'content/main.js', 'content/status.js', 'fonts/OFL.txt', 'fonts/Vazirmatn.woff2',
  'icons/mark.svg', ...[16, 32, 48, 128].map(size => `icons/icon-${size}.png`),
  ...['popup.html', 'popup.css', 'popup.js', 'help.html', 'privacy.html', 'document.css', 'typography.css'].map(name => `ui/${name}`)
];
const actualFiles = [];
const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, VERSION);
assert.equal(manifest.name, BRAND_NAME);
assert.equal(manifest.action.default_title, BRAND_NAME);
assert.equal(manifest.default_locale, 'en');
assert.deepEqual(manifest.permissions.sort(), ['scripting', 'storage']);
assert.deepEqual(manifest.host_permissions, [FLOW_MATCH]);
assert.equal(manifest.content_scripts, undefined, 'No always-on content scripts');
assert.equal(manifest.web_accessible_resources, undefined, 'No publicly exposed resources');
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.update_url, undefined);
assert.equal(manifest.key, undefined);
const policy = manifest.content_security_policy.extension_pages;
for (const directive of ["script-src 'self'", "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert(policy.includes(directive));
assert(!/unsafe-|https?:|\*/.test(policy));
for (const path of [manifest.background.service_worker, manifest.action.default_popup]) assert((await stat(join(output, path))).isFile());
for (const [size, path] of Object.entries(manifest.icons)) {
  const bytes = await readFile(join(output, path));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), Number(size)); assert.equal(bytes.readUInt32BE(20), Number(size));
}
for (const locale of ['en']) {
  const messages = JSON.parse(await readFile(join(output, '_locales', locale, 'messages.json'), 'utf8'));
  assert(messages.extensionDescription.message.length <= 132);
  assert(/^[\x20-\x7e]+$/.test(messages.extensionDescription.message));
}
const font = await readFile(join(output, 'fonts', 'Vazirmatn.woff2'));
assert.equal(font.subarray(0, 4).toString(), 'wOF2');
assert((await readFile(join(output, 'fonts', 'OFL.txt'), 'utf8')).includes('SIL OPEN FONT LICENSE'));
const typography = await readFile(join(output, 'ui', 'typography.css'), 'utf8');
assert(!(await readdir(join(output, 'content'))).includes('observe.js'));
const popup = await readFile(join(output, 'ui', 'popup.html'), 'utf8');
assert(popup.includes('href="https://github.com/MojtabaKhedri/Flow-Runner" target="_blank" rel="noopener noreferrer"'));
assert(!/<select\b|id="(?:mode|risk-note)"/.test(popup));
assert(typography.includes("url('../fonts/Vazirmatn.woff2')"));
assert(typography.includes("font-family: 'Vazirmatn', sans-serif !important"));
assert(typography.includes('font-display: block'));
for (const stylesheet of ['popup.css', 'document.css']) {
  const css = await readFile(join(output, 'ui', stylesheet), 'utf8');
  assert(css.includes('color-scheme: dark'));
  assert(!/prefers-color-scheme|color-scheme:\s*light|Segoe|Tahoma/.test(css));
}
for (const page of ['popup.html', 'help.html', 'privacy.html']) {
  const html = await readFile(join(output, 'ui', page), 'utf8');
  assert(/lang="fa"\s+dir="rtl"/.test(html));
  assert(!/lang="en"/.test(html));
  assert(html.includes('href="typography.css"'));
  assert(html.includes('as="font" type="font/woff2" crossorigin'));
  assert(html.includes(BRAND_NAME));
  assert(!html.includes('Flow-Problem'));
}
async function inspect(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    assert(!item.isSymbolicLink(), `Linked build resource: ${path}`);
    const name = prefix + item.name;
    if (item.isDirectory()) { await inspect(path, name + '/'); continue; }
    assert(item.isFile());
    actualFiles.push(name);
    if (!/\.(js|html|css|json|svg)$/.test(path)) continue;
    const text = await readFile(path, 'utf8');
    assert(!/\ba0_0x[\da-f]*/i.test(text), `Obfuscated identifier: ${path}`);
    assert(!/\beval\s*\(|new\s+Function\s*\(/.test(text), `Dynamic code: ${path}`);
    assert(!/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(text), `HTML injection sink: ${path}`);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AIza[\w-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{30,}/.test(text), `Possible embedded secret: ${path}`);
    const hosts = [...text.matchAll(/https?:\/\/([\w.-]+)/g)].map(match => match[1]);
    assert(hosts.every(host => ['flow.google.com', 't.me', 'www.w3.org'].includes(host) || (name === 'ui/popup.html' && host === 'github.com')), `Unexpected URL host: ${path}`);
    assert(!/<script[^>]+src=["']https?:/i.test(text), `Remote script: ${path}`);
    assert(!/@import|url\(\s*["']?https?:|https?:\/\/[^\s"'<>]*(?:\.js|\.css)/i.test(text), `Remote asset: ${path}`);
    if (item.name.endsWith('.html')) {
      assert(!/<script\b[^>]*>\s*[^<\s]/i.test(text), `Inline script: ${path}`);
      assert(!/\son\w+\s*=/.test(text), `Inline handler: ${path}`);
    }
  }
}
await inspect(output);
assert.deepEqual(actualFiles.sort(), expectedFiles.sort(), 'Unexpected or missing release files');
console.log('Package checks passed: MV3, scoped permissions, assets, locales, CSP-compatible UI, readable local code.');
