/**
 * Project bundle on disk.
 *
 *   myproject.ashop/
 *     manifest.json        document + history + asset index
 *     assets/<sha256>.<ext>
 *
 * Keeping assets outside the manifest means autosave after every command only
 * rewrites a small JSON file, and identical pixels are stored exactly once.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AssetStore } from './codec.js';
import { AshopError } from './errors.js';
import { createHistory } from './history.js';
import { DOC_FORMAT, validateDocument } from './document.js';

export const BUNDLE_EXT = '.ashop';
export const MANIFEST = 'manifest.json';

export class Project {
  /**
   * @param {string} dir absolute path to the bundle directory
   * @param {{doc: object, history: object, assets: AssetStore}} state
   */
  constructor(dir, state) {
    this.dir = path.resolve(dir);
    this.doc = state.doc;
    this.history = state.history;
    this.assets = state.assets;
    this.dirty = false;
  }

  get manifestPath() {
    return path.join(this.dir, MANIFEST);
  }

  /** Create a brand new bundle. */
  static async create(dir, doc, { name } = {}) {
    const abs = path.resolve(dir);
    if (existsSync(abs)) {
      throw new AshopError('E_PROJECT_EXISTS', `project already exists: ${abs}`, { hint: 'delete it first or choose another path' });
    }
    await mkdir(abs, { recursive: true });
    if (name) doc.name = name;
    const assets = new AssetStore(path.join(abs, 'assets'));
    await assets.ensure();
    const project = new Project(abs, {
      doc,
      history: createHistory(doc),
      assets,
    });
    await project.save();
    return project;
  }

  /** Open an existing bundle. */
  static async open(dir) {
    const abs = path.resolve(dir);
    let raw;
    try {
      raw = await readFile(path.join(abs, MANIFEST), 'utf8');
    } catch (err) {
      throw new AshopError('E_PROJECT_NOT_FOUND', `no AShop project at ${abs}`, {
        hint: 'run `ashop init <width> <height>` first, or pass the right --project path',
        cause: err,
      });
    }
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      throw new AshopError('E_PROJECT_CORRUPT', `manifest.json is not valid JSON: ${abs}`, { cause: err });
    }
    if (!manifest.doc || manifest.format !== DOC_FORMAT) {
      throw new AshopError('E_PROJECT_CORRUPT', `unsupported project format in ${abs}`, {
        details: { format: manifest.format },
      });
    }
    validateDocument(manifest.doc);
    const assets = AssetStore.fromIndex(path.join(abs, 'assets'), manifest.assets ?? {});
    return new Project(abs, {
      doc: manifest.doc,
      history: manifest.history ?? createHistory(manifest.doc),
      assets,
    });
  }

  /** Atomic manifest write. */
  async save() {
    await mkdir(this.dir, { recursive: true });
    const manifest = {
      format: DOC_FORMAT,
      version: 1,
      savedAt: new Date().toISOString(),
      doc: this.doc,
      assets: this.assets.toIndex(),
      history: this.history,
    };
    const tmp = path.join(this.dir, `.manifest.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(manifest));
    await rename(tmp, this.manifestPath);
    this.dirty = false;
    return manifest;
  }
}

/** Resolve a project path from a `--project` argument or the current pointer. */
export function looksLikeProject(dir) {
  return existsSync(path.join(path.resolve(dir), MANIFEST));
}
