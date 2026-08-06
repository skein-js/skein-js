// Scenario definitions. Two shapes matter: a client that keeps up (the floor — what the server costs
// when nothing backs up) and one that cannot (the actual test). Everything else is a dial on those.

/** One benchmark configuration. */
export interface Scenario {
  name: string;
  description: string;
  /** Concurrent streaming runs. */
  streams: number;
  /** Frames the graph emits per run. */
  frames: number;
  /** Filler bytes per frame. */
  frameBytes: number;
  /** Graph production rate; `0` means unthrottled. */
  graphFramesPerSecond: number;
  /** Client consumption rate; `0` means "read as fast as they arrive". */
  clientFramesPerSecond: number;
  /**
   * Whether every frame the graph produced must reach its client (`checkInvariants`' delivery bound).
   *
   * True for any scenario that stays inside the bus's per-run cap: backpressure delays frames, it never
   * discards them, so a short delivery there is a real defect. False only for a scenario that
   * deliberately exceeds the cap — eviction ends the subscriber's stream by design, and a bound
   * asserting otherwise would fail on correct behaviour.
   */
  expectsCompleteDelivery: boolean;
}

const DEFAULT_FRAMES = 500;
const DEFAULT_FRAME_BYTES = 512;

/**
 * The built-in scenarios. `slow-client` is the one that decides whether the streaming work landed:
 * the client reads at a twentieth of the graph's rate, so every unread frame has to be held
 * somewhere. Before backpressure and bus bounding that "somewhere" grows with `streams × frames`;
 * after, it is a bounded constant.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: "fast-client",
    description: "Clients consume as fast as the graph produces — the no-backlog floor.",
    streams: 50,
    frames: DEFAULT_FRAMES,
    frameBytes: DEFAULT_FRAME_BYTES,
    graphFramesPerSecond: 0,
    clientFramesPerSecond: 0,
    expectsCompleteDelivery: true,
  },
  {
    name: "slow-client",
    description: "Clients read at ~25 fps against a 500 fps graph — the backpressure test.",
    streams: 50,
    frames: DEFAULT_FRAMES,
    // Deliberately larger than the default frame. A stream has to exceed the buffers sitting between
    // the two ends — the client's stream buffer plus both kernel socket buffers, together a few
    // hundred KB — before the server is forced to queue anything at all. At 512 bytes a 500-frame run
    // fits inside them and a server with no backpressure looks clean; at 4 KB it does not, and the
    // ~2 MB per stream lands in the server's socket buffer where it belongs.
    frameBytes: 4096,
    graphFramesPerSecond: 500,
    clientFramesPerSecond: 25,
    // The point of the scenario: a client 20x slower than the graph must still receive every frame.
    expectsCompleteDelivery: true,
  },
  {
    name: "idle-retention",
    description: "Many short runs, then idle — isolates what the bus keeps after runs finish.",
    streams: 200,
    frames: 25,
    frameBytes: DEFAULT_FRAME_BYTES,
    graphFramesPerSecond: 0,
    clientFramesPerSecond: 0,
    expectsCompleteDelivery: true,
  },
  {
    name: "long-run",
    description: "Exceeds the bus's per-run frame cap — exercises eviction and its truncation.",
    // The other scenarios produce ~500 frames per run, far below the bus's 10,000-frame default, so
    // none of them ever reaches the cap. This one must exceed it or the eviction path is invisible
    // here and a regression in it would show up in no number at all — which is exactly what happened
    // when this scenario was first written against a 2,000-frame assumption.
    streams: 10,
    frames: 12_000,
    frameBytes: DEFAULT_FRAME_BYTES,
    graphFramesPerSecond: 0,
    clientFramesPerSecond: 0,
    // Exceeds the per-run frame cap on purpose, so eviction ends these streams early. Truncation IS
    // the behaviour under test here; the bus caps below are what must still hold.
    expectsCompleteDelivery: false,
  },
];

/** Look a scenario up by name. */
export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}
