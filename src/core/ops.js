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
import { coerceStepArgs } from '../cli/args.js';
import { createDocument } from './document.js';
import { createHistory } from './history.js';
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

export async function runOps(session, plan, { atomic = false, dryRun = false, commitMessage = null, extraVars = {}, fresh = false } = {}) {
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
    // Parse step args through the same layer the CLI uses, so a value means
    // the same thing in both places ("600,500,450,450" -> a rect-ish point set,
    // a JSON array for a polygon, defaults applied).
    let args;
    try {
      args = coerceStepArgs(command, resolveVars(step.args ?? {}, vars), `step ${i + 1}`);
    } catch (err) {
      // Name the step even for up-front validation: "step 2 (shape.add): not a
      // point: oops" is actionable, a bare message forces the caller to guess.
      throw annotateStepError(err, i + 1, step.op);
    }
    validateRequired(command, args, i + 1);
    resolved.push({ index: i + 1, step, command, args });
  }

  if (dryRun) {
    return { dryRun: true, steps: resolved.map((r) => ({ index: r.index, op: r.step.op, args: r.args ?? null })) };
  }

  // A script that builds the image from scratch is only re-runnable if the
  // canvas starts empty; --fresh does that before the snapshot so a later
  // --atomic failure rolls back to the blank canvas, not to stale layers.
  if (fresh) resetSession(session);

  const snapshot = atomic
    ? { doc: structuredClone(session.doc), history: session.project ? structuredClone(session.project.history) : null }
    : null;

  const results = [];
  let last = null;
  let current = null;
  try {
    for (const entry of resolved) {
      current = entry;
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
    const e = stepError(err, current);
    e.details = { ...(e.details ?? {}), failedAtStep: results.length + 1, executed: results.length };
    throw e;
  }

  let committed = null;
  if (commitMessage != null) committed = session.commit(commitMessage);
  await session.save();
  return { steps: results, vars, committed };
}

/**
 * Reset the target session to an empty canvas of the same size.
 *
 * Used by `run --fresh`: a script that builds the document from scratch is
 * only idempotent if it starts from nothing, otherwise a second run hits
 * "layer name matches 2 layers" three steps in.
 */
function resetSession(session) {
  const previous = session.doc;
  const doc = createDocument({
    width: previous.canvas.width,
    height: previous.canvas.height,
    background: previous.canvas.background,
    name: previous.name,
    colorSpace: previous.colorSpace,
  });
  session.doc = doc;
  if (session.project) {
    session.project.doc = doc;
    session.project.history = createHistory(doc, 'run --fresh');
  }
  session.renderer.clearCache();
}

/**
 * Put a step's identity back into an error raised while validating it.
 *
 * Validation happens before anything runs, so there is no `results` array to
 * count yet — the step that failed is the step being parsed.
 */
function annotateStepError(err, index, op) {
  if (!(err instanceof AshopError)) return stepError(err, { index, step: { op } });
  return new AshopError(err.code, `step ${index} (${op}): ${err.message}`, {
    hint: err.hint,
    exitCode: err.exitCode,
    cause: err,
    details: { ...(err.details ?? {}), step: index, op, failedAtStep: index, executed: 0 },
  });
}

/**
 * Classify a failure thrown by a step.
 *
 * A raw `TypeError` escaping a command is almost always an argument-shape
 * problem (`args.polygon.map is not a function`), so it is reported as
 * E_USAGE with an actionable hint instead of leaking as E_INTERNAL. Anything
 * else keeps its structured code; unexpected ones get a hint saying it is a
 * bug so the caller knows not to just retry.
 */
function stepError(err, entry) {
  if (err instanceof AshopError) return err;
  const where = entry ? `step ${entry.index} (${entry.step.op})` : 'ops script';
  const message = err && err.message ? String(err.message) : String(err);
  const argumentShaped = err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError;
  const op = entry?.step?.op ?? 'step';
  return new AshopError(argumentShaped ? 'E_USAGE' : 'E_INTERNAL', `${where}: ${message}`, {
    hint: argumentShaped
      ? `the arguments for "${op}" did not match its schema; run \`ashop describe ${op}\`. If they look right this is an ashop bug`
      : 'this is an ashop bug; report it with the ops file and this message',
    cause: err instanceof Error ? err : undefined,
    details: { step: entry?.index ?? null, op: entry?.step?.op ?? null },
  });
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
