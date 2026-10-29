/** Attach to an existing project bundle. */

import path from 'node:path';
import { Session } from '../../core/session.js';
import { setCurrentProject } from '../session-loader.js';

export default {
  name: 'open',
  summary: 'Open a project bundle and make it current',
  needsSession: false,
  params: {
    path: { type: 'path', positional: true, required: true, desc: 'path to the .ashop bundle' },
  },
  examples: ['ashop open ./shop.ashop'],
  async run(ctx, args) {
    const target = path.resolve(ctx.cwd, args.path);
    const session = await Session.open(target);
    await setCurrentProject(target);
    return { project: target, ...session.summary() };
  },
};
