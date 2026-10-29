/** Daemon lifecycle helpers. */

import path from 'node:path';
import { resolveProjectPath } from '../session-loader.js';
import { pingDaemon, stopDaemon } from '../daemon-client.js';
import { pipePath } from '../../daemon/server.js';

async function projectFor(ctx) {
  return resolveProjectPath({
    project: ctx.projectArg,
    session: ctx.sessionArg,
    cwd: ctx.cwd,
    requireExists: false,
  });
}

export default [
  {
    name: 'daemon.status',
    summary: 'Report whether the project daemon is running',
    needsSession: false,
    mutates: false,
    params: {},
    async run(ctx) {
      const project = await projectFor(ctx);
      const ping = await pingDaemon(project);
      return { ...ping, pipe: ping.pipe ?? pipePath(project) };
    },
  },
  {
    name: 'daemon.stop',
    summary: 'Stop the project daemon',
    needsSession: false,
    mutates: false,
    params: {},
    async run(ctx) {
      const project = await projectFor(ctx);
      return stopDaemon(project);
    },
  },
  {
    name: 'daemon.start',
    summary: 'Start the project daemon in the background',
    needsSession: false,
    mutates: false,
    params: {},
    async run(ctx) {
      const project = await projectFor(ctx);
      const { execViaDaemon } = await import('../daemon-client.js');
      // A no-op round-trip both starts the daemon and proves it works.
      await execViaDaemon(project, 'daemon.status', {});
      return { ...(await pingDaemon(project)), started: true };
    },
  },
];
