/**
 * Batch ops runner.
 *
 * A script is a list of steps; each step names a CLI command and passes an
 * argument object. `${var}` placeholders are resolved recursively, and a step
 * may `assign` a value from the previous result into a variable.
 *
 * With `atomic`, the document *and* history are snapshotted first; any failure
 * restores both. With `dryRun`, the plan is validated but nothing executes.
 */

import { loadCommands } from '../cli/registry.js';
import { AshopError, asAshopError } from './errors.js';

const VAR_RE = /\$\{([A-Za-z0-9_.-]+)\}/g;

export function resolveVars(value, vars) {
  if (typeof value === 'string') {
    const whole = /^\$\{([A-Za-z0-9_.-]+)\}$/.exec(value);
    if (whole) {
      if (!(whole[1] in vars)) throw new AshopError('E_VAR_MISSING', `unknown variable: ${whole[1]}`);
      return vars[whole[1]];
    }
    return value.replace(VAR_RE, (_, name) => {
      if (!(name in vars)) throw new AshopError('E_VAR_MISSING', `unknown variable: ${name}`);
      return String(vars[name]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVars(v, vars);
    return out;
  }
  return value;
}

function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export async function runOps(session, plan, { atomic = false, dryRun = false, commitMessage = null, extraVars = {} } = {}) {
  if (!plan || typeof plan !== 'object') throw new AshopError('E_USAGE', 'ops file must contain an object');
  const steps = plan.steps ?? plan.ops;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AshopError('E_USAGE', 'ops file needs a non-empty "steps" array');
  }
  const { map } = await loadCommands();
  const vars = { ...(plan.vars ?? {}), ...extraVars };

  // Validate up front so a dry run and a real run agree.
  const resolved = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') throw new AshopError('E_STEP', `step ${i + 1} is not an object`);
    if (step.op === 'assign' || step.op === 'echo') {
      resolved.push({ index: i + 1, step });
      continue;
    }
    if (!step.op) throw new AshopError('E_STEP', `step ${i + 1} has no "op"`);
    const command = map.get(step.op);
    if (!command) throw new AshopError('E_COMMAND_NOT_FOUND', `step ${i + 1}: unknown op "${step.op}"`, { hint: 'run `ashop describe commands`' });
    if (command.name === 'run' || command.name === 'init' || command.name === 'open') {
      throw new AshopError('E_STEP', `step ${i + 1}: "${command.name}" cannot be used inside a script`);
    }
    const args = resolveVars(step.args ?? {}, vars);
    validateRequired(command, args, i + 1);
    // Commands that collect operator parameters (filter/style/adjust) expect
    // unknown keys under `args.extra`; a batch file naturally mixes both.
    if (command.collectUnknown) {
      const declared = new Set(Object.keys(command.params ?? {}));
      const extra = {};
      for (const [key, value] of Object.entries(args)) {
        if (!declared.has(key)) extra[key] = value;
      }
      for (const key of Object.keys(extra)) delete args[key];
      args.extra = extra;
    }
    resolved.push({ index: i + 1, step, command, args });
  }

  if (dryRun) {
    return { dryRun: true, steps: resolved.map((r) => ({ index: r.index, op: r.step.op, args: r.args ?? null })) };
  }

  const snapshot = atomic
    ? { doc: structuredClone(session.doc), history: session.project ? structuredClone(session.project.history) : null }
    : null;

  const results = [];
  let last = null;
  try {
    for (const entry of resolved) {
      if (entry.step.op === 'echo') {
        results.push({ index: entry.index, op: 'echo', message: entry.step.args?.message ?? '' });
        continue;
      }
      if (entry.step.op === 'assign') {
        const name = entry.step.args?.var;
        const path = entry.step.args?.path;
        if (!name || !path) throw new AshopError('E_STEP', `step ${entry.index}: assign needs var and path`);
        vars[name] = getPath(last, path);
        if (vars[name] === undefined) throw new AshopError('E_STEP', `step ${entry.index}: path "${path}" not found in previous result`);
        results.push({ index: entry.index, op: 'assign', var: name, value: vars[name] });
        continue;
      }
      const ctx = { session, projectPath: session.projectPath, cwd: process.cwd(), args: entry.args };
      const data = await entry.command.run(ctx, entry.args);
      last = data;
      results.push({ index: entry.index, op: entry.step.op, ok: true, data: summarise(data) });
    }
  } catch (err) {
    if (snapshot) {
      session.doc = snapshot.doc;
      if (session.project && snapshot.history) session.project.history = snapshot.history;
      session.renderer.clearCache();
    }
    const e = asAshopError(err);
    e.details = { ...(e.details ?? {}), failedAtStep: results.length + 1, executed: results.length };
    throw e;
  }

  let committed = null;
  if (commitMessage != null) committed = session.commit(commitMessage);
  await session.save();
  return { steps: results, vars, committed };
}

function summarise(data) {
  if (data == null) return null;
  if (typeof data !== 'object') return data;
  // Keep script logs small by default; the full data is available per-step via
  // running commands individually.
  const out = {};
  for (const key of ['layer', 'selection', 'file', 'pass', 'metrics', 'exported', 'steps']) {
    if (key in data) out[key] = data[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function validateRequired(command, args, index) {
  for (const [name, def] of Object.entries(command.params ?? {})) {
    if (def.required && (args[name] === undefined || args[name] === null)) {
      throw new AshopError('E_STEP', `step ${index} (${command.name}): missing required "${name}"`, {
        hint: `known args: ${Object.keys(command.params).join(', ')}`,
      });
    }
  }
}
