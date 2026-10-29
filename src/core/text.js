/**
 * Text layout and SVG outline generation.
 *
 * Layout is done with fontkit (real advances + kerning), and the output is
 * pure vector paths — the rasteriser never has to guess which installed font
 * family we meant.
 */

import { resolveFont } from './fonts.js';
import { parseColor } from './raster.js';

const DEFAULT_FONT_SIZE = 72;
const DEFAULT_LINE_HEIGHT = 1.2;

function measureAdvance(font, text, fontSize, letterSpacing) {
  if (!text) return 0;
  const run = font.layout(text);
  const k = fontSize / font.unitsPerEm;
  let width = run.advanceWidth * k;
  width += Math.max(0, run.glyphs.length - 1) * letterSpacing;
  return width;
}

function wrapLine(text, maxWidth, measure) {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return [text];
  const atoms = [];
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    if (measure(token) <= maxWidth) atoms.push(token);
    else for (const ch of token) atoms.push(ch);
  }
  const lines = [];
  let current = '';
  for (const atom of atoms) {
    if (!current) {
      current = atom;
      continue;
    }
    if (measure(current + atom) <= maxWidth) current += atom;
    else {
      lines.push(current.replace(/\s+$/, ''));
      current = atom.replace(/^\s+/, '');
    }
  }
  lines.push(current.replace(/\s+$/, ''));
  return lines;
}

/**
 * @param {object} content text layer content
 * @param {object} font fontkit font
 */
export function layoutText(content, font) {
  const fontSize = Number(content.size ?? DEFAULT_FONT_SIZE);
  if (!(fontSize > 0)) throw new Error('text size must be > 0');
  const lineHeightMul = Number(content.lineHeight ?? DEFAULT_LINE_HEIGHT);
  const letterSpacing = Number(content.letterSpacing ?? 0);
  const wrapWidth = content.width != null && Number(content.width) > 0 ? Number(content.width) : Infinity;
  const measure = (t) => measureAdvance(font, t, fontSize, letterSpacing);

  const paragraphs = String(content.text ?? '').split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    const wrapped = wrapLine(para, wrapWidth, measure);
    for (const l of wrapped) lines.push(l);
  }
  const widths = lines.map((l) => measure(l));
  const maxLineWidth = widths.reduce((a, b) => Math.max(a, b), 0);
  const k = fontSize / font.unitsPerEm;
  const ascent = (font.ascent ?? font.unitsPerEm * 0.8) * k;
  const descent = Math.abs(font.descent ?? font.unitsPerEm * 0.2) * k;
  const lineHeight = fontSize * lineHeightMul;
  const height = (lines.length - 1) * lineHeight + ascent + descent;
  const boxWidth = Number.isFinite(wrapWidth) && wrapWidth > 0 ? wrapWidth : Math.max(1, maxLineWidth);

  return { lines, widths, maxLineWidth, boxWidth, height, ascent, descent, lineHeight, fontSize, letterSpacing };
}

function glyphPath(glyphs, startX, baseline, k, letterSpacing) {
  let x = startX;
  const parts = [];
  for (const glyph of glyphs) {
    for (const cmd of glyph.path.commands) {
      const v = cmd.args;
      switch (cmd.command) {
        case 'moveTo':
          parts.push(`M${r(x + v[0] * k)},${r(baseline - v[1] * k)}`);
          break;
        case 'lineTo':
          parts.push(`L${r(x + v[0] * k)},${r(baseline - v[1] * k)}`);
          break;
        case 'quadraticCurveTo':
          parts.push(`Q${r(x + v[0] * k)},${r(baseline - v[1] * k)} ${r(x + v[2] * k)},${r(baseline - v[3] * k)}`);
          break;
        case 'bezierCurveTo':
          parts.push(`C${r(x + v[0] * k)},${r(baseline - v[1] * k)} ${r(x + v[2] * k)},${r(baseline - v[3] * k)} ${r(x + v[4] * k)},${r(baseline - v[5] * k)}`);
          break;
        case 'closePath':
          parts.push('Z');
          break;
        default:
          break;
      }
    }
    x += glyph.advanceWidth * k + letterSpacing;
  }
  return parts.join(' ');
}

const r = (v) => Math.round(v * 100) / 100;

function hex(rgba) {
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(rgba[0])}${h(rgba[1])}${h(rgba[2])}`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build an SVG that draws the text with its own outlines.
 * @returns {{svg: string, width: number, height: number, layout: object}}
 */
export function textToSvg(content, font, ratio = 1) {
  const layout = layoutText(content, font);
  const fill = parseColor(content.color ?? '#000000');
  const stroke = content.stroke && Number(content.stroke.width) > 0 ? content.stroke : null;
  const strokeColor = stroke ? parseColor(stroke.color ?? '#000000') : null;
  const pad = stroke ? Math.ceil(Number(stroke.width) / 2) + 1 : 0;
  const boxW = Math.max(1, Math.ceil(layout.boxWidth) + pad * 2);
  const boxH = Math.max(1, Math.ceil(layout.height) + pad * 2);
  const k = layout.fontSize / font.unitsPerEm;
  const align = content.align ?? 'left';

  const body = [];
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    if (!line) continue;
    const lineWidth = layout.widths[i];
    let x = pad;
    if (align === 'center') x += (layout.boxWidth - lineWidth) / 2;
    else if (align === 'right') x += layout.boxWidth - lineWidth;
    const baseline = pad + layout.ascent + i * layout.lineHeight;
    const run = font.layout(line);
    const d = glyphPath(run.glyphs, x, baseline, k, layout.letterSpacing);
    if (d) body.push(d);
  }
  const fillOpacity = (fill[3] / 255).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const paths = [];
  if (stroke && strokeColor) {
    paths.push(`<path d="${body.join(' ')}" fill="none" stroke="${hex(strokeColor)}" stroke-opacity="${(strokeColor[3] / 255).toFixed(3)}" stroke-width="${Number(stroke.width)}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  paths.push(`<path d="${body.join(' ')}" fill="${hex(fill)}" fill-opacity="${fillOpacity}" fill-rule="nonzero"/>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r(boxW * ratio)}" height="${r(boxH * ratio)}" viewBox="0 0 ${boxW} ${boxH}">${paths.join('')}</svg>`;
  return { svg, width: boxW, height: boxH, layout };
}

/** Resolve and cache the font, then produce both SVG and measured size. */
export function buildTextContent(content, ratio = 1) {
  const resolved = resolveFont({
    family: content.font,
    file: content.fontFile,
    weight: content.weight ?? 400,
    italic: content.italic ?? false,
  });
  const result = textToSvg(content, resolved.font, ratio);
  return { ...result, font: resolved };
}

/** Width/height of a text box without rasterising (used by `text measure`). */
export function measureText(content) {
  const resolved = resolveFont({
    family: content.font,
    file: content.fontFile,
    weight: content.weight ?? 400,
    italic: content.italic ?? false,
  });
  const layout = layoutText(content, resolved.font);
  return {
    width: Math.ceil(layout.boxWidth),
    height: Math.ceil(layout.height),
    lines: layout.lines,
    lineWidths: layout.widths,
    ascent: layout.ascent,
    descent: layout.descent,
    lineHeight: layout.lineHeight,
  };
}
