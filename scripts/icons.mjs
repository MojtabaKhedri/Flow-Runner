import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND_NAME } from '../src/shared/constants.js';


export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([size, type, bytes, crc]);
}
function insideRound(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x > left + width || y > top + height) return false;
  const dx = x - Math.max(left + radius, Math.min(x, left + width - radius));
  const dy = y - Math.max(top + radius, Math.min(y, top + height - radius));
  return dx * dx + dy * dy <= radius * radius;
}
function colorAt(x, y) {
  if (!insideRound(x, y, 0, 0, 64, 64, 15)) return [0, 0, 0, 0];
  if ((x - 46) ** 2 + (y - 47) ** 2 < 5 ** 2) return [255, 105, 97, 255];
  if (insideRound(x, y, 17, 15, 7, 37, 3.5) || insideRound(x, y, 17, 15, 33, 7, 3.5) ||
      insideRound(x, y, 17, 30, 24, 7, 3.5)) return [232, 226, 216, 255];
  return [228, 0, 43, 255];
}
export function makeIcon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const color = colorAt((x + (sx + .5) / samples) * 64 / size, (y + (sy + .5) / samples) * 64 / size);
      color.forEach((value, channel) => { sum[channel] += value; });
    }
    for (let channel = 0; channel < 4; channel++) raw[y * (size * 4 + 1) + x * 4 + 1 + channel] = Math.round(sum[channel] / samples ** 2);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export async function writeIcons(directory) {
  await mkdir(directory, { recursive: true });
  for (const size of [16, 32, 48, 128]) await writeFile(join(directory, `icon-${size}.png`), makeIcon(size));
  await writeFile(join(directory, 'mark.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>${BRAND_NAME}</title><rect width="64" height="64" rx="15" fill="#e4002b"/><g fill="#e8e2d8"><rect x="17" y="15" width="7" height="37" rx="3.5"/><rect x="17" y="15" width="33" height="7" rx="3.5"/><rect x="17" y="30" width="24" height="7" rx="3.5"/></g><circle cx="46" cy="47" r="5" fill="#ff6961"/></svg>\n`);
}
