import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useFrameBuffer } from "./use-frame-buffer";

afterEach(() => vi.restoreAllMocks());
it("bounds queued and rendered event history and counts dropped frames before a browser paint", () => {
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const { result, unmount } = renderHook(useFrameBuffer);
  act(() => {
    for (let index = 0; index < 1250; index++) result.current.append("updates", index);
  });
  expect(result.current.frames).toHaveLength(0);
  act(() => result.current.flush());
  expect(result.current.frames).toHaveLength(500);
  expect(result.current.frames[0]?.data).toBe(750);
  expect(result.current.dropped).toBe(750);
  act(() => result.current.clear());
  expect(result.current.dropped).toBe(0);
  act(() => result.current.append("end", {}));
  unmount();
  expect(cancel).toHaveBeenCalledWith(42);
});
