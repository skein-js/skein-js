import type { ThreadCheckpointer } from "../graphs/thread-checkpointer.js";

/** Attribute writes without assuming a runtime persists its call metadata in checkpoints. */
export function withCheckpointRunIdentity(
  checkpointer: ThreadCheckpointer,
  runId: string,
): ThreadCheckpointer {
  // A frozen structural driver can have non-configurable own methods. A proxy over that object
  // cannot return wrappers for them. Copy descriptors onto a per-call facade instead, leaving the
  // supplied resource frozen/owned by its host and preserving its prototype and public fields.
  const descriptors = Object.fromEntries(
    Reflect.ownKeys(checkpointer).map((key) => [
      key,
      { ...Object.getOwnPropertyDescriptor(checkpointer, key), configurable: true },
    ]),
  );
  const facade = Object.create(
    Object.getPrototypeOf(checkpointer),
    descriptors,
  ) as ThreadCheckpointer;
  return new Proxy(facade, {
    get(_facade, property) {
      const target = checkpointer;
      if (property === "put") {
        return (
          ...[config, checkpoint, metadata, versions]: Parameters<ThreadCheckpointer["put"]>
        ) =>
          target.put(
            config,
            checkpoint,
            // Non-LangGraph drivers may use opaque metadata. Attribute plain records only;
            // changing an opaque value's type would break the existing structural contract.
            typeof metadata === "object" &&
              metadata !== null &&
              [Object.prototype, null].includes(Object.getPrototypeOf(metadata))
              ? { ...metadata, run_id: runId }
              : metadata,
            versions,
          );
      }
      const member: unknown = Reflect.get(target, property, target);
      // Savers may use private fields. Delegate every other method with its real owner, while
      // preserving runtime-specific optional methods and data on the supplied saver.
      return typeof member === "function" && property !== "constructor"
        ? member.bind(target)
        : member;
    },
    set: (_facade, property, value) => Reflect.set(checkpointer, property, value, checkpointer),
    has: (_facade, property) => Reflect.has(checkpointer, property),
  });
}
