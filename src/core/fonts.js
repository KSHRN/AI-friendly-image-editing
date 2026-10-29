/**
 * Font discovery and resolution.
 *
 * The layout/rasterisation path never relies on fontconfig matching: we find
 * an actual font file, shape the text with fontkit, and hand the resulting
 * glyph outlines to resvg. That keeps rendering identical on every machine
 * that has the same font file.
 */

import { openSync } from 'fontkit';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AshopError } from './errors.js';

const FONT_EXTS = /\.(ttf|otf|ttc|otc)$/i;
const CACHE_VERSION = 3;
const loadedFonts = new Map();
let indexCache = null;

const WEIGHT_WORDS = ['regular', 'bold', 'italic', 'oblique', 'light', 'semilight', 'semibold', 'demibold', 'black', 'heavy', 'thin', 'medium', 'book', 'condensed', 'display', 'demi'];

export function fontDirs() {
  if (process.env.ASHOP_FONT_DIRS) return process.env.ASHOP_FONT_DIRS.split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    return [
      'C:\\Windows\\Fonts',
      path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Microsoft', 'Windows', 'Fonts'),
    ].filter((d) => existsSync(d));
  }
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')].filter((d) => existsSync(d));
  }
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local', 'share', 'fonts'),
  ].filter((d) => existsSync(d));
}

export function cacheDir() {
  if (process.env.ASHOP_CACHE_DIR) return process.env.ASHOP_CACHE_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ashop', 'cache');
  return path.join(os.homedir(), '.cache', 'ashop');
}

function dirSignature(dirs) {
  return dirs.map((d) => {
    try {
      return `${d}@${statSync(d).mtimeMs}`;
    } catch {
      return `${d}@missing`;
    }
  }).join('|');
}

function walkFonts(dir, depth = 0, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 3) walkFonts(full, depth + 1, out);
    } else if (FONT_EXTS.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function normalizeFamily(name) {
  let s = String(name).trim().replace(/\s+/g, ' ');
  let changed = true;
  while (changed) {
    changed = false;
    const lower = s.toLowerCase();
    for (const w of WEIGHT_WORDS) {
      if (lower.endsWith(' ' + w)) {
        s = s.slice(0, s.length - w.length - 1).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

function describeFace(font, file, faceIndex) {
  const os2 = font['OS/2'];
  const weight = os2?.usWeightClass ?? (/(bold|black|heavy)/i.test(font.subfamilyName ?? '') ? 700 : 400);
  const sub = font.subfamilyName ?? '';
  const italic = /italic|oblique/i.test(sub) || (font.italicAngle ?? 0) !== 0;
  const family = font.familyName ?? path.basename(file, path.extname(file));
  return {
    path: file,
    faceIndex,
    family,
    baseFamily: normalizeFamily(family),
    subfamily: sub,
    weight,
    italic,
    fullName: font.fullName ?? `${family} ${sub}`.trim(),
  };
}

/** Build (or reuse) the machine font index. */
export function buildFontIndex({ force = false, quiet = true } = {}) {
  if (indexCache && !force) return indexCache;
  const dirs = fontDirs();
  const signature = dirSignature(dirs);
  const cacheFile = path.join(cacheDir(), `fonts-v${CACHE_VERSION}.json`);
  if (!force) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.version === CACHE_VERSION && cached.signature === signature) {
        indexCache = cached;
        return indexCache;
      }
    } catch {
      // no usable cache
    }
  }
  const started = Date.now();
  const faces = [];
  for (const dir of dirs) {
    for (const file of walkFonts(dir)) {
      try {
        const opened = openSync(file);
        if (opened && Array.isArray(opened.fonts)) {
          opened.fonts.forEach((f, i) => faces.push(describeFace(f, file, i)));
        } else if (opened) {
          faces.push(describeFace(opened, file, 0));
        }
      } catch {
        // A single corrupt font file must not break discovery.
      }
    }
  }
  const families = {};
  for (const face of faces) {
    for (const key of new Set([face.family.toLowerCase(), face.baseFamily.toLowerCase()])) {
      (families[key] ??= []).push(face);
    }
  }
  indexCache = {
    version: CACHE_VERSION,
    signature,
    dirs,
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    faces,
    families,
  };
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(indexCache));
  } catch {
    // Caching is best-effort.
  }
  return indexCache;
}

function pickFace(faces, weight = 400, italic = false) {
  let best = null;
  let bestScore = Infinity;
  for (const f of faces) {
    let score = Math.abs((f.weight ?? 400) - weight) / 100;
    if (italic && !f.italic) score += 2;
    if (!italic && f.italic) score += 0.4;
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

function openFace(entry) {
  const key = `${entry.path}#${entry.faceIndex}`;
  if (loadedFonts.has(key)) return loadedFonts.get(key);
  const opened = openSync(entry.path);
  const font = Array.isArray(opened.fonts) ? opened.fonts[entry.faceIndex] ?? opened.fonts[0] : opened;
  loadedFonts.set(key, font);
  return font;
}

/**
 * Resolve a font spec to a concrete face.
 * @param {{family?: string, file?: string, weight?: number, italic?: boolean}} spec
 */
export function resolveFont({ family, file, weight = 400, italic = false } = {}) {
  if (file) {
    const abs = path.resolve(file);
    if (!existsSync(abs)) {
      throw new AshopError('E_FONT_NOT_FOUND', `font file not found: ${abs}`, { hint: 'pass an absolute path or a system font family name' });
    }
    let opened;
    try {
      opened = openSync(abs);
    } catch (err) {
      throw new AshopError('E_FONT_NOT_FOUND', `cannot read font file: ${abs}`, { cause: err });
    }
    const faces = Array.isArray(opened.fonts) ? opened.fonts : [opened];
    const described = faces.map((f, i) => describeFace(f, abs, i));
    const chosen = pickFace(described, weight, italic);
    return { font: openFace(chosen), entry: chosen, family: chosen.family, source: 'file' };
  }

  const index = buildFontIndex();
  const key = String(family ?? '').trim().toLowerCase();
  let candidates = index.families[key];
  if (!candidates) {
    // Try base-family match plus a forgiving prefix search.
    candidates = index.faces.filter((f) => f.baseFamily.toLowerCase().startsWith(key) && key.length >= 3);
  }
  if ((!candidates || candidates.length === 0) && !family) {
    candidates = index.families['segoe ui'] ?? index.families['arial'] ?? index.families['dejavu sans'] ?? index.faces;
  }
  if (!candidates || candidates.length === 0) {
    const near = [...new Set(index.faces.map((f) => f.family))].filter((f) => f.toLowerCase().includes(key)).slice(0, 8);
    throw new AshopError('E_FONT_NOT_FOUND', `no installed font matches family "${family}"`, {
      hint: 'run `ashop fonts list` to see available families, or pass --font-file <path>',
      details: { near },
    });
  }
  const chosen = pickFace(candidates, weight, italic);
  return { font: openFace(chosen), entry: chosen, family: chosen.family, source: 'system' };
}

/** Public listing for `ashop fonts list`. */
export function listFonts({ filter, limit = 200 } = {}) {
  const index = buildFontIndex();
  const seen = new Set();
  const out = [];
  for (const face of index.faces) {
    const key = face.family.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (filter && !key.includes(String(filter).toLowerCase())) continue;
    out.push({ family: face.family, weight: face.weight, italic: face.italic, subfamily: face.subfamily, path: face.path });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.family.localeCompare(b.family));
  return out;
}

/** Remove a single face from the in-process cache (tests). */
export function clearFontCaches() {
  loadedFonts.clear();
  indexCache = null;
}
