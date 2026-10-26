import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAsync } from "./use-async";

describe("useAsync resource lifecycle", () => {
  it("ignores an old response after changing resource and aborts it", async () => {
    let complete!: (value: string) => void;
    let firstSignal!: AbortSignal;
    const { result, rerender } = renderHook(
      ({ id }) =>
        useAsync(
          (signal) => {
            if (id === "first") {
              firstSignal = signal;
              return new Promise<string>((resolve) => {
                complete = resolve;
              });
            }
            return Promise.resolve("second result");
          },
          [id],
        ),
      { initialProps: { id: "first" } },
    );
    await waitFor(() => expect(complete).toBeDefined());
    rerender({ id: "second" });
    await waitFor(() => expect(result.current.data).toBe("second result"));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => complete("old result"));
    expect(result.current.data).toBe("second result");
  });

  it("keeps a labeled stale snapshot after a refresh failure and catches synchronous loader failures", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("last read")
      .mockImplementation(() => {
        throw new Error("server offline");
      });
    const { result } = renderHook(() => useAsync(load, []));
    await waitFor(() => expect(result.current.data).toBe("last read"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error?.message).toBe("server offline"));
    expect(result.current.data).toBe("last read");
    expect(result.current.loading).toBe(false);
  });
});
