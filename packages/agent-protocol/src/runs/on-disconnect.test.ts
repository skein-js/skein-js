// `on_disconnect` — cancel a run when the caller's connection drops.
//
// The seam is `ProtocolRequest.signal`, which each adapter fills from its own close event. Here that
// signal is driven by hand, so these cases pin the *policy* (default continue, opt-in cancel, unhook
// once settled) independently of any one framework's disconnect plumbing.

import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function harness() {
  const deps = createFixtureDeps();
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return { deps, service };
}

/** A run slow enough that the disconnect lands mid-flight. */
const slowRun = { assistant_id: "echo", input: { value: "hi" }, after_seconds: 1 } as const;

describe("on_disconnect", () => {
  it("cancels an inline wait run when the client goes away", async () => {
    const { deps, service } = await harness();
    const disconnected = new AbortController();

    const pending = service.runs.createWait(
      { ...slowRun, on_disconnect: "cancel" },
      { signal: disconnected.signal },
    );

    // Drop the connection while the run is still held by `after_seconds`.
    await new Promise((resolve) => setTimeout(resolve, 50));
    disconnected.abort();

    const { runId } = await pending;
    expect((await deps.store.runs.get(runId))?.status).toBe("cancelled");
  });

  it("lets the run finish by default, even when the client goes away", async () => {
    // The default matters more than the opt-in: a proxy idle timeout or LB reset is indistinguishable
    // from a real hang-up, so defaulting to cancel would let one kill a healthy run.
    const { deps, service } = await harness();
    const disconnected = new AbortController();

    const pending = service.runs.createWait({ ...slowRun }, { signal: disconnected.signal });

    await new Promise((resolve) => setTimeout(resolve, 50));
    disconnected.abort();

    const { runId } = await pending;
    expect((await deps.store.runs.get(runId))?.status).not.toBe("cancelled");
  });

  it("unhooks once the run settles, so a normal response does not cancel anything", async () => {
    // A Node `res` emits `close` on a healthy response too. Without the disarm every successful
    // `/runs/wait` would fire a cancel — idempotent, but a wasted read on every request.
    //
    // Asserted on the **store**, not on a spy over `service.runs.cancel`: the abort handler calls the
    // closure-local `cancelRun`, and `cancel: cancelRun` on the service object is only an alias — so
    // spying there replaces a property nothing on this path reads, and the test would pass with the
    // disarm deleted. `cancelRun`'s first act is to load the run, so a read after the response
    // settles is the observable that the listener fired.
    const { deps, service } = await harness();
    const disconnected = new AbortController();

    const { runId } = await service.runs.createWait(
      { assistant_id: "echo", input: { value: "hi" }, on_disconnect: "cancel" },
      { signal: disconnected.signal },
    );

    let readsAfterSettle = 0;
    const get = deps.store.runs.get.bind(deps.store.runs);
    vi.spyOn(deps.store.runs, "get").mockImplementation(async (id: string) => {
      readsAfterSettle += 1;
      return get(id);
    });

    // The response has been written; now the transport closes it.
    disconnected.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readsAfterSettle).toBe(0);
    expect((await get(runId))?.status).toBe("success");
  });

  it("cancels a stream run when the client goes away", async () => {
    const { deps, service } = await harness();
    const disconnected = new AbortController();

    const started = await service.runs.createStream(
      { ...slowRun, on_disconnect: "cancel" },
      { signal: disconnected.signal },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    disconnected.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await deps.store.runs.get(started.runId))?.status).toBe("cancelled");
  });

  it("is a no-op when the adapter supplies no signal", async () => {
    // An adapter that cannot observe disconnects omits `signal`; `cancel` then behaves as `continue`
    // rather than throwing on a missing seam.
    const { deps, service } = await harness();

    const { runId } = await service.runs.createWait({
      assistant_id: "echo",
      input: { value: "hi" },
      on_disconnect: "cancel",
    });

    expect((await deps.store.runs.get(runId))?.status).not.toBe("cancelled");
  });
});
