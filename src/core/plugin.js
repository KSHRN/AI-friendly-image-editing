/**
 * External process plugins.
 *
 * The core engine never links a model or an exotic library. Instead a plugin is
 * any executable that speaks a tiny JSON protocol over stdin/stdout and
 * exchanges raw RGBA8 buffers through files:
 *
 *   request  (one JSON line on stdin):
 *     { protocol: "ashop-plugin/1", op, input: {path,width,height,channels,format},
 *       output: {path}, params, project: {path,width,height}, layer: {id,name,type} }
 *
 *   response (one JSON object on stdout):
 *     { ok: true, meta?: object }        or   { ok: false, error: {code,message} }
 *
 * The plugin writes its result to `output.path` with the same dimensions.
 * Keeping pixels in files avoids base64 bloat and keeps the protocol trivial.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findLayer, makeLayer, touch } from './document.js';
import { AshopError } from './errors.js';
import { renderTextLayer, renderShapeLayer } from './vector.js';

export const PLUGIN_PROTOCOL = 'ashop-plugin/1';

function pluginRegistry(doc) {
  if (!doc.plugins) doc.plugins = {};
  return doc.plugins;
}

export function listPlugins(doc) {
  return Object.entries(pluginRegistry(doc)).map(([name, entry]) => ({
    name,
    command: entry.command,
    args: entry.args ?? [],
    description: entry.description ?? '',
    cwd: entry.cwd ?? null,
  }));
}

export function addPlugin(doc, { name, command, args = [], description = '', cwd = null }) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new AshopError('E_USAGE', `invalid plugin name: ${name}`, { hint: 'use letters, digits, dot, dash or underscore' });
  }
  if (!command) throw new AshopError('E_USAGE', 'plugin needs a --command');
  const reg = pluginRegistry(doc);
  if (reg[name]) throw new AshopError('E_PLUGIN_EXISTS', `plugin already registered: ${name}`);
  reg[name] = { command, args, description, cwd: cwd ?? process.cwd() };
  touch(doc);
  return { name, command, args, description, cwd: reg[name].cwd };
}

export function removePlugin(doc, name) {
  const reg = pluginRegistry(doc);
  if (!reg[name]) throw new AshopError('E_PLUGIN_NOT_FOUND', `no plugin named ${name}`, { hint: `known: ${Object.keys(reg).join(', ') || '(none)'}` });
  delete reg[name];
  touch(doc);
  return { removed: name };
}

async function layerImage(session, layer, ratio = 1) {
  if (layer.type === 'raster') return session.assets.readRaster(layer.content.assetId);
  if (layer.type === 'text') return (await renderTextLayer(layer.content, ratio)).raster;
  if (layer.type === 'shape') return (await renderShapeLayer(layer.content, ratio)).raster;
  throw new AshopError('E_UNSUPPORTED', `plugins can only render raster, text or shape layers (got ${layer.type})`);
}

/**
 * Run a plugin against a layer's content and write the result back.
 * @returns {Promise<{layer: object, meta: object|null}>}
 */
export async function runPlugin(session, name, { layer: layerRef, params = {} } = {}) {
  const reg = pluginRegistry(session.doc);
  const entry = reg[name];
  if (!entry) throw new AshopError('E_PLUGIN_NOT_FOUND', `no plugin named ${name}`, { hint: `known: ${Object.keys(reg).join(', ') || '(none)'}` });
  const { layer } = findLayer(session.doc, layerRef);
  const source = await layerImage(session, layer, 1);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ashop-plugin-'));
  const inputPath = path.join(tmp, 'input.rgba');
  const outputPath = path.join(tmp, 'output.rgba');
  try {
    await writeFile(inputPath, source.toBuffer());
    const request = {
      protocol: PLUGIN_PROTOCOL,
      op: 'transform',
      input: { path: inputPath, width: source.width, height: source.height, channels: 4, format: 'rgba8' },
      output: { path: outputPath, width: source.width, height: source.height, channels: 4, format: 'rgba8' },
      params,
      project: {
        path: session.projectPath,
        width: session.doc.canvas.width,
        height: session.doc.canvas.height,
      },
      layer: { id: layer.id, name: layer.name, type: layer.type },
    };
    const { stdout, stderr } = await execute(entry, request, session.projectPath);
    let response;
    try {
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
      response = JSON.parse(line);
    } catch (err) {
      throw new AshopError('E_PLUGIN_PROTOCOL', `plugin ${name} returned non-JSON output`, { details: { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) } });
    }
    if (!response.ok) {
      throw new AshopError(response.error?.code ?? 'E_PLUGIN_FAILED', response.error?.message ?? `plugin ${name} failed`, {
        details: { stderr: stderr.slice(0, 2000) },
      });
    }
    let outStat;
    try {
      outStat = await stat(outputPath);
    } catch {
      throw new AshopError('E_PLUGIN_OUTPUT', `plugin ${name} did not write its output buffer`);
    }
    if (outStat.size !== source.width * source.height * 4) {
      throw new AshopError('E_PLUGIN_OUTPUT', `plugin ${name} wrote ${outStat.size} bytes, expected ${source.width * source.height * 4}`, {
        hint: 'the output buffer must match the input dimensions',
      });
    }
    const { Raster } = await import('./raster.js');
    const raw = await readFile(outputPath);
    const out = new Raster(source.width, source.height, new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength));
    const stored = await session.assets.putRaster(out);
    const previous = layer.type;
    if (layer.type !== 'raster') {
      layer.content = { type: 'raster', assetId: stored.hash, width: out.width, height: out.height, filters: [] };
    } else {
      layer.content = { ...layer.content, assetId: stored.hash, width: out.width, height: out.height };
    }
    layer.plugins = layer.plugins ?? [];
    layer.plugins.push({ name, at: new Date().toISOString() });
    touch(session.doc);
    session.markDirty();
    session.renderer.clearCache();
    return { layer, convertedFrom: previous === 'raster' ? null : previous, meta: response.meta ?? null };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function execute(entry, request, projectPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args ?? [], {
      cwd: entry.cwd ?? projectPath ?? process.cwd(),
      windowsHide: true,
      env: { ...process.env, ASHOP_PLUGIN_PROTOCOL: PLUGIN_PROTOCOL },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new AshopError('E_PLUGIN_TIMEOUT', 'plugin timed out after 120s'));
    }, 120000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new AshopError('E_PLUGIN_SPAWN', `cannot start plugin: ${err.message}`, { hint: `command: ${entry.command}` }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AshopError('E_PLUGIN_EXIT', `plugin exited with code ${code}`, { details: { stderr: stderr.slice(0, 2000) } }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
  });
}
