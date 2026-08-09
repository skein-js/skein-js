// The protocol's resume/update/goto envelope, carried to the agent as an opaque value.
//
// `POST /runs` with a `command` body resumes an interrupted run. LangGraph expresses that as its own
// `Command` class, and this package used to construct one directly — which is a *runtime* import of
// `@langchain/langgraph`, and therefore the reason `npm i @skein-js/agent-protocol` pulled a graph
// runtime it may never use.
//
// So the engine hands the envelope through unchanged and the binding decides what it means:
// `@skein-js/langgraph`'s `langGraphAgent` turns it into a real `Command`. This is not a
// reimplementation — nothing here interprets `resume`/`update`/`goto`. It is only a carrier, branded
// so an ordinary graph input that happens to have a `resume` key is never mistaken for one.

/** Brands the envelope. `Symbol.for` so two copies of this package still recognise each other's. */
const AGENT_COMMAND = Symbol.for("skein.agent-command");

/**
 * The fields the Agent Protocol defines on a run's `command`, plus whatever else the client sent.
 *
 * Open by design: the wire schema is `.passthrough()`, and LangGraph's own `CommandParams` carries
 * more than these three (`graph`, notably, which selects a subgraph). Narrowing here would silently
 * drop those on the way to the runtime.
 */
export interface AgentCommandParams {
  /** The value handed back to a waiting `interrupt()`. */
  readonly resume?: unknown;
  /** A state update applied before resuming. */
  readonly update?: unknown;
  /** The node(s) to jump to. */
  readonly goto?: unknown;
  readonly [field: string]: unknown;
}

/**
 * A branded {@link AgentCommandParams}, distinguishable from an ordinary graph input.
 *
 * The brand carries the **complete** payload rather than acting as a marker, so a binding translates
 * exactly what the client sent. Reading the fields off the envelope itself would mean enumerating
 * them, and every field nobody thought to enumerate would be dropped.
 */
export interface AgentCommand extends AgentCommandParams {
  readonly [AGENT_COMMAND]: AgentCommandParams;
}

/** Wrap a run's `command` so the binding can tell it apart from a plain input value. */
export function agentCommand(params: AgentCommandParams): AgentCommand {
  return { ...params, [AGENT_COMMAND]: params };
}

/** Whether `value` is an {@link AgentCommand} the binding should translate. */
export function isAgentCommand(value: unknown): value is AgentCommand {
  return typeof value === "object" && value !== null && AGENT_COMMAND in value;
}

/**
 * The command's full payload, for a binding constructing its runtime's own command type.
 *
 * Use this rather than spreading the envelope: a spread copies the brand symbol along with the
 * fields, and handing that to a runtime constructor leaks skein's marker into its state.
 */
export function agentCommandPayload(command: AgentCommand): AgentCommandParams {
  return command[AGENT_COMMAND];
}
