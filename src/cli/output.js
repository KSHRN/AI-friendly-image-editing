/**
 * Output formatting. JSON is the default because the primary caller is a
 * program; `--text` gives a compact human view, `--pretty` pretty-prints JSON.
 */

import { AshopError } from '../core/errors.js';

export function envelopeOk(command, data, warnings = []) {
  const out = { ok: true, command: command.name ?? command, data };
  if (warnings.length) out.warnings = warnings;
  return out;
}

export function envelopeError(err) {
  const e = err instanceof AshopError ? err : new AshopError('E_INTERNAL', err?.message ?? String(err));
  return { ok: false, error: e.toJSON() };
}

export function formatOutput(result, { json = true, pretty = false } = {}) {
  if (json) return pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
  if (!result.ok) {
    const e = result.error;
    const lines = [`error ${e.code}: ${e.message}`];
    if (e.hint) lines.push(`hint: ${e.hint}`);
    return lines.join('\n');
  }
  return renderText(result.command, result.data);
}

function renderText(command, data) {
  if (data == null) return 'ok';
  if (typeof data === 'string') return data;
  const lines = [];
  flatten('', data, lines);
  return lines.join('\n');
}

function flatten(prefix, value, out) {
  if (value == null || typeof value !== 'object') {
    out.push(`${prefix}${prefix ? ': ' : ''}${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${prefix}: []`);
      return;
    }
    if (value.every((v) => v == null || typeof v !== 'object')) {
      out.push(`${prefix}: ${value.join(', ')}`);
      return;
    }
    for (const item of value) {
      if (item && typeof item === 'object' && 'id' in item && 'name' in item) {
        out.push(`${' '.repeat(prefix.split('.').length * 2)}${item.type ?? ''} ${item.id} "${item.name}"${item.visible === false ? ' (hidden)' : ''}`);
      } else {
        flatten(prefix, item, out);
        out.push('');
      }
    }
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (v && typeof v === 'object') {
      out.push(`${prefix ? prefix + '.' : ''}${key}:`);
      flatten('', v, out);
    } else {
      out.push(`${prefix ? prefix + '.' : ''}${key}: ${String(v)}`);
    }
  }
}
