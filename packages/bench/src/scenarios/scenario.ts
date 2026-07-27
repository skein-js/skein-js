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
  },
  {
    name: "idle-retention",
    description: "Many short runs, then idle — isolates what the bus keeps after runs finish.",
    streams: 200,
    frames: 25,
    frameBytes: DEFAULT_FRAME_BYTES,
    graphFramesPerSecond: 0,
    clientFramesPerSecond: 0,
  },
];

/** Look a scenario up by name. */
export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}
