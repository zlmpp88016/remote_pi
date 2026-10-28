/**
 * Compare two PNG screenshots pixel by pixel and report where they differ.
 *
 * Byte length is a weak signal: PNG compresses, so a one-pixel change in a flat
 * region can move the file size by hundreds of bytes while a large but uniform
 * shift can leave it nearly unchanged. Two captures that differ by 4 kB might be
 * visually identical, and two that differ by 20 bytes might not be. This decodes
 * both images and reports the actual count and location of differing pixels, so
 * "parity" is decided by what the browser drew rather than by file size.
 *
 * The optional third argument writes a PNG that shows the baseline in greyscale
 * with every differing pixel in red. That is what makes the cause identifiable:
 * a red outline hugging glyph edges is anti-aliasing, while a solid red block or
 * a red edge along a box boundary is a real layout or paint difference.
 *
 * Usage: node scripts/diff-parity-shots.mjs <a.png> <b.png> [out-diff.png]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

/** Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced, one IDAT stream. */
function decodePng(buf) {
  let pos = 8; // skip signature
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${String(bitDepth)}`);
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    pos += 12 + len;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`unsupported color type ${String(colorType)}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = prev === null || x < channels ? 0 : prev[x - channels];
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode 8-bit RGB pixels as a non-interlaced PNG. */
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const [, , fileA, fileB, outDiff] = process.argv;
if (fileA === undefined || fileB === undefined) {
  console.error("usage: node scripts/diff-parity-shots.mjs <a.png> <b.png> [out-diff.png]");
  process.exit(2);
}

const a = decodePng(readFileSync(fileA));
const b = decodePng(readFileSync(fileB));

if (a.width !== b.width || a.height !== b.height) {
  console.log(`SIZE MISMATCH ${String(a.width)}x${String(a.height)} vs ${String(b.width)}x${String(b.height)}`);
  process.exit(1);
}

const { width, height } = a;
const diff = Buffer.alloc(width * height * 3);
let differing = 0;
let minX = width;
let minY = height;
let maxX = -1;
let maxY = -1;
// Differing pixels per 50-row band, so a layout shift is distinguishable from
// anti-aliasing: a shift concentrates in the bands the moved element occupies.
const bands = new Map();

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const ia = (y * width + x) * a.channels;
    const ib = (y * width + x) * b.channels;
    const same =
      a.pixels[ia] === b.pixels[ib] &&
      a.pixels[ia + 1] === b.pixels[ib + 1] &&
      a.pixels[ia + 2] === b.pixels[ib + 2];
    const o = (y * width + x) * 3;
    if (same) {
      // Baseline luminance, dimmed so red stands out.
      const grey = (a.pixels[ia] * 299 + a.pixels[ia + 1] * 587 + a.pixels[ia + 2] * 114) / 1000;
      const v = Math.min(255, Math.round(grey * 0.55) + 60);
      diff[o] = v;
      diff[o + 1] = v;
      diff[o + 2] = v;
    } else {
      diff[o] = 255;
      diff[o + 1] = 0;
      diff[o + 2] = 0;
      differing++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const band = Math.floor(y / 50) * 50;
      bands.set(band, (bands.get(band) ?? 0) + 1);
    }
  }
}

const total = width * height;
console.log(`size:      ${String(width)}x${String(height)}`);
console.log(`differing: ${String(differing)} / ${String(total)} px (${((differing / total) * 100).toFixed(4)}%)`);
if (differing > 0) {
  console.log(`bbox:      x ${String(minX)}-${String(maxX)}  y ${String(minY)}-${String(maxY)}`);
  const top = [...bands.entries()].sort((p, q) => q[1] - p[1]).slice(0, 8);
  console.log("worst bands (y, px):");
  for (const [band, count] of top) console.log(`  y ${String(band).padStart(4)}-${String(band + 49).padStart(4)}  ${String(count)}`);
}

if (outDiff !== undefined) {
  writeFileSync(outDiff, encodePng(width, height, diff));
  console.log(`diff image: ${outDiff}`);
}
