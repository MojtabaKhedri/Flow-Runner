import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from './icons.mjs';
import { VERSION } from '../src/shared/constants.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function zipDirectory(directory, destination) {
  const files = [];
  async function collect(folder, prefix = '') {
    for (const item of (await readdir(folder, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (item.isDirectory()) await collect(join(folder, item.name), `${name}/`);
      else files.push({ name, bytes: await readFile(join(folder, item.name)) });
    }
  }
  await collect(directory);
  const local = [], central = [];
  let offset = 0, centralSize = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), compressed = deflateRawSync(file.bytes), crc = crc32(file.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x5d51, 12); // Fixed valid ZIP date for reproducible builds.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x5d51, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); centralSize += entry.length + name.length;
    offset += header.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.concat([...local, ...central, end]));
  return files.length;
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await import('./check.mjs');
  const target = join(root, 'release', `flow-runner-${VERSION}.zip`);
  const count = await zipDirectory(join(root, 'dist'), target);
  console.log(`Created ${target} (${count} files, manifest at ZIP root)`);
}
