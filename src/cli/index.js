/**
 * CLI dispatcher.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCommands, resolveCommand } from './registry.js';
import { parseArgs, helpForCommand, helpForAll, editDistance } from './args.js';
import { envelopeOk, envelopeError, formatOutput } from './output.js';
import { resolveProjectPath, readCurrentProject } from './session-loader.js';
import { execViaDaemon } from './daemon-client.js';
import { runDaemon } from '../daemon/server.js';
import { Session } from '../core/session.js';
import { AshopError, asAshopError } from '../core/errors.js';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));

export async function main(argv) {
  const globals = extractGlobals(argv);

  if (globals.version) {
    process.stdout.write(`ashop ${pkg.version}\n`);
    return 0;
  }

  if (globals.tokens[0] === '__daemon') {
    const project = globals.project ?? globals.tokens[1];
    await runDaemon({ project });
    return 0;
  }

  const { map, list } = await loadCommands();

  if (globals.tokens.length === 0) {
    process.stdout.write(helpForAll(list) + '\n');
    return 0;
  }

  const resolved = resolveCommand(globals.tokens, map);
  if (!resolved) {
    const guess = closestCommand(globals.tokens[0], list);
    throw new AshopError('E_USAGE', `unknown command: ${globals.tokens.join(' ')}`, {
      hint: guess ? `did you mean \`ashop ${guess}\`? run \`ashop help\` for the command list` : 'run `ashop help` for the command list',
    });
  }
  const command = resolved.command;
  const rest = globals.tokens.slice(resolved.used);
  // `--format json|text` is accepted as an output-format alias on commands that
  // do not have their own `format` parameter (PDR examples use it).
  if (!Object.prototype.hasOwnProperty.call(command.params ?? {}, 'format')) {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--format') {
        const value = rest[i + 1];
        if (value !== 'json' && value !== 'text') {
          throw new AshopError('E_USAGE', '--format must be "json" or "text"');
        }
        globals.json = value === 'json';
        rest.splice(i, 2);
        i--;
      } else if (rest[i].startsWith('--format=')) {
        const value = rest[i].slice('--format='.length);
        if (value !== 'json' && value !== 'text') throw new AshopError('E_USAGE', '--format must be "json" or "text"');
        globals.json = value === 'json';
        rest.splice(i, 1);
        i--;
      }
    }
  }
  const { values, help } = parseArgs(rest, command.params, { collectUnknown: Boolean(command.collectUnknown) });

  if (help || globals.help) {
    process.stdout.write(helpForCommand(command) + '\n');
    return 0;
  }

  const warnings = [];
  let data;
  let ranViaDaemon = false;

  if (command.needsSession === false) {
    const ctx = {
      session: null, projectPath: null, cwd: process.cwd(), args: values,
      projectArg: globals.project, sessionArg: globals.session,
    };
    data = await command.run(ctx, values);
  } else {
    const projectPath = await resolveProjectPath({
      project: globals.project,
      session: globals.session,
      cwd: process.cwd(),
    });
    const useDaemon = globals.daemon && process.env.ASHOP_NO_DAEMON !== '1' && command.daemon !== false;
    if (useDaemon) {
      try {
        data = await execViaDaemon(projectPath, command.name, values, { timeoutMs: command.timeoutMs });
        ranViaDaemon = true;
      } catch (err) {
        const e = asAshopError(err);
        // Only an unreachable daemon may fall back to in-process execution.
        // After a timeout the daemon may still apply the command, so replaying
        // it here would run a mutation twice.
        if (e.code === 'E_DAEMON') {
          warnings.push(`daemon unavailable (${e.message}); ran in-process`);
        } else {
          throw e;
        }
      }
    }
    if (!ranViaDaemon) {
      const session = await Session.open(projectPath);
      const ctx = { session, projectPath, cwd: process.cwd(), args: values, projectArg: globals.project, sessionArg: globals.session };
      data = await command.run(ctx, values);
      if (command.mutates !== false) await session.save();
    }
  }

  const result = envelopeOk(command, data ?? null, warnings);
  const json = command.outputText ? false : globals.json;
  process.stdout.write(formatOutput(result, { json, pretty: globals.pretty }) + '\n');
  return 0;
}

function extractGlobals(argv) {
  const out = {
    project: null,
    session: null,
    json: process.env.ASHOP_FORMAT !== 'text',
    pretty: process.env.ASHOP_PRETTY === '1',
    daemon: true,
    help: false,
    version: false,
    tokens: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const takeValue = () => {
      if (i + 1 >= argv.length) throw new AshopError('E_USAGE', `${t} needs a value`);
      return argv[++i];
    };
    if (t === '--project' || t === '-p') { out.project = takeValue(); continue; }
    if (t.startsWith('--project=')) { out.project = t.slice(10); continue; }
    if (t === '--session') { out.session = takeValue(); continue; }
    if (t.startsWith('--session=')) { out.session = t.slice(10); continue; }
    if (t === '--json') { out.json = true; continue; }
    if (t === '--text') { out.json = false; continue; }
    if (t === '--pretty') { out.pretty = true; continue; }
    if (t === '--no-daemon') { out.daemon = false; continue; }
    if (t === '--help' || t === '-h') { out.help = true; continue; }
    if (t === '--version' || t === '-V') { out.version = true; continue; }
    out.tokens.push(t);
  }
  return out;
}

function closestCommand(token, list) {
  let best = null;
  let bestD = Infinity;
  for (const c of list) {
    const d = editDistance(token, c.name);
    if (d < bestD) { bestD = d; best = c.name; }
  }
  return bestD <= Math.max(2, Math.floor(token.length / 3)) ? best : null;
}
