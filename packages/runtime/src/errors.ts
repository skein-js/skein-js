/** Thrown when a selected driver's connection env or `store.index.embed` config can't be resolved. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}
