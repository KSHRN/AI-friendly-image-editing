import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

import { importSvg } from '../src/core/svgimport.js';
import { AshopError } from '../src/core/errors.js';
import { tempDir, ok } from './helpers.js';

const solid = (shape, index = 0) => shape.fills[index];

describe('svg import — geometry and paint', () => {
  it('parses rect/circle/ellipse/polygon/path geometry and fills', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
      <rect x="10" y="20" width="30" height="40" fill="#ff0000"/>
      <circle cx="100" cy="50" r="10" fill="#00ff00"/>
      <ellipse cx="150" cy="50" rx="20" ry="10" fill="#0000ff"/>
      <polygon points="170,10 190,10 180,30" fill="#123456"/>
      <path d="M 0 0 L 10 10" fill="none" stroke="#000000" stroke-width="2"/>
    </svg>`;

    const { content, width, height, viewBox, warnings } = await importSvg(svg);
    assert.deepEqual(warnings, []);
    assert.equal(width, 200);
    assert.equal(height, 100);
    assert.deepEqual(viewBox, { x: 0, y: 0, width: 200, height: 100 });
    assert.equal(content.type, 'shape');
    assert.equal(content.version, 2);
    assert.deepEqual(content.fills, []);
    assert.deepEqual(content.strokes, []);
    assert.equal(content.shapes.length, 5);

    const [rect, circle, ellipse, polygon, pathShape] = content.shapes;
    assert.deepEqual(
      { kind: rect.kind, x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      { kind: 'rect', x: 10, y: 20, width: 30, height: 40 },
    );
    assert.deepEqual(solid(rect), { type: 'solid', color: '#ff0000', opacity: 1 });

    assert.deepEqual(
      { kind: circle.kind, cx: circle.cx, cy: circle.cy, rx: circle.rx, ry: circle.ry },
      { kind: 'ellipse', cx: 100, cy: 50, rx: 10, ry: 10 },
    );
    assert.deepEqual(
      { cx: ellipse.cx, cy: ellipse.cy, rx: ellipse.rx, ry: ellipse.ry },
      { cx: 150, cy: 50, rx: 20, ry: 10 },
    );

    assert.equal(polygon.kind, 'polygon');
    assert.deepEqual(polygon.points, [{ x: 170, y: 10 }, { x: 190, y: 10 }, { x: 180, y: 30 }]);
    assert.equal(solid(polygon).color, '#123456');

    assert.equal(pathShape.kind, 'path');
    assert.equal(pathShape.d, 'M 0 0 L 10 10');
    assert.deepEqual(pathShape.fills, []);
    assert.equal(pathShape.strokes.length, 1);
    assert.equal(pathShape.strokes[0].paint.color, '#000000');
    assert.equal(pathShape.strokes[0].width, 2);
  });
});

describe('svg import — gradients', () => {
  it('maps linear/radial gradients onto canonical paints and degrades userSpaceOnUse', async () => {
    const svg = `<svg width="100" height="100" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#ff0000"/>
          <stop offset="100%" stop-color="#0000ff" stop-opacity="0.5"/>
        </linearGradient>
        <radialGradient id="rg" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="1" stop-color="#000000"/>
        </radialGradient>
        <linearGradient id="us" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
          <stop offset="0" stop-color="#ff0000"/>
          <stop offset="1" stop-color="#0000ff"/>
        </linearGradient>
      </defs>
      <rect width="40" height="40" fill="url(#lg)"/>
      <circle cx="50" cy="50" r="20" fill="url(#rg)"/>
      <rect x="60" y="60" width="20" height="20" fill="url(#us)"/>
    </svg>`;

    const { content, warnings } = await importSvg(svg);
    const [linearShape, radialShape, degradedShape] = content.shapes;

    const linear = solid(linearShape);
    assert.equal(linear.type, 'linear-gradient');
    assert.deepEqual(linear.from, { x: 0, y: 0 });
    assert.deepEqual(linear.to, { x: 1, y: 0 });
    assert.deepEqual(linear.stops, [
      { offset: 0, color: '#ff0000', opacity: 1 },
      { offset: 1, color: '#0000ff', opacity: 0.5 },
    ]);

    const radial = solid(radialShape);
    assert.equal(radial.type, 'radial-gradient');
    assert.deepEqual(radial.center, { x: 0.5, y: 0.5 });
    assert.equal(radial.radius, 0.5);
    assert.equal(radial.stops.length, 2);

    assert.deepEqual(solid(degradedShape), { type: 'solid', color: '#ff0000', opacity: 1 });
    assert.ok(warnings.some((w) => /userSpaceOnUse/.test(w)), 'userSpaceOnUse must warn');
  });
});

describe('svg import — transforms', () => {
  it('accumulates nested group transforms onto each shape', async () => {
    const svg = `<svg width="100" height="100" viewBox="0 0 100 100">
      <g transform="translate(10,20)">
        <g transform="scale(2)">
          <rect x="1" y="2" width="3" height="4" fill="#ff0000"/>
        </g>
      </g>
    </svg>`;

    const { content } = await importSvg(svg);
    assert.equal(content.shapes.length, 1);
    assert.deepEqual(content.shapes[0].transform, [2, 0, 0, 2, 10, 20]);
    // Geometry stays in viewBox units; only the transform carries the mapping.
    assert.equal(content.shapes[0].x, 1);
    assert.equal(content.shapes[0].width, 3);
  });

  it('folds the viewBox offset and scale into the shape transform', async () => {
    const svg = `<svg width="200" height="100" viewBox="10 20 100 50">
      <rect x="10" y="20" width="10" height="10" fill="#ff0000"/>
    </svg>`;

    const { content, viewBox } = await importSvg(svg);
    assert.deepEqual(viewBox, { x: 10, y: 20, width: 100, height: 50 });
    assert.deepEqual(content.shapes[0].transform, [2, 0, 0, 2, -20, -40]);
  });
});

describe('svg import — inheritance', () => {
  it('inherits presentation attributes and lets style / explicit attributes override', async () => {
    const svg = `<svg width="100" height="100" viewBox="0 0 100 100">
      <g fill="#ff0000" stroke="#000000" stroke-width="3" opacity="0.5">
        <rect x="0" y="0" width="10" height="10"/>
        <rect x="20" y="0" width="10" height="10" style="fill:#00ff00;stroke:none"/>
        <rect x="40" y="0" width="10" height="10" fill="#0000ff"/>
      </g>
    </svg>`;

    const { content } = await importSvg(svg);
    const [inherited, styled, overridden] = content.shapes;

    assert.equal(solid(inherited).color, '#ff0000');
    assert.equal(inherited.strokes[0].paint.color, '#000000');
    assert.equal(inherited.strokes[0].width, 3);
    assert.equal(inherited.opacity, 0.5);

    assert.equal(solid(styled).color, '#00ff00');
    assert.equal(styled.strokes, undefined, 'style="stroke:none" disables the inherited stroke');

    assert.equal(solid(overridden).color, '#0000ff');
    assert.equal(overridden.strokes[0].paint.color, '#000000', 'stroke is still inherited');
    assert.equal(overridden.opacity, 0.5);
  });
});

describe('svg import — unsupported content', () => {
  it('warns about unsupported elements instead of throwing', async () => {
    const svg = `<svg width="10" height="10" viewBox="0 0 10 10">
      <title>title</title>
      <desc>description</desc>
      <metadata>meta</metadata>
      <text x="0" y="0">hello</text>
      <image href="photo.png"/>
      <use href="#symbol"/>
      <clipPath id="clip"><rect width="10" height="10"/></clipPath>
      <rect width="10" height="10" fill="#ff0000"/>
    </svg>`;

    const { content, warnings } = await importSvg(svg);
    assert.equal(content.shapes.length, 1);
    assert.equal(solid(content.shapes[0]).color, '#ff0000');
    for (const tag of ['<text>', '<image>', '<use>', '<clipPath>']) {
      assert.ok(warnings.some((w) => w.includes(tag)), `expected a warning for ${tag}, got ${JSON.stringify(warnings)}`);
    }
    assert.ok(
      !warnings.some((w) => /<(title|desc|metadata)>/.test(w)),
      'title/desc/metadata are ignored silently',
    );
  });
});

describe('svg import — tolerant XML', () => {
  it('handles comments, CDATA, DOCTYPE, entities and physical units', async () => {
    const svg = `<?xml version="1.0"?>
<!DOCTYPE svg [ <!ENTITY note "x"> ]>
<!-- a comment with <not-a-tag> inside -->
<svg width="2in" height="1in" viewBox="0 0 192 96">
  <desc><![CDATA[ <text>this is not parsed</text> ]]></desc>
  <rect width="50%" height="50%" fill='#ff0000' data-note="a &amp; b &#65; &#x42;"/>
</svg>`;

    const { content, width, height, warnings } = await importSvg(svg);
    assert.deepEqual(warnings, []);
    assert.equal(width, 192);
    assert.equal(height, 96);
    assert.equal(content.shapes.length, 1);
    assert.equal(content.shapes[0].width, 96);
    assert.equal(content.shapes[0].height, 48);
  });
});

describe('svg import — CLI', () => {
  it('imports a file as a layer and renders it', async () => {
    const dir = tempDir('ashop-svg-');
    const svgFile = path.join(dir, 'logo.svg');
    writeFileSync(svgFile, `<svg width="120" height="80" viewBox="0 0 120 80">
      <rect x="4" y="4" width="50" height="30" fill="#ff0000"/>
      <circle cx="90" cy="40" r="20" fill="#0000ff"/>
    </svg>`);
    const project = path.join(dir, 'svg.ashop');
    ok(['init', '320', '240', '--project', project]);

    const imported = ok(['shape', 'import', svgFile, '--name', 'logo', '--at', '10,20', '--scale', '2', '--project', project]);
    assert.equal(imported.shapes, 2);
    assert.ok(imported.layer?.id);
    assert.equal(imported.layer.name, 'logo');
    assert.equal(imported.layer.type, 'shape');

    const list = ok(['layer', 'list', '--project', project]);
    const layer = list.layers.find((entry) => entry.id === imported.layer.id);
    assert.ok(layer, 'imported layer should be listed');
    assert.equal(layer.name, 'logo');

    const out = path.join(dir, 'render.png');
    const rendered = ok(['render', out, '--project', project]);
    assert.ok(existsSync(out));
    assert.equal(rendered.file, out);
    assert.equal(rendered.width, 320);
    assert.equal(rendered.height, 240);

    // The imported fill must survive addShapeLayer and reach the compositor:
    // content (10,10) at layer offset (10,20) and scale 2 lands on canvas (30,40).
    const pixel = ok(['inspect', 'pixel', '--at', '30,40', '--project', project]);
    assert.equal(pixel.hex, '#ff0000');
  });
});

describe('svg import — errors', () => {
  function isSvgParseError(err) {
    assert.ok(err instanceof AshopError, `expected AshopError, got ${err?.constructor?.name}`);
    assert.equal(err.code, 'E_SVG_PARSE');
    assert.ok(err.hint, 'E_SVG_PARSE should carry a hint');
    return true;
  }

  it('throws E_SVG_PARSE for malformed XML', async () => {
    await assert.rejects(() => importSvg('<svg width="10" height="10"><rect></svg>'), isSvgParseError);
    await assert.rejects(() => importSvg('this is not xml at all'), isSvgParseError);
    await assert.rejects(() => importSvg('<html><body/></html>'), isSvgParseError);
    await assert.rejects(
      () => importSvg('<svg width="10" height="10" viewBox="0 0 0 0"><rect width="1" height="1"/></svg>'),
      isSvgParseError,
    );
  });
});
