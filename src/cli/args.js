/**
 * CLI argument parser driven by per-command parameter specs.
 *
 * Spec types are shared with `ashop describe` and `ashop schema`, so help text,
 * validation and machine introspection never drift apart.
 */

import { AshopError, fail } from '../core/errors.js';
import {
  parsePoint, parseRect, parsePolygon, parseJson, parseBool,
} from '../core/units.js';

const VALUE_TYPES = new Set(['string', 'int', 'number', 'enum', 'point', 'rect', 'polygon', 'numberList', 'json', 'color', 'path', 'curve', 'vec3']);

export function normalizeParams(spec = {}) {
  const out = {};
  for (const [name, def] of Object.entries(spec)) {
    out[name] = { type: 'string', ...def };
  }
  return out;
}

/**
 * @param {string[]} argv tokens after the command name
 * @param {object} spec command params
 * @param {{collectUnknown?: boolean}} [opts]
 */
export function parseArgs(argv, spec = {}, opts = {}) {
  const params = normalizeParams(spec);
  const positionalSpecs = Object.entries(params)
    .filter(([, d]) => d.positional)
    .sort((a, b) => (a[1].positional === true ? 0 : 1) - (b[1].positional === true ? 0 : 1));
  const variadicSpec = Object.entries(params).find(([, d]) => d.variadic);

  const values = {};
  const positionals = [];
  const extra = {};
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (/^-[A-Za-z]$/.test(token)) {
      const shortName = Object.keys(params).find((k) => params[k].short === token.slice(1));
      if (shortName) token = `--${shortName}`;
    }
    if (token === '--help' || token === '-h') { help = true; continue; }
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      let key = token.slice(2);
      let raw = null;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        raw = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      const negated = key.startsWith('no-') && !params[key] && params[key.slice(3)]?.type === 'bool';
      if (negated) {
        values[key.slice(3)] = false;
        continue;
      }
      const def = params[key];
      if (!def) {
        if (raw == null && i + 1 < argv.length && !looksLikeFlag(argv[i + 1])) {
          raw = argv[++i];
        }
        if (opts.collectUnknown) {
          extra[key] = raw ?? true;
          continue;
        }
        fail('E_USAGE', `unknown option: --${key}`, { hint: suggest(key, Object.keys(params)) });
      }
      if (def.type === 'bool') {
        if (raw == null) {
          const next = argv[i + 1];
          if (next != null && /^(true|false|yes|no|on|off|1|0)$/i.test(next)) {
            raw = argv[++i];
          }
        }
        values[key] = raw == null ? true : parseBool(raw);
        continue;
      }
      if (raw == null) {
        if (i + 1 >= argv.length || looksLikeFlag(argv[i + 1])) {
          fail('E_USAGE', `option --${key} needs a value`, { hint: `--${key} <${def.type}>` });
        }
        raw = argv[++i];
      }
      values[key] = coerce(raw, def, key);
      continue;
    }
    if (token.startsWith('-') && token.length > 1 && !/^-?\d/.test(token)) {
      fail('E_USAGE', `unknown option: ${token}`, { hint: 'options use --long-form' });
    }
    positionals.push(token);
  }

  // Assign positionals in declaration order.
  let pi = 0;
  for (const [name, def] of positionalSpecs) {
    if (def.variadic) continue;
    if (pi >= positionals.length) break;
    values[name] = coerce(positionals[pi++], def, name);
  }
  if (variadicSpec) {
    const [vname, vdef] = variadicSpec;
    const rest = positionals.slice(pi);
    values[vname] = rest.map((v) => coerce(v, vdef.item ?? { type: 'string' }, vname));
    pi = positionals.length;
  }
  if (pi < positionals.length) {
    fail('E_USAGE', `unexpected argument: ${positionals[pi]}`, { hint: `check \`ashop help ${'<command>'}\`` });
  }

  for (const [name, def] of Object.entries(params)) {
    if (def.required && (values[name] === undefined || values[name] === null)) {
      fail('E_USAGE', `missing required argument: ${name}`, { hint: def.desc ?? '' });
    }
    if (values[name] === undefined && def.default !== undefined) values[name] = def.default;
  }

  if (opts.collectUnknown) values.extra = extra;
  return { values, help, extra };
}

function looksLikeFlag(token) {
  return token.startsWith('--');
}

function coerce(raw, def, name) {
  const type = def.type ?? 'string';
  try {
    switch (type) {
      case 'int': {
        const v = Number(raw);
        if (!Number.isInteger(v)) fail('E_USAGE', `${name} must be an integer, got ${raw}`);
        return v;
      }
      case 'number': {
        const v = Number(String(raw).trim().replace(/px$/i, ''));
        if (!Number.isFinite(v)) fail('E_USAGE', `${name} must be a number, got ${raw}`);
        return v;
      }
      case 'bool':
        return parseBool(raw);
      case 'enum': {
        const allowed = def.values ?? [];
        if (!allowed.includes(String(raw))) {
          fail('E_USAGE', `${name} must be one of: ${allowed.join(', ')}`, { hint: `got "${raw}"` });
        }
        return String(raw);
      }
      case 'point':
        return parsePoint(raw);
      case 'rect':
        return parseRect(raw);
      case 'polygon':
        return parsePolygon(raw);
      case 'numberList': {
        const parts = String(raw).split(/[, ]+/).filter(Boolean).map(Number);
        if (parts.some((v) => !Number.isFinite(v))) fail('E_USAGE', `${name} must be a list of numbers`);
        return parts;
      }
      case 'curve':
      case 'vec3':
      case 'json':
        return parseJson(raw, name);
      case 'color': {
        if (typeof raw !== 'string') return raw;
        if (!/^#?[0-9a-f]{3,8}$/i.test(raw) && !/^\d+,\d+,\d+/.test(raw)) {
          fail('E_USAGE', `${name} must be a colour like "#ff0000", "#ff000080" or "255,0,0"`, { hint: `got "${raw}"` });
        }
        return raw;
      }
      default:
        return String(raw);
    }
  } catch (err) {
    if (err instanceof AshopError) throw err;
    fail('E_USAGE', `invalid value for ${name}: ${err.message}`);
  }
}

function suggest(key, known) {
  const best = known
    .map((k) => ({ k, d: editDistance(key, k) }))
    .sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(key.length / 3))
    ? `did you mean --${best.k}?`
    : `known options: ${known.join(', ') || '(none)'}`;
}

export function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

export function helpForCommand(command) {
  const params = normalizeParams(command.params);
  const lines = [`${command.name} — ${command.summary ?? ''}`, ''];
  if (command.usage) lines.push(`usage: ${command.usage}`, '');
  lines.push('Options:');
  const entries = Object.entries(params);
  if (entries.length === 0) lines.push('  (none)');
  for (const [name, def] of entries) {
    const flags = def.positional
      ? (def.variadic ? `<${name}...>` : `<${name}>`)
      : `--${name}${def.short ? `, -${def.short}` : ''}`;
    const req = def.required ? ' (required)' : def.default !== undefined ? ` [default: ${JSON.stringify(def.default)}]` : '';
    const type = def.type === 'bool' ? '' : ` <${def.type}>`;
    lines.push(`  ${flags}${type}${req}`);
    if (def.desc) lines.push(`      ${def.desc}`);
  }
  if (command.examples?.length) {
    lines.push('', 'Examples:');
    for (const ex of command.examples) lines.push(`  ${ex}`);
  }
  return lines.join('\n');
}

export function helpForAll(commands) {
  const groups = new Map();
  for (const c of commands) {
    const [group] = c.name.split('.');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(c);
  }
  const lines = ['ashop — headless, stateful, scriptable image engine', '', 'Commands:'];
  for (const [group, list] of [...groups.entries()].sort()) {
    lines.push('', `  ${group}`);
    for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`    ${c.name.padEnd(24)} ${c.summary ?? ''}`);
    }
  }
  lines.push('', 'Global options:');
  lines.push('  --project <path>   project bundle to operate on');
  lines.push('  --session <name>   named session under ./.ashop/sessions');
  lines.push('  --format <fmt>     json (default) or text');
  lines.push('  --pretty           pretty-print JSON');
  lines.push('  --no-daemon        run in-process (skip the daemon)');
  lines.push('  --help             command help');
  lines.push('', 'Run `ashop help <command>` or `ashop describe <command>` for details.');
  return lines.join('\n');
}
