/**
 * Regression tests for the CLI/UX fixes:
 *   F-005  text.set must re-measure its box when --width is omitted
 *   F-006  init --background transparent must match help/schema
 *   F-008  layer operands are positional (with --layer kept for compatibility)
 *   F-011  inspect.colors hides near-transparent noise colours
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir, cli, ok, fails } from './helpers.js';

const dir = tempDir('ashop-fix-b-');
let counter = 0;

function project(name) {
  counter += 1;
  return path.join(dir, `${name}-${counter}.ashop`);
}

function init(projectPath, extra = []) {
  ok(['init', '400', '300', '--project', projectPath, ...extra]);
  return projectPath;
}

describe('F-005 text.set re-measures the text box', () => {
  it('resets to the auto-measured width when --width is omitted', () => {
    const p = init(project('text-auto'));
    const added = ok(['text', 'add', '--content', '测试', '--size', '60', '--name', 't', '--project', p]);
    const before = added.layer.content;
    assert.equal(before.width, 78, 'baseline: auto width of two CJK glyphs at size 60');
    assert.equal(before.height, 80);

    const measured = ok(['text', 'measure', '--content', '已修改', '--size', '72']);
    const edited = ok(['text', 'set', 't', '--content', '已修改', '--size', '72', '--project', p]);
    const after = edited.layer.content;

    assert.equal(after.width, measured.width, 'width follows the new text, not the stale 78px box');
    assert.equal(after.height, measured.height);
    assert.ok(after.width > before.width, 'the longer/larger text got a wider box');
    assert.ok(after.height < 200, 'text is not squeezed into a vertical column');
  });

  it('re-measures when only the size changes', () => {
    const p = init(project('text-size'));
    ok(['text', 'add', '--content', '测试', '--size', '60', '--name', 't', '--project', p]);
    const measured = ok(['text', 'measure', '--content', '测试', '--size', '120']);
    const edited = ok(['text', 'set', 't', '--size', '120', '--project', p]);
    assert.equal(edited.layer.content.width, measured.width);
    assert.equal(edited.layer.content.height, measured.height);
  });

  it('still honours an explicit --width (and wraps to it)', () => {
    const p = init(project('text-explicit'));
    ok(['text', 'add', '--content', '测试', '--size', '60', '--name', 't', '--project', p]);
    const single = ok(['text', 'measure', '--content', '测试测试测试测试', '--size', '60']);
    const edited = ok(['text', 'set', 't', '--content', '测试测试测试测试', '--width', '100', '--project', p]);
    assert.equal(edited.layer.content.width, 100, 'explicit wrap width is respected');
    assert.ok(edited.layer.content.height > single.height, 'the text actually wrapped');

    // A later call without --width goes back to auto-measuring instead of
    // keeping the 100px box (F-005's root cause).
    const measured = ok(['text', 'measure', '--content', '测试测试测试测试', '--size', '60']);
    const auto = ok(['text', 'set', 't', '--content', '测试测试测试测试', '--project', p]);
    assert.equal(auto.layer.content.width, measured.width);
  });
});

describe('F-006 init --background transparent', () => {
  it('accepts the documented "transparent" literal', () => {
    const p = project('bg-transparent');
    ok(['init', '120', '80', '--background', 'transparent', '--project', p]);
    const status = ok(['status', '--project', p]);
    assert.equal(status.canvas.background, 'transparent');
  });

  it('keeps transparent as the default when the flag is omitted', () => {
    const p = init(project('bg-default'));
    assert.equal(ok(['status', '--project', p]).canvas.background, 'transparent');
  });

  it('still accepts a colour background', () => {
    const p = project('bg-colour');
    ok(['init', '120', '80', '--background', '#112233', '--project', p]);
    assert.equal(ok(['status', '--project', p]).canvas.background, '#112233');
  });

  it('rejects an invalid background colour with E_USAGE', () => {
    const p = project('bg-invalid');
    const err = fails(['init', '120', '80', '--background', 'not-a-colour', '--project', p]);
    assert.equal(err.code, 'E_USAGE');
  });

  it('keeps help, schema and the parser in agreement', () => {
    const help = cli(['help', 'init']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--background <string> \[default: "transparent"\]/);
    assert.match(help.stdout, /transparent/);

    const data = ok(['schema']);
    assert.match(data.document.document.canvas.background, /transparent/);
    const initCmd = data.commands.find((c) => c.name === 'init');
    assert.equal(initCmd.params.background.default, 'transparent');
  });
});

describe('F-008 layer operands are positional', () => {
  const positionalCommands = [
    'style.add', 'style.remove', 'style.info',
    'filter.add', 'filter.clear',
    'mask.from-selection', 'mask.modify', 'mask.apply', 'mask.remove', 'mask.export',
    'plugin.run',
  ];

  it('declares a positional layer on every single-layer command', () => {
    const data = ok(['schema']);
    for (const name of positionalCommands) {
      const command = data.commands.find((c) => c.name === name);
      assert.ok(command, `command ${name} exists`);
      assert.equal(command.params.layer?.positional, true, `${name} takes <layer> positionally`);
    }
  });

  it('style info accepts both `style info base` and `style info --layer base`', () => {
    const p = init(project('style-info'));
    ok(['shape', 'add', 'rect', '--rect', '10,10,80,60', '--fill', '#ff0000', '--name', 'base', '--project', p]);

    const shorthand = ok(['style', 'info', 'base', '--project', p]);
    const flag = ok(['style', 'info', '--layer', 'base', '--project', p]);
    assert.equal(shorthand.layer, flag.layer);
    assert.deepEqual(shorthand.styles, flag.styles);

    const help = cli(['help', 'style.info']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /<layer> <string> \(required\)/);
    assert.match(help.stdout, /--layer also accepted/);
  });

  it('style add / remove take the layer positionally too', () => {
    const p = init(project('style-add'));
    ok(['shape', 'add', 'rect', '--rect', '10,10,80,60', '--fill', '#ff0000', '--name', 'base', '--project', p]);
    const added = ok(['style', 'add', 'drop-shadow', 'base', '--offset-y', '4', '--blur', '8', '--project', p]);
    assert.equal(added.layer, 'lyr_1');
    const info = ok(['style', 'info', 'base', '--project', p]);
    assert.equal(info.styles.length, 1);
    const removed = ok(['style', 'remove', 'base', '--type', 'drop-shadow', '--project', p]);
    assert.deepEqual(removed.styles, []);
  });

  it('filter add / clear take the layer positionally', () => {
    const p = init(project('filter'));
    ok(['shape', 'add', 'rect', '--rect', '10,10,80,60', '--fill', '#ff0000', '--name', 'base', '--project', p]);
    const added = ok(['filter', 'add', 'gaussian-blur', 'base', '--radius', '2', '--project', p]);
    assert.equal(added.layer, 'lyr_1');
    assert.equal(added.stack.length, 1);
    const cleared = ok(['filter', 'clear', 'base', '--project', p]);
    assert.deepEqual(cleared.filters, []);
  });

  it('mask from-selection takes the layer positionally', () => {
    const p = init(project('mask'));
    ok(['shape', 'add', 'rect', '--rect', '10,10,80,60', '--fill', '#ff0000', '--name', 'base', '--project', p]);
    ok(['select', 'rect', '--rect', '10,10,80,60', '--project', p]);
    const masked = ok(['mask', 'from-selection', 'base', '--feather', '1', '--project', p]);
    assert.equal(masked.layer, 'lyr_1');
  });
});

describe('F-011 inspect.colors ignores near-transparent noise', () => {
  /** Red rect + wide dark drop shadow on a transparent canvas, like the report. */
  function shadowProject(name) {
    const p = init(project(name));
    ok(['shape', 'add', 'rect', '--rect', '40,40,100,60', '--fill', '#ff0000', '--name', 'box', '--project', p]);
    ok(['style', 'add', 'drop-shadow', 'box', '--color', '#1b3f4d', '--offset-y', '10', '--blur', '20', '--project', p]);
    return p;
  }

  it('drops colours below the default min-alpha (8)', () => {
    const p = shadowProject('colors-default');
    const colors = ok(['inspect', 'colors', '--limit', '16', '--project', p]).colors;
    assert.ok(colors.length > 0);
    assert.equal(colors[0].hex, '#ff0000', 'the opaque fill stays the dominant colour');
    for (const colour of colors) {
      assert.ok(colour.rgba[3] >= 8, `${colour.hex} has alpha ${colour.rgba[3]} >= 8`);
    }
    assert.ok(!colors.some((colour) => colour.hex === '#00000000'), 'fully transparent pixels are excluded');
  });

  it('exposes --min-alpha to restore the raw view', () => {
    const p = shadowProject('colors-raw');
    const colors = ok(['inspect', 'colors', '--limit', '16', '--min-alpha', '0', '--project', p]).colors;
    assert.ok(colors.some((colour) => colour.rgba[3] === 0), '--min-alpha 0 includes transparent pixels');
    assert.ok(colors.some((colour) => colour.rgba[3] < 8), '--min-alpha 0 includes the low-alpha tail');
  });

  it('rejects an out-of-range --min-alpha', () => {
    const p = shadowProject('colors-bad');
    const err = fails(['inspect', 'colors', '--min-alpha', '300', '--project', p]);
    assert.equal(err.code, 'E_USAGE');
  });
});
