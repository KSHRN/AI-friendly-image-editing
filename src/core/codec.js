/**
 * Content-addressed asset store + image codec.
 *
 * A project bundle keeps every binary blob under `assets/<sha256>.<ext>`, so
 * identical layers never double-store bytes and history snapshots stay cheap.
 * Encoding is pinned (PNG: no palette, fixed compression; JPEG: 4:4:4) so the
 * same pixels always produce the same file bytes.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Raster } from './raster.js';
import { Mask } from './mask.js';
import { AshopError } from './errors.js';

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

const MAGIC = [
  { ext: 'png', mediaType: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mediaType: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mediaType: 'image/webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: 'gif', mediaType: 'image/gif', test: (b) => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8' },
  { ext: 'tif', mediaType: 'image/tiff', test: (b) => b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) },
  { ext: 'bmp', mediaType: 'image/bmp', test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
];

export function detectMediaType(buffer) {
  for (const m of MAGIC) if (m.test(buffer)) return { ext: m.ext, mediaType: m.mediaType };
  return null;
}

/** Decode any supported image into a straight-alpha RGBA Raster. */
export async function decodeToRaster(buffer) {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate() // honour EXIF orientation deterministically
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new AshopError('E_DECODE', `unexpected channel count after decode: ${info.channels}`);
  }
  return new Raster(info.width, info.height, new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength));
}

/** Decode a file on disk. */
export async function decodeFile(file) {
  let buf;
  try {
    buf = await readFile(file);
  } catch (err) {
    throw new AshopError('E_FILE_NOT_FOUND', `cannot read image: ${file}`, { hint: 'check the path and permissions', cause: err });
  }
  try {
    return await decodeToRaster(buf);
  } catch (err) {
    if (err instanceof AshopError) throw err;
    throw new AshopError('E_DECODE', `cannot decode image: ${file}`, { cause: err });
  }
}

/** Encode a Raster to file bytes. Deterministic for a fixed codec config. */
export async function encodeRaster(raster, { format = 'png', quality = 90, background = null } = {}) {
  const raw = raster.toBuffer();
  let img = sharp(raw, { raw: { width: raster.width, height: raster.height, channels: 4 } });
  const fmt = format.toLowerCase();
  switch (fmt) {
    case 'png':
      return img.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
    case 'jpg':
    case 'jpeg':
      return img
        .flatten(background ? { background } : { background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: false })
        .toBuffer();
    case 'webp':
      return img.webp({ quality, lossless: false, smartSubsample: false }).toBuffer();
    case 'avif':
      return img.avif({ quality }).toBuffer();
    case 'tiff':
      return img.tiff({ compression: 'lzw' }).toBuffer();
    case 'raw':
      return raw;
    default:
      throw new AshopError('E_FORMAT', `unsupported output format: ${format}`, { hint: 'use png, jpeg, webp, avif or tiff' });
  }
}

export async function encodeMaskPng(mask) {
  const data = Buffer.from(mask.data.buffer, mask.data.byteOffset, mask.data.byteLength);
  return sharp(data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
    .toColourspace('b-w')
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

export async function decodeMaskPng(buffer) {
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  return new Mask(info.width, info.height, new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength));
}

/**
 * Content-addressed blob store inside a project bundle.
 * All writes are atomic (tmp + rename) and idempotent by content hash.
 */
export class AssetStore {
  /** @param {string} dir absolute path to `<project>/assets` */
  constructor(dir) {
    this.dir = dir;
    this.mediaTypes = new Map(); // hash -> mediaType
    this.rasterCache = new Map();
    this.maskCache = new Map();
  }

  fileFor(hash, ext) {
    return path.join(this.dir, `${hash}.${ext}`);
  }

  async ensure() {
    await mkdir(this.dir, { recursive: true });
  }

  /** Store raw bytes and return their content hash. */
  async put(buffer, mediaType) {
    const hash = sha256Hex(buffer);
    const ext = extForMediaType(mediaType);
    const file = this.fileFor(hash, ext);
    await this.ensure();
    try {
      await access(file);
    } catch {
      await writeFile(file, buffer);
    }
    this.mediaTypes.set(hash, mediaType);
    return { hash, mediaType, bytes: buffer.length };
  }

  async putRaster(raster) {
    const png = await encodeRaster(raster, { format: 'png' });
    return this.put(png, 'image/png');
  }

  async putMask(mask) {
    const png = await encodeMaskPng(mask);
    return this.put(png, 'image/x-ashop-mask');
  }

  async read(hash) {
    const mediaType = this.mediaTypes.get(hash) ?? 'application/octet-stream';
    const ext = extForMediaType(mediaType);
    try {
      return await readFile(this.fileFor(hash, ext));
    } catch {
      // Fall back to scanning for any extension: manifests from other tools may
      // only carry the hash.
      const entries = await readdir(this.dir).catch(() => []);
      const hit = entries.find((f) => f.startsWith(hash + '.'));
      if (!hit) throw new AshopError('E_ASSET_MISSING', `asset not found: ${hash}`, { hint: 'the project bundle may be incomplete' });
      return readFile(path.join(this.dir, hit));
    }
  }

  async readRaster(hash) {
    if (this.rasterCache.has(hash)) return this.rasterCache.get(hash);
    const buf = await this.read(hash);
    const raster = await decodeToRaster(buf);
    this.rasterCache.set(hash, raster);
    return raster;
  }

  async readMask(hash) {
    if (this.maskCache.has(hash)) return this.maskCache.get(hash);
    const buf = await this.read(hash);
    const mediaType = this.mediaTypes.get(hash);
    let mask;
    if (mediaType === 'image/x-ashop-mask') mask = await decodeMaskPng(buf);
    else mask = Mask.fromRasterAlpha(await decodeToRaster(buf));
    this.maskCache.set(hash, mask);
    return mask;
  }

  remember(hash, mediaType) {
    this.mediaTypes.set(hash, mediaType);
  }

  /** Serialisable index for the project manifest. */
  toIndex() {
    /** @type {Record<string, {mediaType: string}>} */
    const out = {};
    for (const [hash, mediaType] of [...this.mediaTypes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[hash] = { mediaType };
    }
    return out;
  }

  static fromIndex(dir, index = {}) {
    const store = new AssetStore(dir);
    for (const [hash, meta] of Object.entries(index)) store.remember(hash, meta.mediaType);
    return store;
  }
}

export function extForMediaType(mediaType) {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/tiff': return 'tif';
    case 'image/bmp': return 'bmp';
    case 'image/x-ashop-mask': return 'mask.png';
    default: return 'bin';
  }
}
