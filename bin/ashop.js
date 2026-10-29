#!/usr/bin/env node
/**
 * AShop CLI entry point.
 */

import { main } from '../src/cli/index.js';
import { formatOutput, envelopeError } from '../src/cli/output.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(formatOutput(envelopeError(err), { json: true }) + '\n');
    process.exit(err?.exitCode ?? 1);
  });
