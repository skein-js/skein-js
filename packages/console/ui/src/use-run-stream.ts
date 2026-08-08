// Tailing a run's SSE stream.
//
// `runs.joinStream` works on a finished run as well as a live one — the server replays the frames it
// persisted — so this hook is the same code path whether you opened the console mid-run or an hour
// later. That is the whole reason a durable run engine is worth having, and the console should not
// have two ways to read one.

import { useEffect, useRef, useState } from "react";

import { createConsoleClient } from "@/api";

export interface RunFrame {
  /** Monotonic index, so React keys stay stable as frames arrive. */
  seq: number;
  /** The SSE event name: `values`, `messages/partial`, `updates`, `error`, `end`, … */
  event: string;
  data: unknown;
}

export type RunStreamPhase = "connecting" | "streaming" | "ended" | "error";

export interface RunStreamState {
  frames: readonly RunFrame[];
  phase: RunStreamPhase;
  error?: Error;
  /** How many frames were dropped off the front of the buffer. */
  dropped: number;
}

/**
 * Keep at most this many frames. A token-streaming run emits thousands, and a console that holds all
 * of them turns into a memory leak with a scrollbar. The count of what was dropped is surfaced so the
 * UI can say so rather than silently showing a partial history.
 */
const MAX_FRAMES = 500;

export function useRunStream(threadId: string, runId: string, enabled = true): RunStreamState {
  const [state, setState] = useState<RunStreamState>({
    frames: [],
    phase: "connecting",
    dropped: 0,
  });
  // Frames arrive far faster than React should re-render, so they land here first and are flushed on
  // an animation frame. Without this, a token stream re-renders the tree per token.
  const pending = useRef<RunFrame[]>([]);
  const sequence = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let flushHandle: number | undefined;
    setState({ frames: [], phase: "connecting", dropped: 0 });
    pending.current = [];
    sequence.current = 0;

    const flush = () => {
      flushHandle = undefined;
      const batch = pending.current;
      if (batch.length === 0) return;
      pending.current = [];
      setState((previous) => {
        const combined = [...previous.frames, ...batch];
        const overflow = Math.max(0, combined.length - MAX_FRAMES);
        return {
          ...previous,
          phase: previous.phase === "connecting" ? "streaming" : previous.phase,
          frames: overflow > 0 ? combined.slice(overflow) : combined,
          dropped: previous.dropped + overflow,
        };
      });
    };

    const scheduleFlush = () => {
      if (flushHandle === undefined) flushHandle = window.requestAnimationFrame(flush);
    };

    (async () => {
      const client = createConsoleClient();
      try {
        for await (const chunk of client.runs.joinStream(threadId, runId, {
          signal: controller.signal,
          // The console is an observer. Without this, closing the tab would cancel a run that was
          // started by something else entirely — watching must never be destructive.
          cancelOnDisconnect: false,
        })) {
          pending.current.push({
            seq: sequence.current++,
            event: String(chunk.event),
            data: chunk.data,
          });
          scheduleFlush();
        }
        if (!controller.signal.aborted) {
          flush();
          setState((previous) => ({ ...previous, phase: "ended" }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        flush();
        setState((previous) => ({
          ...previous,
          phase: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    })();

    return () => {
      controller.abort();
      if (flushHandle !== undefined) window.cancelAnimationFrame(flushHandle);
    };
  }, [threadId, runId, enabled]);

  return state;
}
