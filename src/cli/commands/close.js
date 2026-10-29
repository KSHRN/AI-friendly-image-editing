/** Detach the current project pointer. */

import { clearCurrentProject } from '../session-loader.js';

export default {
  name: 'close',
  summary: 'Forget the current project pointer',
  needsSession: false,
  params: {},
  async run() {
    await clearCurrentProject();
    return { closed: true };
  },
};
