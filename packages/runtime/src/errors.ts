/** Thrown when a selected driver's connection env or a `store.*` config value can't be resolved. */
export class RuntimeConfigError extends Error {
  /**
   * `options.cause` carries the underlying failure — a module that threw on import, most usefully — so
   * the actionable message and the original stack both survive. Matches `SkeinConfigError`, which the
   * config-loading pattern this mirrors already does.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeConfigError";
  }
}
