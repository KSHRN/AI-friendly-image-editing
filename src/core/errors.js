/**
 * Structured, machine-readable errors.
 *
 * Every failure the engine can produce carries a stable `code` plus a `hint`
 * that an agent (or a human) can act on. This is deliberate: the primary
 * consumer of this tool is an automated caller that needs to self-correct.
 */

export class AshopError extends Error {
  /**
   * @param {string} code stable identifier, e.g. E_LAYER_NOT_FOUND
   * @param {string} message one sentence, what went wrong
   * @param {{hint?: string, details?: object, exitCode?: number, cause?: Error}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AshopError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
    this.exitCode = opts.exitCode ?? (code === 'E_USAGE' ? 2 : 1);
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.hint) out.hint = this.hint;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** Throw a structured error. */
export function fail(code, message, opts) {
  throw new AshopError(code, message, opts);
}

/** Wrap an unknown thrown value in an AshopError. */
export function asAshopError(err) {
  if (err instanceof AshopError) return err;
  const message = err && err.message ? err.message : String(err);
  return new AshopError('E_INTERNAL', message, { cause: err instanceof Error ? err : undefined });
}

/** Assert a condition, else throw E_USAGE (bad caller input). */
export function assertArg(cond, message, opts = {}) {
  if (!cond) throw new AshopError('E_USAGE', message, opts);
}

/** Assert a state invariant (internal bug, not caller error). */
export function assertState(cond, message, opts = {}) {
  if (!cond) throw new AshopError('E_INTERNAL', message, opts);
}
