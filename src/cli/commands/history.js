/** Commit and history commands. */

import { headCommit, branches } from '../../core/history.js';
import { AshopError } from '../../core/errors.js';

export default [
  {
    name: 'commit',
    aliases: ['history.commit'],
    summary: 'Snapshot the working document into history',
    params: {
      message: { type: 'string', short: 'm', default: '', desc: 'commit message' },
    },
    examples: ['ashop commit -m "SKU 1024 main image"'],
    async run(ctx, args) {
      return ctx.session.commit(args.message ?? '');
    },
  },
  {
    name: 'history.log',
    summary: 'Show the commit history of the current branch',
    mutates: false,
    params: { limit: { type: 'int', default: 20 } },
    async run(ctx, args) {
      return ctx.session.historyLog({ limit: args.limit });
    },
  },
  {
    name: 'history.show',
    summary: 'Show one commit and its document summary',
    mutates: false,
    params: { ref: { type: 'string', positional: true, default: 'HEAD' } },
    async run(ctx, args) {
      const project = ctx.session.project;
      if (!project) throw new AshopError('E_NO_PROJECT', 'no project history available');
      const id = args.ref === 'HEAD' ? project.history.head : ctx.session.historyLog().commits.find((c) => c.id.startsWith(args.ref))?.id;
      const commit = id ? project.history.commits[id] : null;
      if (!commit) throw new AshopError('E_REF_NOT_FOUND', `unknown commit: ${args.ref}`);
      return {
        id: commit.id,
        parent: commit.parent,
        message: commit.message,
        ts: commit.ts,
        doc: {
          canvas: commit.doc.canvas,
          layerCount: countLayers(commit.doc.layers),
        },
        branches: branches(project.history).filter((b) => b.commit === commit.id),
      };
    },
  },
  {
    name: 'history.diff',
    summary: 'Structural diff between two commits',
    mutates: false,
    params: {
      a: { type: 'string', positional: true, required: true },
      b: { type: 'string', positional: true, default: 'HEAD' },
    },
    async run(ctx, args) {
      return ctx.session.historyDiff(args.a, args.b);
    },
  },
  {
    name: 'history.branch',
    aliases: ['branch'],
    summary: 'Create a branch at the current commit',
    params: {
      name: { type: 'string', positional: true, required: true },
      checkout: { type: 'bool', default: true, desc: 'switch to the new branch' },
    },
    async run(ctx, args) {
      return ctx.session.createBranch(args.name, { checkout: args.checkout });
    },
  },
  {
    name: 'history.checkout',
    summary: 'Check out a branch or commit (discards uncommitted changes with --force)',
    params: {
      ref: { type: 'string', positional: true, required: true },
      force: { type: 'bool', default: false },
    },
    async run(ctx, args) {
      return ctx.session.checkout(args.ref, { force: args.force });
    },
  },
  {
    name: 'history.reset',
    aliases: ['reset'],
    summary: 'Hard reset the current branch to a ref (e.g. HEAD~1)',
    params: {
      ref: { type: 'string', positional: true, required: true },
      hard: { type: 'bool', default: true, desc: 'PDR compatibility flag; resets are always hard in v1' },
    },
    async run(ctx, args) {
      return ctx.session.resetHard(args.ref);
    },
  },
  {
    name: 'history.branches',
    summary: 'List branches',
    mutates: false,
    params: {},
    async run(ctx) {
      const project = ctx.session.project;
      if (!project) throw new AshopError('E_NO_PROJECT', 'no project history available');
      return { branches: branches(project.history), current: project.history.currentBranch };
    },
  },
];

function countLayers(layers) {
  let n = 0;
  for (const l of layers) {
    n++;
    if (l.children) n += countLayers(l.children);
  }
  return n;
}
