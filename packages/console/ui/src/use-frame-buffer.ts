import { useCallback, useEffect, useRef, useState } from "react";

import type { RunFrame } from "./use-run-stream";

/** Batch high-frequency stream events into animation frames and bound retained browser memory. */
export function useFrameBuffer() {
  const pending = useRef<RunFrame[]>([]),
    sequence = useRef(0),
    scheduled = useRef<number | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<{ frames: RunFrame[]; dropped: number }>({
    frames: [],
    dropped: 0,
  });
  const flush = useCallback(() => {
    if (scheduled.current !== undefined) window.cancelAnimationFrame(scheduled.current);
    scheduled.current = undefined;
    const batch = pending.current;
    pending.current = [];
    if (!batch.length) return;
    const count = sequence.current;
    setSnapshot((previous) => {
      const frames = [...previous.frames, ...batch].slice(-500);
      return { frames, dropped: Math.max(0, count - frames.length) };
    });
  }, []);
  const append = useCallback(
    (event: string, payload: unknown) => {
      pending.current.push({ seq: sequence.current++, event, data: payload });
      if (pending.current.length > 500) pending.current = pending.current.slice(-500);
      scheduled.current ??= window.requestAnimationFrame(flush);
    },
    [flush],
  );
  const clear = useCallback(() => {
    if (scheduled.current !== undefined) window.cancelAnimationFrame(scheduled.current);
    scheduled.current = undefined;
    pending.current = [];
    sequence.current = 0;
    setSnapshot({ frames: [], dropped: 0 });
  }, []);
  useEffect(
    () => () => {
      if (scheduled.current !== undefined) window.cancelAnimationFrame(scheduled.current);
    },
    [],
  );
  return { ...snapshot, append, flush, clear };
}
