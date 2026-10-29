/**
 * Git-like history: a DAG of commits, each storing a full document snapshot.
 *
 * Snapshots are cheap because pixel data lives in the content-addressed asset
 * store — a commit only contains the JSON layer tree. That makes checkout and
 * reset exact by construction.
 */

import { createHash } from 'node:crypto';
import { AshopError } from './errors.js';

export const INITIAL_MESSAGE = 'init';

function commitId(doc, parent, message, ts) {
  return 'c_' + createHash('sha256')
    .update(JSON.stringify(doc))
    .update(parent ?? '')
    .update(message ?? '')
    .update(ts)
    .digest('hex')
    .slice(0, 12);
}

export function createHistory(doc, message = INITIAL_MESSAGE) {
  const ts = new Date().toISOString();
  const id = commitId(doc, null, message, ts);
  return {
    head: id,
    currentBranch: 'main',
    branches: { main: id },
    commits: {
      [id]: { id, parent: null, message, ts, doc: structuredClone(doc) },
    },
  };
}

export function headCommit(history) {
  return history.commits[history.head] ?? null;
}

export function commit(history, doc, message = '') {
  const parent = history.head;
  const ts = new Date().toISOString();
  const id = commitId(doc, parent, message, ts);
  history.commits[id] = { id, parent, message, ts, doc: structuredClone(doc) };
  history.head = id;
  if (history.currentBranch) history.branches[history.currentBranch] = id;
  return history.commits[id];
}

export function branches(history) {
  return Object.entries(history.branches).map(([name, id]) => ({ name, commit: id, current: name === history.currentBranch }));
}

export function resolveRef(history, ref = 'HEAD') {
  if (!ref || ref === 'HEAD' || ref === '@') return history.head;
  const tilde = /^(.*?)(?:~(\d+))$/.exec(String(ref));
  if (tilde) {
    let id = resolveRef(history, tilde[1] || 'HEAD');
    let n = Number(tilde[2]);
    while (n-- > 0) {
      const c = history.commits[id];
      if (!c || !c.parent) {
        throw new AshopError('E_HISTORY', `cannot go back ${tilde[2]} commits from ${tilde[1]}`, { hint: 'not enough history' });
      }
      id = c.parent;
    }
    return id;
  }
  if (history.branches[ref]) return history.branches[ref];
  if (history.commits[ref]) return ref;
  const matches = Object.keys(history.commits).filter((id) => id.startsWith(String(ref)));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new AshopError('E_HISTORY_AMBIGUOUS', `ref "${ref}" matches ${matches.length} commits`, { details: { matches } });
  }
  throw new AshopError('E_REF_NOT_FOUND', `unknown ref: ${ref}`, {
    hint: 'use a branch name, a commit id, or HEAD~n',
    details: { branches: Object.keys(history.branches) },
  });
}

export function log(history, { limit = 20 } = {}) {
  const out = [];
  let id = history.head;
  while (id && out.length < limit) {
    const c = history.commits[id];
    if (!c) break;
    out.push({ id: c.id, parent: c.parent, message: c.message, ts: c.ts, branch: history.branches[history.currentBranch] === c.id ? history.currentBranch : null });
    id = c.parent;
  }
  return out;
}

export function docAt(history, ref) {
  const id = resolveRef(history, ref);
  const c = history.commits[id];
  if (!c) throw new AshopError('E_REF_NOT_FOUND', `unknown commit: ${ref}`);
  return { commit: c, doc: structuredClone(c.doc) };
}

/** Move the current branch (or detached head) to `ref` and return its doc. */
export function resetHard(history, ref) {
  const id = resolveRef(history, ref);
  if (!history.commits[id]) throw new AshopError('E_REF_NOT_FOUND', `unknown commit: ${ref}`);
  history.head = id;
  if (history.currentBranch) history.branches[history.currentBranch] = id;
  return structuredClone(history.commits[id].doc);
}

/** Create a branch at HEAD and switch to it. */
export function createBranch(history, name, { checkout = true } = {}) {
  if (!name || !/^[A-Za-z0-9._\/-]+$/.test(name)) {
    throw new AshopError('E_USAGE', `invalid branch name: ${name}`, { hint: 'use letters, digits, dot, dash, slash or underscore' });
  }
  if (history.branches[name]) throw new AshopError('E_BRANCH_EXISTS', `branch already exists: ${name}`);
  history.branches[name] = history.head;
  if (checkout) history.currentBranch = name;
  return { name, commit: history.head };
}

export function checkout(history, ref) {
  const id = resolveRef(history, ref);
  history.head = id;
  const branch = Object.keys(history.branches).find((b) => history.branches[b] === id && b === ref);
  history.currentBranch = branch ?? null;
  return { commit: id, branch: branch ?? null, doc: structuredClone(history.commits[id].doc) };
}

/** Structural comparison between two documents (for `history diff`). */
export function diffDocuments(a, b) {
  const flat = (doc) => {
    const map = new Map();
    const walk = (layers, parent) => {
      for (const l of layers) {
        map.set(l.id, { layer: l, parent });
        if (l.children) walk(l.children, l.id);
      }
    };
    walk(doc.layers, null);
    return map;
  };
  const A = flat(a), B = flat(b);
  const added = [...B.keys()].filter((id) => !A.has(id));
  const removed = [...A.keys()].filter((id) => !B.has(id));
  const changed = [];
  for (const [id, entry] of B) {
    const prev = A.get(id);
    if (!prev) continue;
    if (JSON.stringify(prev.layer) !== JSON.stringify(entry.layer)) changed.push(id);
  }
  return {
    canvasChanged: JSON.stringify(a.canvas) !== JSON.stringify(b.canvas),
    added, removed, changed,
    summary: { added: added.length, removed: removed.length, changed: changed.length },
  };
}

export function isDirty(history, doc) {
  const head = headCommit(history);
  if (!head) return true;
  return JSON.stringify(head.doc) !== JSON.stringify(doc);
}
